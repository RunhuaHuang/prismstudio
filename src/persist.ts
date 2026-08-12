/**
 * 落盘逻辑（persist）
 *
 * 重写自 Run 的 media-generation-mcp.ts 持久化段（runMediaGeneration 内部循环），
 * 去掉 Run 专属的附件标记（RUN_IMAGE_ATTACHMENT 等）与 saveAttachment / resolveAttachmentPath 依赖，
 * 改为纯 node:fs 写盘，输出路径对所有 MCP agent 通用。
 *
 * 输出策略（与 Run 一致）：
 * - 写入本地文件：<outputDir>/<prefix>-<uuid8>.<ext>
 * - 返回 MCP content 块：image→image 块、audio→audio 块（base64 直传给 LLM）
 *   video 体积大，不放进 content 块，仅靠文本里的本地路径引用
 * - 文本块：纯人类可读摘要 + 本地文件绝对路径（任意 agent 都能引用，无 Run 专属标记）
 */

import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'
import type { GeneratedImageData } from './engine/media-generation-engine.js'

// ===== MCP content 块类型（与 SDK 的 Content 结构对齐） =====

export interface McpTextContent {
  type: 'text'
  text: string
}
export interface McpImageContent {
  type: 'image'
  data: string
  mimeType: string
}
export interface McpAudioContent {
  type: 'audio'
  data: string
  mimeType: string
}
export type McpContent = McpTextContent | McpImageContent | McpAudioContent

export interface PersistedItem {
  /** 本地绝对路径（成功落盘时；失败则为 undefined） */
  localPath?: string
  /** 文件名 */
  filename: string
  /** MIME 类型 */
  mediaType: string
  /** base64 原始数据（用于 image/audio content 块） */
  data?: string
  /** 解码后的媒体字节数 */
  byteLength: number
  /** 是否已作为 MCP image/audio content 内联 */
  inlined: boolean
  /** 写入本地失败时，为避免丢失已生成结果而进行的异常内联回退。 */
  recoveredInline?: boolean
}

// ===== 扩展名 / 前缀 =====

/** 根据生成的媒体类型决定文件扩展名 */
export function extForMediaType(mediaType: string): string {
  const lower = mediaType.toLowerCase()
  if (lower.startsWith('video/')) {
    if (lower.includes('webm')) return '.webm'
    if (lower.includes('quicktime') || lower.includes('mov')) return '.mov'
    if (lower.includes('matroska')) return '.mkv'
    return '.mp4'
  }
  if (lower.startsWith('audio/')) {
    if (lower.includes('wav') || lower.includes('x-wav')) return '.wav'
    if (lower.includes('mpeg') || lower.includes('mp3')) return '.mp3'
    if (lower.includes('m4a') || lower.includes('mp4')) return '.m4a'
    if (lower.includes('ogg')) return '.ogg'
    if (lower.includes('flac')) return '.flac'
    if (lower.includes('aac')) return '.aac'
    if (lower.includes('opus')) return '.opus'
    return '.wav'
  }
  if (lower.startsWith('image/')) {
    if (lower.includes('jpeg') || lower.includes('jpg')) return '.jpg'
    if (lower.includes('png')) return '.png'
    if (lower.includes('webp')) return '.webp'
    if (lower.includes('gif')) return '.gif'
    return '.png'
  }
  return '.bin'
}

/** 根据媒体类型决定文件名前缀 */
export function prefixForMediaType(mediaType: string): string {
  if (mediaType.startsWith('video/')) return 'video-gen'
  if (mediaType.startsWith('audio/')) return 'audio-gen'
  return 'image-gen'
}

/**
 * 清洗用户指定的语义化文件名：去除扩展名、非法路径字符、首尾点横线，
 * 限制长度。仅保留字母数字、连字符、下划线、中文等安全字符。
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.trim().replace(/\.[a-z0-9]+$/i, '')
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '')
  return cleaned.slice(0, 80) || 'output'
}

// ===== 主落盘函数 =====

export interface PersistOptions {
  /** 输出根目录；通常为 outputDir/generated-media */
  outputDir: string
  /** image/audio 内联回传上限；0 表示始终只返回路径，undefined 表示不限制 */
  maxInlineBytes?: number
}

export interface PersistResult {
  items: PersistedItem[]
  /** 生成 MCP content 块数组（image/audio 块 + 文本摘要） */
  content: McpContent[]
  /** 成功落盘的路径列表 */
  savedPaths: string[]
}

/**
 * 把生成产物落盘并构造 MCP content 块。
 *
 * @param generated 引擎返回的生成产物（base64）
 * @param modalityLabel 模态中文名（用于摘要文本，如 "图片"）
 * @param options 落盘选项
 * @param customFilename 可选语义化文件名（不含扩展名，多张自动加序号后缀）
 * @param providerTag 可选厂商/模型标签（用于摘要，如 "Google · Gemini Flash Image"）
 */
export function persistGenerated(
  generated: GeneratedImageData[],
  modalityLabel: string,
  options: PersistOptions,
  customFilename?: string,
  providerTag?: string,
): PersistResult {
  const items: PersistedItem[] = []
  const content: McpContent[] = []
  const savedPaths: string[] = []
  const textParts: string[] = []
  let pathOnlyCount = 0
  let recoveredInlineCount = 0
  const unrecoverablePersistenceFailures: string[] = []

  // 确保输出目录存在
  try {
    mkdirSync(options.outputDir, { recursive: true })
  } catch (err) {
    // 目录已存在或创建失败都不致命，单文件写入失败会在下面捕获
    if (!isAlreadyExistsError(err)) console.warn(`[prismstudio] 创建输出目录失败:`, err)
  }

  const sanitizedCustom = customFilename?.trim() ? sanitizeFilename(customFilename.trim()) : ''

  for (let i = 0; i < generated.length; i++) {
    const item = generated[i]!
    const byteLength = Buffer.byteLength(item.data, 'base64')
    const ext = extForMediaType(item.mediaType)
    const suffix = generated.length > 1 ? `-${i + 1}` : ''
    const requestedFilename = sanitizedCustom
      ? `${sanitizedCustom}${suffix}${ext}`
      : `${prefixForMediaType(item.mediaType)}-${randomUUID().slice(0, 8)}${ext}`

    let filename = requestedFilename
    let localPath: string | undefined
    let persistenceFailed = false
    try {
      const written = writeGeneratedFileExclusively(options.outputDir, requestedFilename, item.data)
      filename = written.filename
      localPath = written.fullPath
      savedPaths.push(written.fullPath)
    } catch (err) {
      persistenceFailed = true
      console.warn(`[prismstudio] 写入文件失败 (${filename})：`, err)
    }

    const isInlineMedia = item.mediaType.startsWith('image/') || item.mediaType.startsWith('audio/')
    // 落盘失败时，图片/音频必须以内联形式返回，即使超过通常的内联上限。
    // 上游调用可能已经产生费用；静默丢弃唯一一份结果比异常情况下的上下文体积更糟。
    const recoveredInline = persistenceFailed && isInlineMedia
    const inlined = isInlineMedia && (recoveredInline || options.maxInlineBytes === undefined || byteLength <= options.maxInlineBytes)
    if (recoveredInline) recoveredInlineCount++
    items.push({
      localPath,
      filename,
      mediaType: item.mediaType,
      // Avoid retaining a second large base64 string for path-only media.
      data: inlined ? item.data : undefined,
      byteLength,
      inlined,
      ...(recoveredInline ? { recoveredInline: true } : {}),
    })

    // image / audio 放进 content 块直接回传给 LLM（体积可控）
    if (inlined && item.mediaType.startsWith('image/')) {
      content.push({ type: 'image', data: item.data, mimeType: item.mediaType })
    } else if (inlined && item.mediaType.startsWith('audio/')) {
      content.push({ type: 'audio', data: item.data, mimeType: item.mediaType })
    } else if (isInlineMedia && localPath) {
      pathOnlyCount++
    }
    if (persistenceFailed && !isInlineMedia) unrecoverablePersistenceFailures.push(filename)
    // video 不放进 content 块（体积过大），仅靠下方文本路径引用

    // 文本里记录本地路径（任意 agent 可读）
    textParts.push(localPath ? `- ${localPath}` : `- ${filename}（写入失败）`)
  }

  // MCP 没有标准 video content 块。若视频无法落盘，就不能把它伪装成成功且只给一个
  // 不存在的路径；抛错至少能让调用方立即获知并重试到一个可写目录。
  if (unrecoverablePersistenceFailures.length > 0) {
    throw new Error(
      `${modalityLabel}已由上游生成，但无法保存以下文件：${unrecoverablePersistenceFailures.join(', ')}。` +
      '请检查输出目录权限、磁盘空间或改用可写目录后重试。',
    )
  }

  const count = generated.length
  const providerSuffix = providerTag ? ` · ${providerTag}` : ''
  const pathInfo = savedPaths.length > 0
    ? `\n${modalityLabel}已保存到本地:\n${textParts.join('\n')}`
    : `\n${modalityLabel}生成完成，但未能保存到本地。`
  const inlineNote = pathOnlyCount > 0 ? `\n其中 ${pathOnlyCount} 个文件超过内联上限，仅返回本地路径。` : ''
  const recoveryNote = recoveredInlineCount > 0
    ? `\n其中 ${recoveredInlineCount} 个文件落盘失败，已紧急以内联数据返回，避免丢失生成结果。`
    : ''
  const summary = count > 0 ? `${modalityLabel}已生成（${count} 个）${providerSuffix}${pathInfo}${inlineNote}${recoveryNote}` : `未生成${modalityLabel}内容${providerSuffix}`
  content.push({ type: 'text', text: summary })

  return { items, content, savedPaths }
}

/**
 * 原子地写入生成物且绝不覆盖已有路径（包括符号链接）。语义化文件名重复时
 * 自动追加 -2/-3…；`wx` 同时消除“先检查再写入”的并发竞态。
 */
function writeGeneratedFileExclusively(
  outputDir: string,
  requestedFilename: string,
  base64Data: string,
): { filename: string; fullPath: string } {
  const dot = requestedFilename.lastIndexOf('.')
  const stem = dot > 0 ? requestedFilename.slice(0, dot) : requestedFilename
  const ext = dot > 0 ? requestedFilename.slice(dot) : ''
  for (let attempt = 1; attempt <= 10_000; attempt++) {
    const filename = attempt === 1 ? requestedFilename : `${stem}-${attempt}${ext}`
    const fullPath = resolve(outputDir, filename)
    let fd: number | undefined
    let createdByThisCall = false
    try {
      fd = openSync(fullPath, 'wx', 0o600)
      createdByThisCall = true
      // Decode bounded chunks so a large provider response does not create a
      // second full-size Buffer during persistence.
      const chunkChars = 1024 * 1024 * 4 // divisible by 4, preserves base64 groups
      for (let offset = 0; offset < base64Data.length; offset += chunkChars) {
        const chunk = Buffer.from(base64Data.slice(offset, offset + chunkChars), 'base64')
        let written = 0
        while (written < chunk.length) written += writeSync(fd, chunk, written, chunk.length - written)
      }
      closeSync(fd)
      fd = undefined
      if (process.platform !== 'win32') chmodSync(fullPath, 0o600)
      return { filename, fullPath }
    } catch (err) {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* ignore cleanup failure */ }
      }
      // EEXIST means another file won the race; never remove that existing
      // file or symlink while choosing the next collision-free name.
      if (isAlreadyExistsError(err)) continue
      // Only remove a partial artifact that this invocation successfully
      // created.  An open failure (for example EACCES/ENOTDIR) may refer to
      // an existing user path; removing it would violate the no-overwrite
      // guarantee and create a race with another writer.
      if (createdByThisCall) {
        try { rmSync(fullPath, { force: true }) } catch { /* ignore cleanup failure */ }
      }
      throw err
    }
  }

  throw new Error(`无法为生成物分配不冲突的文件名: ${requestedFilename}`)
}

function isAlreadyExistsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST'
}
