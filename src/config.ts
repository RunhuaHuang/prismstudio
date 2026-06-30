/**
 * 配置层（config）
 *
 * 替代 Run 的 builtin-tool-config.ts + config-paths.ts，脱离 ~/.run 与 Electron。
 *
 * - 配置目录：~/.duo-mcp/（可用环境变量 DUO_MCP_CONFIG 指定任意 config.json 路径覆盖）
 * - 配置文件：config.json（明文 JSON，与 MCP 生态惯例一致）
 * - WebUI 写 / MCP 读，共享同一文件
 *
 * 引擎的 resolveMediaConfig / resolveEffectiveMediaCredentials 期望一个扁平的
 * Record<string, string>（字段：apiKey / model / presetId / baseUrl / protocol / audioTask）。
 * 本模块负责把结构化的 ModalityConfig 转换成引擎能直接消费的 flat credentials。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
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
  /** 可选：覆盖预设里的模型名 */
  model?: string
  /** 可选：覆盖预设里的 baseUrl */
  baseUrl?: string
  /** 可选：自定义协议族（仅 presetId='custom' 时有意义） */
  protocol?: MediaProtocol
  /** 可选：音频子任务（仅 audio 模态） */
  audioTask?: 'tts' | 'music' | 'clone'
  /**
   * 各渠道（presetId）单独记忆的 API Key。切换 preset 时 WebUI 据此保存/恢复，
   * 让用户在不同厂商间切换无需重填 key。key 为 presetId，value 为该渠道的 apiKey。
   */
  apiKeyByPreset?: Record<string, string>
}

export interface DuoConfig {
  image?: ModalityConfig
  video?: ModalityConfig
  audio?: ModalityConfig
  /** 生成物默认输出目录；缺省时落到 <cwd>/generated-media */
  outputDir?: string
  /** WebUI 端口（仅 --webui 模式读取） */
  webuiPort?: number
}

// ===== 路径解析 =====

const DEFAULT_CONFIG_DIR = join(homedir(), '.duo-mcp')
const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, 'config.json')

/**
 * 配置文件路径。优先级：
 * 1. 环境变量 DUO_MCP_CONFIG（指定任意 config.json 绝对路径）
 * 2. 默认 ~/.duo-mcp/config.json
 */
export function getConfigPath(): string {
  const fromEnv = process.env.DUO_MCP_CONFIG?.trim()
  return fromEnv || DEFAULT_CONFIG_PATH
}

/** 配置目录（config.json 所在目录） */
export function getConfigDir(): string {
  return dirname(getConfigPath())
}

/**
 * 生成物默认输出「根目录」（outputDir 未配置时的回退值）。
 * 注意：返回的是配置目录本身，不含 generated-media 子目录——子目录由
 * runGeneration 的 resolve(ctx.outputDir, 'generated-media') 统一拼接，
 * 避免出现 generated-media/generated-media 双层目录。
 */
export function getDefaultOutputDir(): string {
  return getConfigDir()
}

// ===== 读写 =====

const EMPTY_CONFIG: DuoConfig = {}

/** 读取配置（文件不存在时返回空对象，不抛错） */
export function loadConfig(): DuoConfig {
  const path = getConfigPath()
  if (!existsSync(path)) return { ...EMPTY_CONFIG }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...EMPTY_CONFIG }
    return parsed as DuoConfig
  } catch (err) {
    console.error(`[duo-mcp] 配置文件解析失败 (${path})：`, err)
    return { ...EMPTY_CONFIG }
  }
}

/** 保存配置（自动创建目录） */
export function saveConfig(config: DuoConfig): void {
  const path = getConfigPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  } catch (err) {
    console.error(`[duo-mcp] 配置文件写入失败 (${path})：`, err)
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
export function toEngineCredentials(mod: ModalityConfig): Record<string, string> {
  const creds: Record<string, string> = {
    presetId: mod.presetId,
    apiKey: mod.apiKey,
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
  if (!mod?.enabled || !mod.apiKey?.trim()) return false
  const presetId = mod.presetId?.trim()
  // 未选择模型（初始态）：presetId 为空 / 'none'
  if (!presetId || presetId === 'none') return false
  // 严格校验：复用引擎解析，能解析出 baseUrl 才算就绪
  const credentials = resolveEffectiveMediaCredentials(toEngineCredentials(mod), modality)
  const resolved = resolveMediaConfig(credentials, modality)
  return !!resolved && resolved.baseUrl.trim().length > 0
}
