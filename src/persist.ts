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
import { mkdirSync, writeFileSync } from 'node:fs'
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
  data: string
}

// ===== 扩展名 / 前缀 =====

/** 根据生成的媒体类型决定文件扩展名 */
export function extForMediaType(mediaType: string): string {
  const lower = mediaType.toLowerCase()
  if (lower.startsWith('video/')) {
    if (lower.includes('webm')) return '.webm'
    if (lower.includes('quicktime') || lower.includes('mov')) return '.mov'
    return '.mp4'
  }
  if (lower.startsWith('audio/')) {
    if (lower.includes('wav') || lower.includes('x-wav')) return '.wav'
    if (lower.includes('mpeg') || lower.includes('mp3')) return '.mp3'
    if (lower.includes('m4a') || lower.includes('mp4')) return '.m4a'
    if (lower.includes('ogg')) return '.ogg'
    if (lower.includes('flac')) return '.flac'
    if (lower.includes('aac')) return '.aac'
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
    const ext = extForMediaType(item.mediaType)
    const suffix = generated.length > 1 ? `-${i + 1}` : ''
    const requestedFilename = sanitizedCustom
      ? `${sanitizedCustom}${suffix}${ext}`
      : `${prefixForMediaType(item.mediaType)}-${randomUUID().slice(0, 8)}${ext}`

    let filename = requestedFilename
    let localPath: string | undefined
    try {
      const written = writeGeneratedFileExclusively(options.outputDir, requestedFilename, item.data)
      filename = written.filename
      localPath = written.fullPath
      savedPaths.push(written.fullPath)
    } catch (err) {
      console.warn(`[prismstudio] 写入文件失败 (${filename})：`, err)
    }

    items.push({ localPath, filename, mediaType: item.mediaType, data: item.data })

    // image / audio 放进 content 块直接回传给 LLM（体积可控）
    if (item.mediaType.startsWith('image/')) {
      content.push({ type: 'image', data: item.data, mimeType: item.mediaType })
    } else if (item.mediaType.startsWith('audio/')) {
      content.push({ type: 'audio', data: item.data, mimeType: item.mediaType })
    }
    // video 不放进 content 块（体积过大），仅靠下方文本路径引用

    // 文本里记录本地路径（任意 agent 可读）
    textParts.push(localPath ? `- ${localPath}` : `- ${filename}（写入失败）`)
  }

  const count = generated.length
  const providerSuffix = providerTag ? ` · ${providerTag}` : ''
  const pathInfo = savedPaths.length > 0
    ? `\n${modalityLabel}已保存到本地:\n${textParts.join('\n')}`
    : `\n${modalityLabel}生成完成，但未能保存到本地。`
  const summary = count > 0 ? `${modalityLabel}已生成（${count} 个）${providerSuffix}${pathInfo}` : `未生成${modalityLabel}内容${providerSuffix}`
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
  const data = Buffer.from(base64Data, 'base64')

  for (let attempt = 1; attempt <= 10_000; attempt++) {
    const filename = attempt === 1 ? requestedFilename : `${stem}-${attempt}${ext}`
    const fullPath = resolve(outputDir, filename)
    try {
      writeFileSync(fullPath, data, { flag: 'wx' })
      return { filename, fullPath }
    } catch (err) {
      if (isAlreadyExistsError(err)) continue
      throw err
    }
  }

  throw new Error(`无法为生成物分配不冲突的文件名: ${requestedFilename}`)
}

function isAlreadyExistsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST'
}
