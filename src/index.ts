#!/usr/bin/env node
/**
 * Prismstudio CLI 入口
 *
 * 两种运行模式（互斥）：
 *
 * 1. stdio MCP 模式（默认，给 agent 调用）：
 *    prismstudio
 *    prismstudio --output-dir /path/to/out
 *
 * 2. WebUI 模式（给人配置 / 试用 / 导出接入配置）：
 *    prismstudio --webui
 *    prismstudio --webui --port 17899
 *
 * 环境变量：
 * - PRISMSTUDIO_CONFIG：指定 config.json 路径（默认 ~/.prismstudio/config.json）
 */

import { createMcpServer, connectStdio, loadConfig, getConfigPath, PACKAGE_VERSION, watchConfigForToolChanges, getDefaultOutputDir } from './mcp-server.js'
import { isModalityReady, resolveGenerationPolicy } from './config.js'
import { startWebuiServer } from './webui/server.js'
import { getDiagnosticsPath } from './diagnostics.js'
import { listRegisteredMediaAdapters } from './engine/media-generation-engine.js'
import { resolve } from 'node:path'

const HELP = `
Prismstudio — 多模态生成控制台

用法：
  prismstudio                       以 stdio MCP 模式运行（供 Claude / Cursor / Cline 等 agent 接入）
  prismstudio --webui               启动本地 WebUI 配置台 + 试用台（浏览器打开 http://127.0.0.1:<port>）
  prismstudio --webui --port 8080   指定 WebUI 端口（默认 17899）
  prismstudio --output-dir <path>   覆盖生成物输出根目录（实际写入 generated-media 子目录）
  prismstudio diagnostics           输出脱敏运行诊断（不显示密钥）
  prismstudio --version             显示版本号
  prismstudio --help                显示本帮助

配置文件：
  ${'$'} 默认 ~/.prismstudio/config.json（可用 PRISMSTUDIO_CONFIG 环境变量覆盖）

首次使用建议先跑：prismstudio --webui
在浏览器里配置各模态的 API Key 与模型，然后用「接入向导」一键复制 agent 配置。
`.trim()

interface ParsedArgs {
  webui: boolean
  port: number
  outputDir?: string
  help: boolean
  version: boolean
  diagnostics: boolean
}

class CliUsageError extends Error {}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { webui: false, port: 17899, help: false, version: false, diagnostics: false }
  let portProvided = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--version' || arg === '-v') parsed.version = true
    else if (arg === '--webui' || arg === 'webui') parsed.webui = true
    else if (arg === '--diagnostics' || arg === 'diagnostics') parsed.diagnostics = true
    else if (arg === '--port') {
      const next = argv[i + 1]
      const port = Number(next)
      if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new CliUsageError('--port 必须跟 1-65535 的整数')
      parsed.port = port
      portProvided = true
      i++
    } else if (arg === '--output-dir') {
      const next = argv[i + 1]
      if (!next || next.startsWith('-')) throw new CliUsageError('--output-dir 必须跟一个目录路径')
      parsed.outputDir = next
      i++
    } else {
      throw new CliUsageError(`未知参数: ${arg}`)
    }
  }
  if (!parsed.help && !parsed.version) {
    if (!parsed.webui && portProvided) throw new CliUsageError('--port 仅能与 --webui 一起使用')
    if (parsed.webui && parsed.diagnostics) throw new CliUsageError('--webui 与 diagnostics 不能同时使用')
    if (parsed.webui && parsed.outputDir) throw new CliUsageError('--output-dir 仅适用于 stdio MCP 模式')
    if (parsed.diagnostics && parsed.outputDir) throw new CliUsageError('--output-dir 不能与 diagnostics 同时使用')
  }
  return parsed
}

/** stdio MCP 模式：创建 server，连接 stdio transport，常驻 */
async function runStdio(outputDir?: string): Promise<void> {
  const config = loadConfig()
  const readyModalities = (['image', 'video', 'audio'] as const).filter((m) => isModalityReady(config, m))

  if (readyModalities.length === 0) {
    // 没有任何模态配置好；写 stderr 提示（stdout 留给 MCP 协议，不能污染）
    process.stderr.write(
      `[prismstudio] 警告：当前没有任何模态配置好（需 enabled + apiKey + 模型）。\n` +
        `[prismstudio] 请先运行 \`prismstudio --webui\` 完成配置。配置文件：${getConfigPath()}\n` +
        `[prismstudio] server 仍会启动，但不会暴露任何生成工具。\n\n`,
    )
  } else {
    process.stderr.write(
      `[prismstudio] 已就绪模态：${readyModalities.join(', ')}\n` +
        `[prismstudio] 配置文件：${getConfigPath()}\n\n`,
    )
  }

  const server = createMcpServer(outputDir)
  const transport = await connectStdio(server)
  const stopWatchingConfig = watchConfigForToolChanges(server)

  // 优雅退出
  const shutdown = async () => {
    stopWatchingConfig()
    try {
      await transport.close()
    } catch {
      /* ignore */
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    console.log(HELP)
    return
  }

  if (args.version) {
    console.log(PACKAGE_VERSION)
    return
  }

  if (args.diagnostics) {
    const config = loadConfig()
    const keySources = Object.fromEntries((['image', 'video', 'audio'] as const).map((modality) => {
      const mod = config[modality]
      const source = mod?.apiKey?.trim()
        ? 'config'
        : mod?.apiKeyEnv?.trim()
          ? `env:${mod.apiKeyEnv.trim()} (${process.env[mod.apiKeyEnv.trim()]?.trim() ? 'available' : 'missing'})`
          : 'missing'
      return [modality, source]
    }))
    console.log(JSON.stringify({
      version: PACKAGE_VERSION,
      configPath: getConfigPath(),
      outputDir: resolve(config.outputDir || getDefaultOutputDir(), 'generated-media'),
      readyModalities: (['image', 'video', 'audio'] as const).filter((modality) => isModalityReady(config, modality)),
      keySources,
      policy: resolveGenerationPolicy(config),
      diagnostics: { enabled: config.diagnostics?.enabled === true, path: getDiagnosticsPath(config) },
      registeredAdapters: listRegisteredMediaAdapters(),
    }, null, 2))
    return
  }

  if (args.webui) {
    await startWebuiServer(args.port)
    return
  }

  await runStdio(args.outputDir)
}

main().catch((err) => {
  const message = err instanceof CliUsageError
    ? `${err.message}\n使用 prismstudio --help 查看用法。`
    : err instanceof Error
      ? err.stack || err.message
      : String(err)
  process.stderr.write(`[prismstudio] 启动失败：${message}\n`)
  process.exit(1)
})
