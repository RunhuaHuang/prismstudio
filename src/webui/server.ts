/**
 * WebUI HTTP Server（webui/server）
 *
 * 仅绑定 127.0.0.1（不暴露到局域网，保护明文 API Key）。
 *
 * 路由：
 *   GET  /                  返回内嵌的 index.html（Alpine.js 单文件页面）
 *   GET  /api/config        读取当前配置（apiKey 脱敏）
 *   PUT  /api/config        保存配置（WebUI 表单 → config.json）
 *   GET  /api/presets       返回全部 MEDIA_MODEL_PRESETS（供下拉选择）
 *   GET  /api/status        返回各模态就绪状态
 *   POST /api/test          试用台：调用 generateMedia，返回 base64 或落盘路径
 *   GET  /api/export        按目标 agent 生成 mcpServers JSON 片段
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
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

interface TestRequestBody {
  modality: MediaModality
  prompt: string
  /** 临时覆盖的 apiKey（不修改 config.json，仅本次试用） */
  apiKey?: string
  /** 临时覆盖的 presetId（不修改 config.json） */
  presetId?: string
  size?: string
  numberOfImages?: number
  duration?: number
  voice?: string
  task?: 'tts' | 'music' | 'clone'
  referencePaths?: string[]
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
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 对配置做脱敏（隐藏 apiKey 中间部分） */
function maskApiKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '****' + key.slice(-4)
}

/** 配置脱敏后返回给前端（避免把完整 key 明文回传给浏览器）。
 *  顶层 apiKey 与 apiKeyByPreset map 内的 key 都脱敏。 */
function sanitizeConfig(config: DuoConfig): DuoConfig {
  const out: DuoConfig = { ...config }
  for (const m of ['image', 'video', 'audio'] as const) {
    const mod = config[m]
    if (mod) {
      const masked: ModalityConfig = { ...mod, apiKey: maskApiKey(mod.apiKey) }
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
    sendJson(res, 200, {
      configPath: getConfigPath(),
      outputDir: config.outputDir || getDefaultOutputDir(),
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
 * apiKeyByPreset map 同理：含 **** 的条目保留原值，否则用前端回传值（含清空）。
 */
function mergeConfigPreservingMaskedKeys(current: DuoConfig, incoming: DuoConfig): DuoConfig {
  const merged: DuoConfig = { ...incoming }
  for (const m of ['image', 'video', 'audio'] as const) {
    const inc = incoming[m]
    const cur = current[m]
    if (!inc || !cur) continue
    const fixed: ModalityConfig = { ...inc }
    // 顶层 apiKey：脱敏占位保留原值；否则用前端值（含空字符串=清空）
    if (inc.apiKey?.includes('****')) {
      fixed.apiKey = cur.apiKey
    }
    // apiKeyByPreset：以原值为基底，前端非脱敏值覆盖（含清空）
    if (cur.apiKeyByPreset || inc.apiKeyByPreset) {
      const mergedByPreset: Record<string, string> = { ...(cur.apiKeyByPreset || {}) }
      for (const [pid, k] of Object.entries(inc.apiKeyByPreset || {})) {
        if (!k.includes('****')) mergedByPreset[pid] = k
      }
      fixed.apiKeyByPreset = mergedByPreset
    }
    merged[m] = fixed
  }
  return merged
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
  const stored = getModalityConfig(config, modality)

  // 解析凭据：优先用 body 临时传入的，否则用 config 里存的
  let credentials: Record<string, string>
  if (body.apiKey?.trim()) {
    // 试用台临时 key：用 body 的 presetId 或 config 的 presetId
    const presetId = body.presetId || stored?.presetId || 'custom'
    credentials = toEngineCredentials({
      enabled: true,
      apiKey: body.apiKey,
      presetId,
      model: stored?.model,
      baseUrl: stored?.baseUrl,
      protocol: stored?.protocol,
      audioTask: stored?.audioTask,
    })
  } else {
    if (!stored?.apiKey?.trim()) {
      throw new Error(`未配置 ${modality} 模态的 API Key，请先在配置页填写或在此处临时输入`)
    }
    credentials = toEngineCredentials(stored)
  }

  const effective = resolveEffectiveMediaCredentials(credentials, modality)
  const resolved = resolveMediaConfig(effective, modality)
  if (!resolved) throw new Error('无法解析模型配置：请检查 presetId / model 是否正确')
  if (!resolved.baseUrl.trim()) throw new Error('解析出的 baseUrl 为空，请检查 preset 或自定义 baseUrl')

  const prompt = body.prompt?.trim()
  if (!prompt) throw new Error('prompt 不能为空')

  // 试用产物落到 ~/.duo-mcp/playground/
  const playgroundDir = resolve(getConfigDir(), 'playground')
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

// ===== 接入向导：导出 agent 配置 =====

/** 计算启动命令（优先 npx，回退 node + 本包路径） */
function buildStartCommand(): string {
  return `npx -y duo-mcp`
}

function exportAgentConfig(agent: string): { agent: string; config: unknown; note: string } {
  const cmd = buildStartCommand()
  const serverEntry = {
    command: 'npx',
    args: ['-y', 'duo-mcp'],
  }

  switch (agent) {
    case 'claude':
    case 'claude-desktop':
      return {
        agent: 'claude-desktop',
        note: '写入 Claude Desktop 配置文件（macOS: ~/Library/Application Support/Claude/claude_desktop_config.json）',
        config: {
          mcpServers: {
            'duo-mcp': serverEntry,
          },
        },
      }
    case 'cursor':
      return {
        agent: 'cursor',
        note: '写入 ~/.cursor/mcp.json（全局）或项目 .cursor/mcp.json',
        config: {
          mcpServers: {
            'duo-mcp': serverEntry,
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
            'duo-mcp': serverEntry,
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
          args: ['-y', 'duo-mcp'],
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

        // CORS（本地无害，方便调试）
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        // API 路由
        if (url.startsWith('/api/')) {
          const handled = await handleApi(method, fullUrl, req, res)
          if (!handled) sendJson(res, 404, { error: 'Not Found' })
          return
        }

        // 首页
        if (url === '/' || url === '/index.html') {
          const html = WEBUI_HTML
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
      process.stderr.write(`\n[duo-mcp] WebUI 已启动：${url}\n`)
      process.stderr.write(`[duo-mcp] 配置文件：${getConfigPath()}\n`)
      process.stderr.write(`[duo-mcp] 按 Ctrl+C 退出\n\n`)
      // 尝试自动打开浏览器（非关键，失败静默）
      openBrowser(url).catch(() => {})
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
