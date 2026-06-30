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
import type { MediaModality, MediaProtocol } from './engine/media-generation-engine.js'

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

/** 生成物默认输出根目录（outputDir 未配置时回退到配置目录下的 generated-media） */
export function getDefaultOutputDir(): string {
  return join(getConfigDir(), 'generated-media')
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
 * 引擎会根据 presetId / model 自动从 MEDIA_MODEL_PRESETS 反查 protocol/baseUrl 等，
 * 因此 preset 模式下只需提供 presetId + apiKey 即可。
 */
export function toEngineCredentials(mod: ModalityConfig): Record<string, string> {
  const creds: Record<string, string> = {
    presetId: mod.presetId,
    apiKey: mod.apiKey,
  }
  if (mod.model?.trim()) creds.model = mod.model.trim()
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
 * 判断某模态是否"已配置好可用"：enabled + 有 apiKey + 解析后能得到 model。
 * 复用引擎的解析逻辑，避免规则不一致。
 *
 * 注意：presetId 必须是已选定的预设 ID 或 'custom'；空字符串 / 'none'（WebUI 初始态）
 * 表示用户还没选模型，不算就绪。
 */
export function isModalityReady(config: DuoConfig, modality: MediaModality): boolean {
  const mod = getModalityConfig(config, modality)
  if (!mod?.enabled || !mod.apiKey?.trim()) return false
  const presetId = mod.presetId?.trim()
  // 未选择模型（初始态）：presetId 为空 / 'none' / 'custom' 但没填 model
  if (!presetId || presetId === 'none') return false
  if (presetId === 'custom' && !mod.model?.trim()) return false
  return true
}
