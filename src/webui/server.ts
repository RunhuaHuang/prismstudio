/**
 * WebUI HTTP Server（webui/server）
 *
 * 仅绑定 127.0.0.1（不暴露到局域网，保护明文 API Key）。
 *
 * 路由：
 *   GET  /                  返回内嵌的 index.html（Alpine.js 单文件页面）
 *   GET  /assets/alpine.min.js  从本地依赖加载 Alpine.js（不访问第三方 CDN）
 *   GET  /api/config        读取当前配置（apiKey 脱敏）
 *   PUT  /api/config        保存配置（WebUI 表单 → config.json）
 *   GET  /api/presets       返回全部 MEDIA_MODEL_PRESETS（供下拉选择）
 *   GET  /api/status        返回各模态就绪状态
 *   POST /api/test          试用台：调用 generateMedia，返回 base64 或落盘路径
 *   GET  /api/export        按目标 agent 生成 mcpServers JSON 片段
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isAbsolute, relative, resolve } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { WEBUI_HTML } from './index-html.js'
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  getDefaultOutputDir,
  getModalityConfig,
  isModalityReady,
  toEngineCredentials,
  collectConfigSecrets,
  redactSensitiveText,
  resolveGenerationPolicy,
  resolveModalityApiKey,
  normalizeConfig,
  isSafeConfigMapKey,
  isValidHttpBaseUrl,
  type DuoConfig,
  type MediaProtocol,
  type ModalityConfig,
} from '../config.js'
import {
  MEDIA_MODEL_PRESETS,
  hasRegisteredMediaAdapter,
  isMediaProtocol,
  getPresetsByModality,
  generateMedia,
  selectGeneratedImagesForImageRequest,
  resolveMediaConfig,
  resolveEffectiveMediaCredentials,
  type MediaModality,
  type MediaModelPreset,
} from '../engine/media-generation-engine.js'
import { persistGenerated } from '../persist.js'
import { writeGenerationDiagnostic, getDiagnosticsPath } from '../diagnostics.js'
import { enforceGenerationPolicy } from '../policy.js'

// ===== 工具函数 =====

const require = createRequire(import.meta.url)
let alpineScriptCache: string | null = null

/** 固定资源 URL 必须允许重新验证，避免升级后继续使用旧版 Alpine.js。 */
export const STATIC_ASSET_CACHE_CONTROL = 'no-cache'

/** 统一解析 API 请求路径，路由只按完整 pathname 匹配，查询参数单独读取。 */
export function parseApiRequestUrl(url: string): URL | null {
  try {
    return new URL(url, 'http://localhost')
  } catch {
    return null
  }
}

const HTML_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

export interface TestRequestBody {
  modality: MediaModality
  prompt: string
  /** 临时覆盖的 apiKey（不修改 config.json，仅本次试用） */
  apiKey?: string
  /** 页面当前填写的环境变量名，用于自动保存完成前立即试用。 */
  apiKeyEnv?: string
  /** 临时覆盖的 presetId（不修改 config.json） */
  presetId?: string
  /** 当前页面中的模型/协议/Base URL，避免自动保存 debounce 期间试用旧配置 */
  model?: string
  protocol?: MediaProtocol | ''
  baseUrl?: string
  size?: string
  numberOfImages?: number
  numberOfVideos?: number
  duration?: number
  voice?: string
  task?: 'tts' | 'music' | 'clone'
  referencePaths?: string[]
  /** 试用产物落盘根目录（留空走默认 playground） */
  outputDir?: string
}

function diagnosticSecretsForTestBody(body: TestRequestBody, effectiveApiKey?: string, prompt?: string): string[] {
  const values: string[] = []
  for (const value of [body.apiKey, effectiveApiKey, prompt, body.voice]) {
    if (typeof value === 'string' && value.trim().length >= 4) values.push(value)
  }
  if (body.apiKeyEnv?.trim() && /^[A-Za-z_][A-Za-z0-9_]*$/.test(body.apiKeyEnv.trim())) {
    const envValue = process.env[body.apiKeyEnv.trim()]
    if (envValue?.trim()) values.push(envValue)
  }
  return values
}

/** 读取请求体（JSON） */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveReq, reject) => {
    const maxBytes = 5 * 1024 * 1024
    const contentLength = Number(req.headers['content-length'])
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      reject(new Error('请求体过大（>5MB）'))
      req.destroy()
      return
    }
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false
    req.on('data', (c: Buffer) => {
      if (settled) return
      chunks.push(c)
      totalBytes += c.length
      if (totalBytes > maxBytes) {
        settled = true
        reject(new Error('请求体过大（>5MB）'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (settled) return
      try {
        const raw = Buffer.concat(chunks).toString('utf-8')
        resolveReq(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/** 发送 JSON 响应 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  setCommonSecurityHeaders(res)
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 发送纯文本/脚本响应 */
function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  setCommonSecurityHeaders(res)
  res.setHeader('Cache-Control', STATIC_ASSET_CACHE_CONTROL)
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function setCommonSecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
}

function setHtmlSecurityHeaders(res: ServerResponse): void {
  setCommonSecurityHeaders(res)
  res.setHeader('Content-Security-Policy', HTML_CSP)
  res.setHeader('Cache-Control', 'no-store')
}

function loadAlpineScript(): string {
  if (!alpineScriptCache) {
    alpineScriptCache = readFileSync(require.resolve('alpinejs/dist/cdn.min.js'), 'utf-8')
  }
  return alpineScriptCache
}

interface ApiRequestMeta {
  method: string
  host?: string
  origin?: string
  secFetchSite?: string
  contentType?: string
}

function stripPort(authority: string): string {
  return authority.replace(/^\[/, '').replace(/\]$/, '').split(':')[0]?.toLowerCase() ?? ''
}

function getPort(authority: string): string {
  const parts = authority.replace(/^\[/, '').replace(/\]$/, '').split(':')
  return parts.length > 1 ? parts.at(-1)! : ''
}

export function isLoopbackAuthority(authority: string | undefined): boolean {
  if (!authority) return false
  const host = stripPort(authority)
  return host === '127.0.0.1' || host === 'localhost'
}

/** 根据配置中的输出根目录计算 MCP 生成物的实际落盘目录。 */
export function resolveGeneratedMediaDir(root: string): string {
  return resolve(root, 'generated-media')
}

/**
 * 校验本地 WebUI API 请求，降低浏览器中其它网页触发本地副作用请求的风险。
 * - Host 必须是 loopback
 * - 有 Origin 时必须同为 loopback 且端口一致
 * - 有 Sec-Fetch-Site 时必须是同源/直接导航
 * - 写操作必须是 JSON
 */
export function validateLocalApiRequest(meta: ApiRequestMeta): string | null {
  if (!isLoopbackAuthority(meta.host)) return 'Host 必须是 127.0.0.1 或 localhost'

  if (meta.origin) {
    try {
      const originUrl = new URL(meta.origin)
      const hostPort = getPort(meta.host!)
      const originPort = originUrl.port || (originUrl.protocol === 'https:' ? '443' : '80')
      if (!isLoopbackAuthority(originUrl.host) || originPort !== hostPort) {
        return 'Origin 与 WebUI 本地地址不匹配'
      }
    } catch {
      return 'Origin 无效'
    }
  }

  if (meta.secFetchSite && !['same-origin', 'none'].includes(meta.secFetchSite)) {
    return '拒绝跨站 API 请求'
  }

  const method = meta.method.toUpperCase()
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const mediaType = meta.contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
    if (mediaType !== 'application/json' && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/i.test(mediaType)) {
      return '写入类 API 请求必须使用 application/json'
    }
  }

  return null
}

function validateIncomingApiRequest(req: IncomingMessage, method: string): string | null {
  const header = (name: string) => {
    const value = req.headers[name.toLowerCase()]
    return Array.isArray(value) ? value[0] : value
  }
  return validateLocalApiRequest({
    method,
    host: header('host'),
    origin: header('origin'),
    secFetchSite: header('sec-fetch-site'),
    contentType: header('content-type'),
  })
}

/** 对配置做脱敏（隐藏 apiKey 中间部分）。非字符串（坏数据）不抛错，返回空。 */
export function maskApiKey(key: string): string {
  // 类型守卫：坏数据（如数字）落盘后若没有守卫，GET /api/config 会永久 500。
  if (typeof key !== 'string' || !key) return ''
  try {
    const parsed = JSON.parse(key)
    if (parsed && typeof parsed === 'object') {
      const type = parsed.type || 'service_account'
      const projectId = parsed.project_id || parsed.quota_project_id || 'unknown-project'
      return `JSON:${type}:${projectId}·****`
    }
  } catch {}
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '****' + key.slice(-4)
}

/** 配置脱敏后返回给前端（避免把完整 key 明文回传给浏览器）。
 *  顶层 apiKey、apiKeyByVendor 与 apiKeyByPreset map 内的 key 都脱敏。 */
function sanitizeConfig(config: DuoConfig): DuoConfig {
  const out: DuoConfig = { ...config }
  for (const m of ['image', 'video', 'audio'] as const) {
    const mod = config[m]
    if (mod) {
      const masked: ModalityConfig = { ...mod, apiKey: maskApiKey(mod.apiKey) }
      if (mod.apiKeyByVendor) {
        masked.apiKeyByVendor = Object.fromEntries(
          Object.entries(mod.apiKeyByVendor).map(([vendor, k]) => [vendor, maskApiKey(k)]),
        )
      }
      if (mod.apiKeyByPreset) {
        masked.apiKeyByPreset = Object.fromEntries(
          Object.entries(mod.apiKeyByPreset).map(([pid, k]) => [pid, maskApiKey(k)]),
        )
      }
      out[m] = masked
    }
  }
  return out
}

// ===== 路由处理 =====

async function handleApi(
  method: string,
  url: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const parsedUrl = parseApiRequestUrl(url)
  if (!parsedUrl) return false
  const pathname = parsedUrl.pathname

  // GET /api/config
  if (method === 'GET' && pathname === '/api/config') {
    sendJson(res, 200, sanitizeConfig(loadConfig()))
    return true
  }

  // PUT /api/config
  if (method === 'PUT' && pathname === '/api/config') {
    try {
      const raw = await readJsonBody(req)
      const validationError = validateConfigPayload(raw)
      if (validationError) {
        sendJson(res, 400, { error: validationError })
        return true
      }
      const body = normalizeConfig(raw)
      // 合并策略：前端可能回传脱敏的 apiKey（含 ****），此时保留原值
      const current = loadConfig()
      const merged = mergeConfigPreservingMaskedKeys(current, body)
      saveConfig(merged)
      sendJson(res, 200, { ok: true, config: sanitizeConfig(merged) })
    } catch (err) {
      sendJson(res, 400, { error: safeHttpErrorMessage(err, loadConfig()) })
    }
    return true
  }

  // GET /api/presets
  if (method === 'GET' && pathname === '/api/presets') {
    const grouped: Record<MediaModality, MediaModelPreset[]> = {
      image: getPresetsByModality('image'),
      video: getPresetsByModality('video'),
      audio: getPresetsByModality('audio'),
    }
    sendJson(res, 200, grouped)
    return true
  }

  // GET /api/status
  if (method === 'GET' && pathname === '/api/status') {
    const config = loadConfig()
    // 实际落盘目录 = 根目录（config.outputDir 或默认 configDir）+ generated-media 子目录，
    // 与 runGeneration 的 resolve(ctx.outputDir, 'generated-media') 保持一致。
    const root = config.outputDir || getDefaultOutputDir()
    sendJson(res, 200, {
      configPath: getConfigPath(),
      outputDir: resolveGeneratedMediaDir(root),
      modalities: {
        image: isModalityReady(config, 'image'),
        video: isModalityReady(config, 'video'),
        audio: isModalityReady(config, 'audio'),
      },
      policy: resolveGenerationPolicy(config),
      diagnostics: {
        enabled: config.diagnostics?.enabled === true,
        path: getDiagnosticsPath(config),
      },
    })
    return true
  }

  // POST /api/test（试用台）
  if (method === 'POST' && pathname === '/api/test') {
    let submittedApiKey: string | undefined
    let requestSecrets: string[] = []
    // 客户端断开（关标签页/刷新）时中止上游轮询与下载，避免用户已离开却继续产生费用的付费请求。
    const ac = new AbortController()
    const onClientClose = () => ac.abort()
    req.on('close', onClientClose)
    try {
      const raw = await readJsonBody(req)
      const validationError = validateTestRequestPayload(raw)
      if (validationError) throw new Error(validationError)
      const body = raw as TestRequestBody
      submittedApiKey = typeof body.apiKey === 'string' ? body.apiKey : undefined
      requestSecrets = diagnosticSecretsForTestBody(body, undefined, body.prompt)
      const result = await runTestGeneration(body, ac.signal)
      if (!ac.signal.aborted && !res.headersSent) sendJson(res, 200, result)
    } catch (err) {
      // 客户端已断开时不再写入响应（接收方已不存在）；诊断日志已在 runTestGeneration 内记录。
      if (!ac.signal.aborted && !res.headersSent) {
        const rawMessage = err instanceof Error ? err.message : String(err)
        const secrets = collectConfigSecrets(loadConfig())
        secrets.push(...requestSecrets)
        if (submittedApiKey) secrets.push(submittedApiKey)
        sendJson(res, 400, { error: redactSensitiveText(rawMessage, secrets) })
      }
    } finally {
      req.off('close', onClientClose)
    }
    return true
  }

  // GET /api/export?agent=claude
  if (method === 'GET' && pathname === '/api/export') {
    const agent = parsedUrl.searchParams.get('agent') || 'claude'
    sendJson(res, 200, exportAgentConfig(agent))
    return true
  }

  return false
}

export function validateConfigPayload(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return '配置体必须是 JSON 对象'
  const root = raw as Record<string, unknown>
  for (const m of ['image', 'video', 'audio'] as const) {
    const value = root[m]
    if (value === undefined) continue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${m} 配置必须是对象`
    const mod = value as Record<string, unknown>
    if (mod.enabled !== undefined && typeof mod.enabled !== 'boolean') return `${m}.enabled 必须是布尔值`
    for (const field of ['presetId', 'apiKey', 'apiKeyEnv', 'model', 'baseUrl', 'protocol', 'audioTask']) {
      if (mod[field] !== undefined && typeof mod[field] !== 'string') return `${m}.${field} 必须是字符串`
    }
    if (typeof mod.baseUrl === 'string' && mod.baseUrl.trim() && !isValidHttpBaseUrl(mod.baseUrl)) {
      return `${m}.baseUrl 必须是有效的 HTTPS 地址（本机回环代理可使用 HTTP）`
    }
    if (typeof mod.apiKeyEnv === 'string' && mod.apiKeyEnv.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(mod.apiKeyEnv.trim())) {
      return `${m}.apiKeyEnv 必须是合法环境变量名`
    }
    if (typeof mod.protocol === 'string' && mod.protocol.trim() && !isMediaProtocol(mod.protocol.trim())) {
      return `${m}.protocol 不是受支持的协议`
    }
    if (typeof mod.audioTask === 'string' && mod.audioTask.trim() && !['tts', 'music', 'clone'].includes(mod.audioTask.trim())) {
      return `${m}.audioTask 必须是 tts / music / clone`
    }
    if (typeof mod.protocol === 'string' && isMediaProtocol(mod.protocol.trim())) {
      const preset = typeof mod.presetId === 'string'
        ? MEDIA_MODEL_PRESETS.find((item) => item.id === mod.presetId && item.modality === m)
        : undefined
      const task = m === 'audio'
        ? ((typeof mod.audioTask === 'string' && ['tts', 'music', 'clone'].includes(mod.audioTask.trim())
          ? mod.audioTask.trim()
          : preset?.audioTask ?? 'tts') as 'tts' | 'music' | 'clone')
        : 'tts'
      if (!hasRegisteredMediaAdapter(m, mod.protocol.trim(), task)) {
        return `${m}.protocol 与当前模态或音频任务不兼容`
      }
    }
    for (const field of ['apiKeyByVendor', 'apiKeyByPreset']) {
      const map = mod[field]
      if (map === undefined) continue
      if (typeof map !== 'object' || map === null || Array.isArray(map)) return `${m}.${field} 必须是对象`
      if (Object.keys(map as Record<string, unknown>).some((key) => !isSafeConfigMapKey(key))) return `${m}.${field} 包含不安全的键名`
      if (Object.values(map as Record<string, unknown>).some((item) => typeof item !== 'string')) return `${m}.${field} 的值必须是字符串`
    }
  }
  if (root.outputDir !== undefined && typeof root.outputDir !== 'string') return 'outputDir 必须是字符串'
  if (typeof root.outputDir === 'string' && root.outputDir.trim() && !isAbsolute(root.outputDir.trim())) return 'outputDir 必须是绝对路径'
  if (root.policy !== undefined) {
    if (typeof root.policy !== 'object' || root.policy === null || Array.isArray(root.policy)) return 'policy 必须是对象'
    const policy = root.policy as Record<string, unknown>
    for (const field of ['maxOutputs', 'maxVideoDurationSec', 'maxInlineMiB', 'maxInputMiB']) {
      if (policy[field] !== undefined && typeof policy[field] !== 'number') return `policy.${field} 必须是数字`
    }
    if (policy.maxOutputs !== undefined && (!Number.isInteger(policy.maxOutputs) || Number(policy.maxOutputs) < 1 || Number(policy.maxOutputs) > 4)) return 'policy.maxOutputs 必须是 1-4 的整数'
    if (policy.maxVideoDurationSec !== undefined && (!Number.isInteger(policy.maxVideoDurationSec) || Number(policy.maxVideoDurationSec) < 1 || Number(policy.maxVideoDurationSec) > 600)) return 'policy.maxVideoDurationSec 必须是 1-600 的整数'
    if (policy.maxInlineMiB !== undefined && (!Number.isFinite(policy.maxInlineMiB) || Number(policy.maxInlineMiB) < 0 || Number(policy.maxInlineMiB) > 256)) return 'policy.maxInlineMiB 必须在 0-256 之间'
    if (policy.maxInputMiB !== undefined && (!Number.isInteger(policy.maxInputMiB) || Number(policy.maxInputMiB) < 1 || Number(policy.maxInputMiB) > 2048)) return 'policy.maxInputMiB 必须是 1-2048 的整数'
    if (policy.allow4k !== undefined && typeof policy.allow4k !== 'boolean') return 'policy.allow4k 必须是布尔值'
    if (policy.allowedInputDirs !== undefined && (!Array.isArray(policy.allowedInputDirs) || policy.allowedInputDirs.some((item) => typeof item !== 'string'))) {
      return 'policy.allowedInputDirs 必须是字符串数组'
    }
    if (Array.isArray(policy.allowedInputDirs) && policy.allowedInputDirs.some((item) => typeof item === 'string' && item.trim() && !isAbsolute(item.trim()))) {
      return 'policy.allowedInputDirs 必须全部使用绝对路径'
    }
  }
  if (root.diagnostics !== undefined) {
    if (typeof root.diagnostics !== 'object' || root.diagnostics === null || Array.isArray(root.diagnostics)) return 'diagnostics 必须是对象'
    const diagnostics = root.diagnostics as Record<string, unknown>
    if (diagnostics.enabled !== undefined && typeof diagnostics.enabled !== 'boolean') return 'diagnostics.enabled 必须是布尔值'
    if (diagnostics.logFile !== undefined && typeof diagnostics.logFile !== 'string') return 'diagnostics.logFile 必须是字符串'
  }
  return null
}

/** 统一清洗回传给浏览器的错误文本：脱敏密钥，并剥离本地绝对路径（含用户名/目录结构）。 */
function safeHttpErrorMessage(err: unknown, config: DuoConfig): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactSensitiveText(raw, collectConfigSecrets(config))
    .replace(/(^|[\s"'=(])\/(?:Users|home|private|var|tmp|etc|opt|Volumes|root|mnt|srv|media)\/[^\s"'<>,);]+/g, '$1[LOCAL_PATH]')
    .slice(0, 1000)
}

export function validateTestRequestPayload(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return '试用请求必须是 JSON 对象'
  const body = raw as Record<string, unknown>
  if (!['image', 'video', 'audio'].includes(String(body.modality ?? ''))) return 'modality 必须是 image / video / audio 之一'
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) return 'prompt 不能为空'
  for (const field of ['apiKey', 'apiKeyEnv', 'presetId', 'model', 'protocol', 'baseUrl', 'size', 'voice', 'outputDir']) {
    if (body[field] !== undefined && typeof body[field] !== 'string') return `${field} 必须是字符串`
  }
  if (typeof body.apiKeyEnv === 'string' && body.apiKeyEnv.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.apiKeyEnv.trim())) {
    return 'apiKeyEnv 必须是合法环境变量名'
  }
  if (typeof body.baseUrl === 'string' && body.baseUrl.trim() && !isValidHttpBaseUrl(body.baseUrl)) {
    return 'baseUrl 必须是有效的 HTTPS 地址（本机回环代理可使用 HTTP）'
  }
  if (typeof body.protocol === 'string' && body.protocol.trim() && !isMediaProtocol(body.protocol.trim())) return 'protocol 不是受支持的协议'
  if (body.numberOfImages !== undefined && (!Number.isInteger(body.numberOfImages) || Number(body.numberOfImages) < 1)) {
    return 'numberOfImages 必须是正整数'
  }
  if (body.numberOfVideos !== undefined && (!Number.isInteger(body.numberOfVideos) || Number(body.numberOfVideos) < 1)) {
    return 'numberOfVideos 必须是正整数'
  }
  if (body.modality === 'image' && body.numberOfVideos !== undefined) return '图像试用只接受 numberOfImages'
  if (body.modality === 'video' && body.numberOfImages !== undefined) return '视频试用只接受 numberOfVideos'
  if (body.duration !== undefined && (typeof body.duration !== 'number' || !Number.isFinite(body.duration) || body.duration < 0)) {
    return 'duration 必须是非负有限数字'
  }
  if (body.task !== undefined && (typeof body.task !== 'string' || !['tts', 'music', 'clone'].includes(body.task))) {
    return 'task 必须是 tts / music / clone'
  }
  if (body.referencePaths !== undefined && (!Array.isArray(body.referencePaths) || body.referencePaths.some((item) => typeof item !== 'string'))) {
    return 'referencePaths 必须是字符串数组'
  }
  return null
}

/**
 * 合并配置：前端回传的 apiKey 若含 ****（脱敏标记），保留原 config 中的真实值。
 * 空字符串视为用户主动清空，允许清空（修复「无法删除已存 key」）。
 * apiKeyByVendor / apiKeyByPreset map 同理：含 **** 的条目保留原值，否则用前端回传值（含清空）。
 */
export function mergeConfigPreservingMaskedKeys(current: DuoConfig, incoming: DuoConfig): DuoConfig {
  const merged: DuoConfig = { ...incoming }
  for (const m of ['image', 'video', 'audio'] as const) {
    const inc = incoming[m]
    const cur = current[m]
    if (!inc) continue
    const fixed: ModalityConfig = { ...inc }
    // 顶层 apiKey：脱敏占位保留原值；否则用前端值（含空字符串=清空）
    if (cur && inc.apiKey?.includes('****')) {
      const resolved = resolveMaskedStoredApiKey(m, cur, inc)
      if (resolved) {
        fixed.apiKey = resolved
      } else {
        // 目标 vendor/preset 没有记忆的真实 key：只有与当前顶层同属一个 vendor 时才回退到旧顶层值，
        // 跨 vendor 切换时清空，避免把旧厂商的 key 错配到新厂商并用错误账户请求付费接口。
        const targetVendor = vendorKeyForPreset(m, inc.presetId)
        const currentVendor = vendorKeyForPreset(m, cur.presetId)
        fixed.apiKey = targetVendor && currentVendor && targetVendor === currentVendor ? (cur.apiKey || '') : ''
      }
    }
    fixed.apiKeyByVendor = mergeMaskedStringMap(cur?.apiKeyByVendor, inc.apiKeyByVendor)
    fixed.apiKeyByPreset = mergeMaskedStringMap(cur?.apiKeyByPreset, inc.apiKeyByPreset)
    // 顶层 apiKey 被清空时，同步删除该预设对应的 vendor/preset 记忆，避免"删掉的 key 复活"。
    if (inc.apiKey === '' && inc.presetId) {
      const vendorKey = vendorKeyForPreset(m, inc.presetId)
      if (vendorKey && fixed.apiKeyByVendor) delete fixed.apiKeyByVendor[vendorKey]
      if (fixed.apiKeyByPreset) delete fixed.apiKeyByPreset[inc.presetId]
    }
    merged[m] = fixed
  }
  return merged
}

function mergeMaskedStringMap(
  current: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!current && !incoming) return undefined
  const merged = new Map<string, string>(
    Object.entries(current || {}).filter(([key, value]) => isSafeConfigMapKey(key) && typeof value === 'string'),
  )
  for (const [key, value] of Object.entries(incoming || {})) {
    if (!isSafeConfigMapKey(key)) continue
    if (value.includes('****')) continue // 脱敏占位：保留磁盘原值
    if (value === '') merged.delete(key) // 空字符串：用户主动清除该记忆，删除磁盘条目
    else merged.set(key, value)
  }
  return Object.fromEntries(merged)
}

function vendorKeyForPreset(modality: MediaModality, presetId: string | undefined): string {
  if (!presetId) return ''
  const preset = MEDIA_MODEL_PRESETS.find((p) => p.modality === modality && p.id === presetId)
  return preset?.vendor || (presetId === 'custom' ? 'custom' : presetId)
}

function resolveMaskedStoredApiKey(
  modality: MediaModality,
  current: ModalityConfig,
  incoming: ModalityConfig,
): string | undefined {
  const presetId = incoming.presetId
  const vendorKey = vendorKeyForPreset(modality, presetId)
  if (
    vendorKey
    && incoming.apiKeyByVendor?.[vendorKey]?.includes('****')
    && current.apiKeyByVendor?.[vendorKey]?.trim()
  ) {
    return current.apiKeyByVendor[vendorKey]
  }
  if (
    presetId
    && incoming.apiKeyByPreset?.[presetId]?.includes('****')
    && current.apiKeyByPreset?.[presetId]?.trim()
  ) {
    return current.apiKeyByPreset[presetId]
  }
  return undefined
}

// ===== 试用台生成 =====

interface TestResult {
  ok: boolean
  items: Array<{
    mediaType: string
    /** data URI，前端直接 <img src>/<audio src> 内联预览 */
    dataUri?: string
    /** 落盘绝对路径（视频体积大，只给路径） */
    localPath?: string
  }>
  text: string
  savedDir: string
}

/** 将试用台指定的 outputDir 收敛到配置根目录之下；越界或为空时落到默认 playground 子目录。 */
function resolveWithinOutputRoot(rawDir: string | undefined, root: string): string {
  const sub = rawDir?.trim()
  if (!sub) return resolve(root, 'playground')
  const candidate = isAbsolute(sub) ? resolve(sub) : resolve(root, sub)
  const rel = relative(root, candidate)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? candidate : resolve(root, 'playground')
}

async function runTestGeneration(body: TestRequestBody, signal?: AbortSignal): Promise<TestResult> {
  const { modality } = body
  if (!modality || !['image', 'video', 'audio'].includes(modality)) {
    throw new Error('modality 必须是 image / video / audio 之一')
  }

  const config = loadConfig()
  const policy = resolveGenerationPolicy(config)
  const credentials = resolveTestCredentials(body, config)

  const effective = resolveEffectiveMediaCredentials(credentials, modality)
  const resolved = resolveMediaConfig(effective, modality)
  if (!resolved) throw new Error('无法解析模型配置：请检查 presetId / model 是否正确')
  if (!isValidHttpBaseUrl(resolved.baseUrl)) throw new Error('解析出的 baseUrl 无效，请检查 preset 或自定义 baseUrl')
  const effectiveApiKey = effective.apiKey?.trim()
  if (!effectiveApiKey) throw new Error('当前模型没有可用的 API Key')

  const prompt = body.prompt?.trim()
  if (!prompt) throw new Error('prompt 不能为空')
  enforceGenerationPolicy(modality, {
    numberOfImages: modality === 'image' ? body.numberOfImages : undefined,
    numberOfVideos: modality === 'video' ? body.numberOfVideos : undefined,
    duration: body.duration,
    size: body.size,
  }, prompt, policy, {
    defaultSize: resolved.preset?.defaultSize,
    defaultImageSize: resolved.preset?.defaultImageSize,
  })

  // 试用产物落盘目录：用户在试用台指定的优先，否则落到与正式生成物一致的非隐藏目录
  // ~/prismstudio/playground/（getDefaultOutputDir 已与配置目录 ~/.prismstudio 分离）。
  // 收敛到配置根目录之下：防止 outputDir 被设成宽路径（如 /、~/）从而成为隐式读根，
  // 削弱 policy.allowedInputDirs 的边界（引擎会把 cwd 的 realpath 也当作合法读根）。
  const outputRoot = resolve(config.outputDir?.trim() || getDefaultOutputDir())
  const playgroundDir = resolveWithinOutputRoot(body.outputDir, outputRoot)
  mkdirSync(playgroundDir, { recursive: true })

  const requestId = randomUUID()
  const startedAt = Date.now()
  let generated
  const referenceReadBudget = { remainingBytes: policy.maxInputBytes }
  try {
    const result = await generateMedia({
      modality,
      prompt,
      config: resolved,
      apiKey: effectiveApiKey,
      size: body.size,
      numberOfImages: modality === 'image' ? body.numberOfImages : undefined,
      numberOfVideos: modality === 'video' ? body.numberOfVideos : undefined,
      duration: body.duration,
      referencePaths: body.referencePaths,
      voice: body.voice,
      audioTask: body.task,
      cwd: playgroundDir,
      allowedInputRoots: policy.allowedInputDirs,
      maxInputBytes: policy.maxInputBytes,
      referenceReadBudget,
      signal,
    })
    generated = modality === 'image'
      ? selectGeneratedImagesForImageRequest(result.images, {
        userMessage: prompt,
        defaultCount: body.numberOfImages,
        maxCount: policy.maxOutputs,
      })
      : modality === 'video'
        ? result.images.slice(0, policy.maxOutputs)
        : result.images
  } catch (err) {
    writeGenerationDiagnostic(config, {
      requestId, source: 'webui', outcome: 'error', modality,
      protocol: resolved.protocol, vendor: resolved.preset?.vendor, model: resolved.model,
      elapsedMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    }, diagnosticSecretsForTestBody(body, effectiveApiKey, prompt))
    throw err
  }

  const modalityLabel = modality === 'image' ? '图片' : modality === 'video' ? '视频' : '音频'
  const { items, content, savedPaths } = persistGenerated(generated, modalityLabel, {
    outputDir: resolve(playgroundDir, modality),
    maxInlineBytes: policy.maxInlineBytes,
  })
  writeGenerationDiagnostic(config, {
    requestId, source: 'webui', outcome: 'success', modality,
    protocol: resolved.protocol, vendor: resolved.preset?.vendor, model: resolved.model,
    elapsedMs: Date.now() - startedAt, outputCount: generated.length,
  }, diagnosticSecretsForTestBody(body, effectiveApiKey, prompt))

  const resultItems = items.map((item) => {
    // image / audio 直接给 dataUri 内联预览；video 体积大只给路径
    if (item.inlined && item.data && (item.mediaType.startsWith('image/') || item.mediaType.startsWith('audio/'))) {
      return {
        mediaType: item.mediaType,
        dataUri: `data:${item.mediaType};base64,${item.data}`,
      }
    }
    return { mediaType: item.mediaType, localPath: item.localPath }
  })

  const textBlock = content.find((c) => c.type === 'text')
  return {
    ok: true,
    items: resultItems,
    text: textBlock?.text ?? '',
    savedDir: savedPaths[0] ? resolve(playgroundDir, modality) : '',
  }
}

/**
 * 用页面当前状态解析试用凭据。页面状态优先于磁盘配置；若用户刚切换预设且
 * 尚未自动保存，则按目标预设 vendor/preset 从磁盘的真实 key 记忆中取值，
 * 绝不把旧预设顶层 key 错配给新厂商。
 */
export function resolveTestCredentials(body: TestRequestBody, config: DuoConfig): Record<string, string> {
  const modality = body.modality
  const stored = getModalityConfig(config, modality)
  const presetId = body.presetId?.trim() || stored?.presetId?.trim() || 'custom'
  const samePreset = stored?.presetId === presetId
  const vendorKey = vendorKeyForPreset(modality, presetId)
  const storedForTarget = stored
    ? (stored.apiKeyByVendor?.[vendorKey]?.trim()
      || stored.apiKeyByPreset?.[presetId]?.trim()
      || (samePreset ? resolveModalityApiKey(stored) : ''))
    : ''
  const pageEnvName = body.apiKeyEnv?.trim()
  const pageEnvKey = pageEnvName && /^[A-Za-z_][A-Za-z0-9_]*$/.test(pageEnvName)
    ? process.env[pageEnvName]?.trim()
    : ''
  // 与正式 MCP 路径保持相同语义：任何已有的明文 key（含当前 vendor 的记忆 key）
  // 都优先于 apiKeyEnv。否则页面试用会走环境变量、保存后的正式调用却仍走旧明文 key。
  const apiKey = body.apiKey?.trim() || storedForTarget || pageEnvKey
  if (!apiKey) {
    throw new Error(`未配置 ${modality} 模态当前模型的 API Key，请先在配置页填写或在此处临时输入`)
  }

  const pageValue = (value: unknown, fallback: string | undefined): string | undefined => (
    typeof value === 'string' ? value : fallback
  )
  const protocolValue = pageValue(body.protocol, samePreset ? stored?.protocol : undefined)?.trim()
  return toEngineCredentials({
    enabled: true,
    apiKey,
    presetId,
    model: pageValue(body.model, samePreset ? stored?.model : undefined),
    baseUrl: pageValue(body.baseUrl, samePreset ? stored?.baseUrl : undefined),
    protocol: protocolValue ? protocolValue as MediaProtocol : undefined,
    audioTask: stored?.audioTask,
  })
}

// ===== 接入向导：导出 agent 配置 =====

/** 计算启动命令（优先 npx，回退 node + 本包路径） */
function buildStartCommand(): string {
  return `npx -y prismstudio@latest`
}

function exportAgentConfig(agent: string): { agent: string; config: unknown; note: string } {
  const cmd = buildStartCommand()
  const serverEntry = {
    command: 'npx',
    args: ['-y', 'prismstudio@latest'],
    timeoutMs: 1800000,
  }

  switch (agent) {
    case 'claude':
    case 'claude-desktop':
      return {
        agent: 'claude-desktop',
        note: '写入 Claude Desktop 配置文件（macOS: ~/Library/Application Support/Claude/claude_desktop_config.json）',
        config: {
          mcpServers: {
            'prismstudio': serverEntry,
          },
        },
      }
    case 'cursor':
      return {
        agent: 'cursor',
        note: '写入 ~/.cursor/mcp.json（全局）或项目 .cursor/mcp.json',
        config: {
          mcpServers: {
            'prismstudio': serverEntry,
          },
        },
      }
    case 'cline':
    case 'windsurf':
    case 'vscode':
      return {
        agent,
        note: `${agent} 的 mcpServers 配置`,
        config: {
          mcpServers: {
            'prismstudio': serverEntry,
          },
        },
      }
    case 'stdio':
    case 'generic':
    default:
      return {
        agent: 'generic',
        note: `通用 stdio 命令：${cmd}`,
        config: {
          command: 'npx',
          args: ['-y', 'prismstudio@latest'],
          timeoutMs: 1800000,
        },
      }
  }
}

// ===== 启动 server =====

export function startWebuiServer(port: number): Promise<void> {
  return new Promise((resolveStart, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const method = req.method || 'GET'
        const url = (req.url || '/').split('?')[0] ?? '/'
        const fullUrl = req.url || '/'

        // WebUI 与 API 同源（均由本 server 托管于 127.0.0.1），不需要 CORS。
        // 不设 Access-Control-Allow-Origin=*，避免本机其它恶意网页跨域访问 /api/test（会用真实 key）。
        if (method === 'OPTIONS') {
          setCommonSecurityHeaders(res)
          res.writeHead(204)
          res.end()
          return
        }

        // API 路由
        if (url.startsWith('/api/')) {
          const apiError = validateIncomingApiRequest(req, method)
          if (apiError) {
            sendJson(res, 403, { error: apiError })
            return
          }
          const handled = await handleApi(method, fullUrl, req, res)
          if (!handled) sendJson(res, 404, { error: 'Not Found' })
          return
        }

        // 本地依赖资源：不从第三方 CDN 加载，避免 WebUI 处理 API Key 时引入供应链脚本风险。
        if (method === 'GET' && url === '/assets/alpine.min.js') {
          sendText(res, 200, loadAlpineScript(), 'text/javascript; charset=utf-8')
          return
        }

        // 首页
        if (url === '/' || url === '/index.html') {
          const html = WEBUI_HTML
          setHtmlSecurityHeaders(res)
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(html)
          return
        }

        sendJson(res, 404, { error: 'Not Found' })
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { error: safeHttpErrorMessage(err, loadConfig()) })
        }
      }
    })

    server.on('error', reject)

    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}`
      process.stderr.write(`\n[prismstudio] WebUI 已启动：${url}\n`)
      process.stderr.write(`[prismstudio] 配置文件：${getConfigPath()}\n`)
      process.stderr.write(`[prismstudio] 按 Ctrl+C 退出\n\n`)
      // 尝试自动打开浏览器（非关键，失败静默）；CI/测试可用 PRISMSTUDIO_NO_OPEN=1 禁用。
      if (process.env.PRISMSTUDIO_NO_OPEN !== '1') openBrowser(url).catch(() => {})
      resolveStart()
    })
  })
}

/** 尽力打开默认浏览器 */
async function openBrowser(url: string): Promise<void> {
  const { exec } = await import('node:child_process')
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`
  exec(cmd, () => {
    /* 静默忽略打开失败 */
  })
}
