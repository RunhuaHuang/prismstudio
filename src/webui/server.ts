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
import { resolve } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { WEBUI_HTML } from './index-html.js'
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  getConfigDir,
  getDefaultOutputDir,
  getModalityConfig,
  isModalityReady,
  toEngineCredentials,
  type DuoConfig,
  type MediaProtocol,
  type ModalityConfig,
} from '../config.js'
import {
  MEDIA_MODEL_PRESETS,
  getPresetsByModality,
  generateMedia,
  resolveMediaConfig,
  resolveEffectiveMediaCredentials,
  type MediaModality,
  type MediaModelPreset,
} from '../engine/media-generation-engine.js'
import { persistGenerated } from '../persist.js'

// ===== 工具函数 =====

const require = createRequire(import.meta.url)
let alpineScriptCache: string | null = null

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
  /** 临时覆盖的 presetId（不修改 config.json） */
  presetId?: string
  /** 当前页面中的模型/协议/Base URL，避免自动保存 debounce 期间试用旧配置 */
  model?: string
  protocol?: MediaProtocol | ''
  baseUrl?: string
  size?: string
  numberOfImages?: number
  duration?: number
  voice?: string
  task?: 'tts' | 'music' | 'clone'
  referencePaths?: string[]
  /** 试用产物落盘根目录（留空走默认 playground） */
  outputDir?: string
}

/** 读取请求体（JSON） */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveReq, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      chunks.push(c)
      // 限制 5MB，防滥用
      if (chunks.reduce((a, c) => a + c.length, 0) > 5 * 1024 * 1024) {
        reject(new Error('请求体过大（>5MB）'))
        req.destroy()
      }
    })
    req.on('end', () => {
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
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
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
    const contentType = meta.contentType?.toLowerCase() ?? ''
    if (!contentType.includes('application/json')) return '写入类 API 请求必须使用 application/json'
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

/** 对配置做脱敏（隐藏 apiKey 中间部分） */
function maskApiKey(key: string): string {
  if (!key) return ''
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
  // GET /api/config
  if (method === 'GET' && url === '/api/config') {
    sendJson(res, 200, sanitizeConfig(loadConfig()))
    return true
  }

  // PUT /api/config
  if (method === 'PUT' && url === '/api/config') {
    try {
      const body = (await readJsonBody(req)) as DuoConfig
      // 合并策略：前端可能回传脱敏的 apiKey（含 ****），此时保留原值
      const current = loadConfig()
      const merged = mergeConfigPreservingMaskedKeys(current, body)
      saveConfig(merged)
      sendJson(res, 200, { ok: true, config: sanitizeConfig(merged) })
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // GET /api/presets
  if (method === 'GET' && url === '/api/presets') {
    const grouped: Record<MediaModality, MediaModelPreset[]> = {
      image: getPresetsByModality('image'),
      video: getPresetsByModality('video'),
      audio: getPresetsByModality('audio'),
    }
    sendJson(res, 200, grouped)
    return true
  }

  // GET /api/status
  if (method === 'GET' && url === '/api/status') {
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
    })
    return true
  }

  // POST /api/test（试用台）
  if (method === 'POST' && url === '/api/test') {
    try {
      const body = (await readJsonBody(req)) as TestRequestBody
      const result = await runTestGeneration(body)
      sendJson(res, 200, result)
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  // GET /api/export?agent=claude
  if (method === 'GET' && url.startsWith('/api/export')) {
    const u = new URL(url, 'http://localhost')
    const agent = u.searchParams.get('agent') || 'claude'
    sendJson(res, 200, exportAgentConfig(agent))
    return true
  }

  return false
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
    if (!inc || !cur) continue
    const fixed: ModalityConfig = { ...inc }
    // 顶层 apiKey：脱敏占位保留原值；否则用前端值（含空字符串=清空）
    if (inc.apiKey?.includes('****')) {
      fixed.apiKey = resolveMaskedStoredApiKey(m, cur, inc) || cur.apiKey || ''
    }
    fixed.apiKeyByVendor = mergeMaskedStringMap(cur.apiKeyByVendor, inc.apiKeyByVendor)
    fixed.apiKeyByPreset = mergeMaskedStringMap(cur.apiKeyByPreset, inc.apiKeyByPreset)
    merged[m] = fixed
  }
  return merged
}

function mergeMaskedStringMap(
  current: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!current && !incoming) return undefined
  const merged: Record<string, string> = { ...(current || {}) }
  for (const [key, value] of Object.entries(incoming || {})) {
    if (!value.includes('****')) merged[key] = value
  }
  return merged
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

async function runTestGeneration(body: TestRequestBody): Promise<TestResult> {
  const { modality } = body
  if (!modality || !['image', 'video', 'audio'].includes(modality)) {
    throw new Error('modality 必须是 image / video / audio 之一')
  }

  const config = loadConfig()
  const credentials = resolveTestCredentials(body, config)

  const effective = resolveEffectiveMediaCredentials(credentials, modality)
  const resolved = resolveMediaConfig(effective, modality)
  if (!resolved) throw new Error('无法解析模型配置：请检查 presetId / model 是否正确')
  if (!resolved.baseUrl.trim()) throw new Error('解析出的 baseUrl 为空，请检查 preset 或自定义 baseUrl')

  const prompt = body.prompt?.trim()
  if (!prompt) throw new Error('prompt 不能为空')

  // 试用产物落盘目录：用户在试用台指定的优先，否则落到默认 ~/.prismstudio/playground/
  const playgroundDir = body.outputDir?.trim()
    ? resolve(body.outputDir.trim())
    : resolve(getConfigDir(), 'playground')
  mkdirSync(playgroundDir, { recursive: true })

  const { images: generated } = await generateMedia({
    modality,
    prompt,
    config: resolved,
    apiKey: effective.apiKey,
    size: body.size,
    numberOfImages: body.numberOfImages,
    duration: body.duration,
    referencePaths: body.referencePaths,
    voice: body.voice,
    audioTask: body.task,
    cwd: playgroundDir,
  })

  const modalityLabel = modality === 'image' ? '图片' : modality === 'video' ? '视频' : '音频'
  const { items, content, savedPaths } = persistGenerated(generated, modalityLabel, {
    outputDir: resolve(playgroundDir, modality),
  })

  const resultItems = items.map((item) => {
    // image / audio 直接给 dataUri 内联预览；video 体积大只给路径
    if (item.mediaType.startsWith('image/') || item.mediaType.startsWith('audio/')) {
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
      || (samePreset ? stored.apiKey?.trim() : ''))
    : ''
  const apiKey = body.apiKey?.trim() || storedForTarget
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
        const url = (req.url || '/').split('?')[0]
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
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
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
