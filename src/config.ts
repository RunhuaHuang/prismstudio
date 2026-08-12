/**
 * 配置层（config）
 *
 * 替代 Run 的 builtin-tool-config.ts + config-paths.ts，脱离 ~/.run 与 Electron。
 *
 * - 配置目录：~/.prismstudio/（可用环境变量 PRISMSTUDIO_CONFIG 指定任意 config.json 路径覆盖）
 * - 配置文件：config.json（明文 JSON，与 MCP 生态惯例一致）
 * - WebUI 写 / MCP 读，共享同一文件
 *
 * 引擎的 resolveMediaConfig / resolveEffectiveMediaCredentials 期望一个扁平的
 * Record<string, string>（字段：apiKey / model / presetId / baseUrl / protocol / audioTask）。
 * 本模块负责把结构化的 ModalityConfig 转换成引擎能直接消费的 flat credentials。
 */

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  isMediaProtocol,
  resolveMediaConfig,
  resolveEffectiveMediaCredentials,
  MEDIA_MODEL_PRESETS,
  type MediaModality,
  type MediaProtocol,
} from './engine/media-generation-engine.js'

// ===== 配置结构 =====

export type { MediaModality, MediaProtocol }

/** 单个模态的配置（image / video / audio 各一份） */
export interface ModalityConfig {
  /** 是否启用该模态（未启用的模态不会向 MCP 暴露对应工具） */
  enabled: boolean
  /** 预设 ID（对应引擎 MEDIA_MODEL_PRESETS 里的 id，或 'custom'） */
  presetId: string
  /** API Key（必填，调用 provider 用） */
  apiKey: string
  /** 可选：从环境变量读取 API Key；明文 apiKey 非空时优先使用明文值 */
  apiKeyEnv?: string
  /** 可选：覆盖预设里的模型名 */
  model?: string
  /** 可选：覆盖预设里的 baseUrl */
  baseUrl?: string
  /** 可选：覆盖预设协议族；custom 模式下作为所选协议 */
  protocol?: MediaProtocol
  /** 可选：音频子任务（仅 audio 模态） */
  audioTask?: 'tts' | 'music' | 'clone'
  /**
   * 各厂商（vendor）单独记忆的 API Key。WebUI 在同一模态内切换同 vendor 的模型时
   * 复用同一个 key；image/video/audio 三个模态各自独立，不跨模态共享。
   */
  apiKeyByVendor?: Record<string, string>
  /**
   * 历史兼容字段：旧版本按 presetId 单独记忆 API Key。新版本仍会读写该字段，
   * 以便从旧配置迁移，并兼容依赖该字段的旧逻辑。
   */
  apiKeyByPreset?: Record<string, string>
}

export interface GenerationPolicyConfig {
  /** 单次最多生成数量，覆盖图片/视频，默认 4 */
  maxOutputs?: number
  /** 单次视频最长秒数，默认 15 */
  maxVideoDurationSec?: number
  /** 是否允许请求 4K，默认 true */
  allow4k?: boolean
  /** 图片/音频允许内联回传的最大 MiB，默认 8；0 表示始终只返回路径 */
  maxInlineMiB?: number
  /** 单次参考素材读取总量上限（MiB），默认 128 */
  maxInputMiB?: number
  /** 允许作为参考素材读取的额外本地目录；输出根目录始终自动允许 */
  allowedInputDirs?: string[]
}

export interface DiagnosticsConfig {
  /** 是否记录不含 prompt / 密钥 /文件路径的 JSONL 诊断事件 */
  enabled?: boolean
  /** 可选诊断日志路径；默认 ~/.prismstudio/diagnostics.jsonl */
  logFile?: string
}

export interface DuoConfig {
  image?: ModalityConfig
  video?: ModalityConfig
  audio?: ModalityConfig
  /** 生成物输出根目录；缺省时落到 ~/prismstudio，实际产物位于其 generated-media 子目录 */
  outputDir?: string
  /** WebUI 端口（仅 --webui 模式读取） */
  webuiPort?: number
  /** 生成成本与资源保护策略 */
  policy?: GenerationPolicyConfig
  /** 脱敏诊断日志配置 */
  diagnostics?: DiagnosticsConfig
}

export interface ResolvedGenerationPolicy {
  maxOutputs: number
  maxVideoDurationSec: number
  allow4k: boolean
  maxInlineBytes: number
  maxInputBytes: number
  allowedInputDirs: string[]
}

export const DEFAULT_GENERATION_POLICY: ResolvedGenerationPolicy = {
  maxOutputs: 4,
  maxVideoDurationSec: 15,
  allow4k: true,
  maxInlineBytes: 8 * 1024 * 1024,
  maxInputBytes: 128 * 1024 * 1024,
  allowedInputDirs: [],
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '[::1]'
    || normalized === '::1'
}

/** 统一校验 provider Base URL，避免无 scheme/非 HTTP(S) 或明文远端地址进入 LIVE 状态。 */
export function isValidHttpBaseUrl(value: string | undefined): boolean {
  if (!value?.trim()) return false
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    if (!url.hostname || url.username || url.password || url.search || url.hash) return false
    // 允许本机调试代理使用 HTTP；远端 provider 必须通过 HTTPS 传输凭证。
    if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) return false
    return true
  } catch {
    return false
  }
}

// ===== 路径解析 =====

const DEFAULT_CONFIG_DIR = join(homedir(), '.prismstudio')
const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, 'config.json')

/**
 * 配置文件路径。优先级：
 * 1. 环境变量 PRISMSTUDIO_CONFIG（指定任意 config.json 绝对路径）
 * 2. 默认 ~/.prismstudio/config.json
 */
export function getConfigPath(): string {
  const fromEnv = process.env.PRISMSTUDIO_CONFIG?.trim()
  return fromEnv ? resolve(fromEnv) : DEFAULT_CONFIG_PATH
}

/** 配置目录（config.json 所在目录） */
export function getConfigDir(): string {
  return dirname(getConfigPath())
}

/**
 * 生成物默认输出「根目录」（outputDir 未配置时的回退值）。
 *
 * 刻意与配置目录（~/.prismstudio，隐藏、存放 config.json 等含密钥文件）分离：
 * 生成物（图/视频/音频）落到非隐藏的 ~/prismstudio，方便用户在 Finder 里直接查看。
 * 不含 generated-media 子目录——子目录由 runGeneration 的
 * resolve(ctx.outputDir, 'generated-media') 统一拼接，
 * 避免出现 generated-media/generated-media 双层目录。
 */
export function getDefaultOutputDir(): string {
  return join(homedir(), 'prismstudio')
}

// ===== 读写 =====

const EMPTY_CONFIG: DuoConfig = {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 配置 map 只接受普通业务键，避免把 JSON 中的特殊键写入对象原型。 */
export function isSafeConfigMapKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

function normalizeStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => (
    isSafeConfigMapKey(entry[0]) && typeof entry[1] === 'string'
  ))
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function normalizeModalityConfig(value: unknown): ModalityConfig | undefined {
  if (!isRecord(value)) return undefined
  const audioTask = value.audioTask === 'tts' || value.audioTask === 'music' || value.audioTask === 'clone'
    ? value.audioTask
    : undefined
  const normalized: ModalityConfig = {
    enabled: value.enabled === true,
    presetId: optionalString(value.presetId) ?? '',
    apiKey: optionalString(value.apiKey) ?? '',
  }
  const model = optionalString(value.model)
  const baseUrl = optionalString(value.baseUrl)
  const protocol = optionalString(value.protocol)
  const apiKeyEnv = optionalString(value.apiKeyEnv)
  const apiKeyByVendor = normalizeStringMap(value.apiKeyByVendor)
  const apiKeyByPreset = normalizeStringMap(value.apiKeyByPreset)
  if (model !== undefined) normalized.model = model
  if (baseUrl !== undefined) normalized.baseUrl = baseUrl
  if (isMediaProtocol(protocol)) normalized.protocol = protocol
  else if (protocol?.trim()) normalized.enabled = false
  if (apiKeyEnv !== undefined && (!apiKeyEnv.trim() || /^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv.trim()))) {
    normalized.apiKeyEnv = apiKeyEnv.trim()
  }
  if (audioTask !== undefined) normalized.audioTask = audioTask
  if (apiKeyByVendor !== undefined) normalized.apiKeyByVendor = apiKeyByVendor
  if (apiKeyByPreset !== undefined) normalized.apiKeyByPreset = apiKeyByPreset
  return normalized
}

/**
 * 把磁盘上的不可信 JSON 收敛为运行时可安全消费的配置。
 * 手工编辑、旧版本或局部损坏产生的错误字段会被忽略，避免 `.trim()` 等调用导致进程崩溃。
 */
export function normalizeConfig(value: unknown): DuoConfig {
  if (!isRecord(value)) return { ...EMPTY_CONFIG }
  const normalized: DuoConfig = {}
  for (const modality of ['image', 'video', 'audio'] as const) {
    const mod = normalizeModalityConfig(value[modality])
    if (mod) normalized[modality] = mod
  }
  const outputDir = optionalString(value.outputDir)
  if (outputDir?.trim()) normalized.outputDir = outputDir
  if (Number.isInteger(value.webuiPort) && Number(value.webuiPort) > 0 && Number(value.webuiPort) < 65_536) {
    normalized.webuiPort = Number(value.webuiPort)
  }
  if (isRecord(value.policy)) {
    const policy: GenerationPolicyConfig = {}
    if (Number.isFinite(value.policy.maxOutputs)) policy.maxOutputs = Math.floor(clampFinite(Number(value.policy.maxOutputs), 4, 1, 4))
    if (Number.isFinite(value.policy.maxVideoDurationSec)) policy.maxVideoDurationSec = Math.floor(clampFinite(Number(value.policy.maxVideoDurationSec), 15, 1, 600))
    if (typeof value.policy.allow4k === 'boolean') policy.allow4k = value.policy.allow4k
    if (Number.isFinite(value.policy.maxInlineMiB)) policy.maxInlineMiB = clampFinite(Number(value.policy.maxInlineMiB), 8, 0, 256)
    if (Number.isFinite(value.policy.maxInputMiB)) policy.maxInputMiB = Math.floor(clampFinite(Number(value.policy.maxInputMiB), 128, 1, 2048))
    if (Array.isArray(value.policy.allowedInputDirs)) {
      policy.allowedInputDirs = value.policy.allowedInputDirs.filter((item): item is string => (
        typeof item === 'string' && !!item.trim() && isAbsolute(item.trim())
      ))
    }
    normalized.policy = policy
  }
  if (isRecord(value.diagnostics)) {
    const diagnostics: DiagnosticsConfig = {}
    if (typeof value.diagnostics.enabled === 'boolean') diagnostics.enabled = value.diagnostics.enabled
    const logFile = optionalString(value.diagnostics.logFile)
    if (logFile?.trim()) diagnostics.logFile = logFile
    normalized.diagnostics = diagnostics
  }
  return normalized
}

function clampFinite(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Number(value)))
}

/** 解析带安全默认值的运行策略，所有入口统一使用。 */
export function resolveGenerationPolicy(config: DuoConfig): ResolvedGenerationPolicy {
  const policy = config.policy
  return {
    maxOutputs: Math.floor(clampFinite(policy?.maxOutputs, DEFAULT_GENERATION_POLICY.maxOutputs, 1, 4)),
    maxVideoDurationSec: Math.floor(clampFinite(policy?.maxVideoDurationSec, DEFAULT_GENERATION_POLICY.maxVideoDurationSec, 1, 600)),
    allow4k: policy?.allow4k ?? DEFAULT_GENERATION_POLICY.allow4k,
    maxInlineBytes: Math.floor(clampFinite(policy?.maxInlineMiB, DEFAULT_GENERATION_POLICY.maxInlineBytes / 1024 / 1024, 0, 256) * 1024 * 1024),
    maxInputBytes: Math.floor(clampFinite(policy?.maxInputMiB, DEFAULT_GENERATION_POLICY.maxInputBytes / 1024 / 1024, 1, 2048) * 1024 * 1024),
    allowedInputDirs: [...new Set((policy?.allowedInputDirs ?? [])
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((item) => resolve(item)))],
  }
}

/** 明文 key 优先；为空时按 apiKeyEnv 从当前进程环境读取。 */
export function resolveModalityApiKey(mod: ModalityConfig | undefined): string {
  const inline = typeof mod?.apiKey === 'string' ? mod.apiKey.trim() : ''
  if (inline) return inline
  const envName = typeof mod?.apiKeyEnv === 'string' ? mod.apiKeyEnv.trim() : ''
  if (!envName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) return ''
  return process.env[envName]?.trim() ?? ''
}

/** 收集配置中可能出现在上游错误响应里的凭据片段，供错误消息脱敏。 */
export function collectConfigSecrets(config: DuoConfig): string[] {
  const secrets = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed.length < 4) return
    secrets.add(trimmed)
    // 可灵等渠道允许 AccessKey:SecretKey，代理错误有时只回显其中一段。
    if (!trimmed.startsWith('{')) {
      for (const part of trimmed.split(':')) {
        if (part.length >= 8) secrets.add(part)
      }
    }
    // 服务账号 JSON 若被解析/转发，错误体更可能只包含私钥等单字段。
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      for (const field of ['private_key', 'private_key_id', 'client_secret', 'refresh_token', 'access_token', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'api_key', 'apiKey']) {
        const nested = parsed?.[field]
        if (typeof nested === 'string' && nested.length >= 4) secrets.add(nested)
      }
    } catch { /* ordinary API key */ }
  }

  for (const modality of ['image', 'video', 'audio'] as const) {
    const mod = config[modality]
    if (!mod) continue
    add(mod.apiKey)
    add(resolveModalityApiKey(mod))
    Object.values(mod.apiKeyByVendor ?? {}).forEach(add)
    Object.values(mod.apiKeyByPreset ?? {}).forEach(add)
  }
  return [...secrets].sort((a, b) => b.length - a.length)
}

/**
 * 脱敏准备返回给 agent / WebUI 的错误文本。先替换已知真实凭据，再兜底清理常见认证头和 key 字段。
 */
export function redactSensitiveText(text: string, secrets: Iterable<string> = []): string {
  let redacted = text
  for (const secret of secrets) {
    if (secret.length >= 4) redacted = redacted.split(secret).join('[REDACTED]')
  }
  return redacted
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|api_key|token|access_token|signature|x-goog-signature|x-amz-signature|x-amz-credential)=)[^&#\s]+/gi, '$1[REDACTED]')
}

/** 读取配置（文件不存在时返回空对象，不抛错） */
export function loadConfig(): DuoConfig {
  const path = getConfigPath()
  if (!existsSync(path)) return { ...EMPTY_CONFIG }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    return normalizeConfig(parsed)
  } catch (err) {
    console.error(`[prismstudio] 配置文件解析失败 (${path})：`, err)
    return { ...EMPTY_CONFIG }
  }
}

interface ConfigFileReplaceOps {
  platform: NodeJS.Platform
  rename(from: string, to: string): void
  remove(path: string): void
  warn(message: string, error: unknown): void
}

/**
 * 用临时文件替换配置。Windows 无法覆盖 rename 时，先把旧文件移动到恢复备份，
 * 并在第二次 rename 失败时恢复它，绝不 delete-then-rename。
 */
export function replaceConfigFileAtomically(
  tempPath: string,
  path: string,
  backupPath: string,
  ops: ConfigFileReplaceOps = {
    platform: process.platform,
    rename: renameSync,
    remove: (target) => rmSync(target, { force: true }),
    warn: (message, error) => console.warn(message, error),
  },
): void {
  try {
    ops.rename(tempPath, path)
    return
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined
    if (ops.platform !== 'win32' || (code !== 'EEXIST' && code !== 'EPERM')) throw err
  }

  // Keep the previous configuration recoverable until the new one is in place.
  ops.rename(path, backupPath)
  try {
    ops.rename(tempPath, path)
  } catch (replaceErr) {
    try {
      ops.rename(backupPath, path)
    } catch (restoreErr) {
      const restoreMessage = restoreErr instanceof Error ? restoreErr.message : String(restoreErr)
      throw new Error(
        `Windows 配置替换失败；原配置已保留在恢复文件 ${backupPath}。请在关闭占用进程后手动恢复。${restoreMessage ? ` 恢复错误: ${restoreMessage}` : ''}`,
      )
    }
    throw replaceErr
  }

  try {
    ops.remove(backupPath)
  } catch (cleanupErr) {
    // The new configuration is already safely saved; retain the backup rather
    // than turning a successful save into a failure just to remove it.
    ops.warn(`[prismstudio] 配置恢复备份未能清理，已保留在 ${backupPath}:`, cleanupErr)
  }
}

/** 保存配置（自动创建目录） */
export function saveConfig(config: DuoConfig): void {
  const path = getConfigPath()
  const tempPath = join(dirname(path), `.${randomUUID()}.config.tmp`)
  const backupPath = join(dirname(path), `.${randomUUID()}.config.bak`)
  let fd: number | undefined
  try {
    mkdirSync(dirname(path), { recursive: true })
    // 同目录临时文件 + fsync + rename：进程异常退出时旧配置仍完整，不会留下半截 JSON。
    fd = openSync(tempPath, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(normalizeConfig(config), null, 2) + '\n', 'utf-8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    replaceConfigFileAtomically(tempPath, path, backupPath)
    // rename 后再次收紧，兼容历史宽权限文件与不同平台的 umask 行为。
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore cleanup failure */ }
    }
    try { rmSync(tempPath, { force: true }) } catch { /* ignore cleanup failure */ }
    console.error(`[prismstudio] 配置文件写入失败 (${path})：`, err)
    throw err
  }
}

// ===== 与引擎的桥接：ModalityConfig → flat credentials =====

/**
 * 把结构化的 ModalityConfig 转成引擎 resolveMediaConfig 所需的扁平 credentials。
 *
 * 注意：引擎 resolveMediaConfig 要求 credentials.model 非空（否则直接返回 null）。
 * preset 模式下用户通常不单独填 model（依赖 preset 自带），故这里对 preset 模式
 * 从 MEDIA_MODEL_PRESETS 反查 model 填进 credentials，让引擎能正确解析。
 * custom 模式则要求 mod.model 已填（isModalityReady 会校验）。
 */
export function toEngineCredentials(mod: ModalityConfig, apiKeyOverride?: string): Record<string, string> {
  const creds: Record<string, string> = {
    presetId: mod.presetId,
    apiKey: apiKeyOverride ?? resolveModalityApiKey(mod),
  }
  if (mod.model?.trim()) {
    creds.model = mod.model.trim()
  } else if (mod.presetId && mod.presetId !== 'custom') {
    // preset 模式且未覆盖 model：从预设反查，满足引擎对 model 非空的要求
    const preset = MEDIA_MODEL_PRESETS.find((p) => p.id === mod.presetId)
    if (preset) creds.model = preset.model
  }
  if (mod.baseUrl?.trim()) creds.baseUrl = mod.baseUrl.trim()
  if (mod.protocol) creds.protocol = mod.protocol
  if (mod.audioTask) creds.audioTask = mod.audioTask
  return creds
}

/** 获取某模态的有效配置（不存在时返回 undefined） */
export function getModalityConfig(config: DuoConfig, modality: MediaModality): ModalityConfig | undefined {
  return config[modality]
}

/**
 * 判断某模态是否"已配置好可用"——与运行时真实判定（resolveModality）一致。
 * 复用引擎的 resolveMediaConfig 做严格校验，确保"显示就绪"="真能跑"，
 * 消除 presetId 命不中 / custom 缺 baseUrl 时"显示就绪但调用必抛"的偏差。
 */
export function isModalityReady(config: DuoConfig, modality: MediaModality): boolean {
  const mod = getModalityConfig(config, modality)
  const apiKey = resolveModalityApiKey(mod)
  if (!mod?.enabled || !apiKey) return false
  const presetId = mod.presetId?.trim()
  // 未选择模型（初始态）：presetId 为空 / 'none'
  if (!presetId || presetId === 'none') return false
  // 严格校验：复用引擎解析，能解析出 baseUrl 才算就绪
  const credentials = resolveEffectiveMediaCredentials(toEngineCredentials(mod, apiKey), modality)
  const resolved = resolveMediaConfig(credentials, modality)
  return !!resolved && isValidHttpBaseUrl(resolved.baseUrl)
}
