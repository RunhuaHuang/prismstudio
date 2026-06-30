#!/usr/bin/env node
/**
 * Duo-MCP CLI 入口
 *
 * 两种运行模式（互斥）：
 *
 * 1. stdio MCP 模式（默认，给 agent 调用）：
 *    duo-mcp
 *    duo-mcp --output-dir /path/to/out
 *
 * 2. WebUI 模式（给人配置 / 试用 / 导出接入配置）：
 *    duo-mcp --webui
 *    duo-mcp --webui --port 17899
 *
 * 环境变量：
 * - DUO_MCP_CONFIG：指定 config.json 路径（默认 ~/.duo-mcp/config.json）
 */

import { createMcpServer, connectStdio, loadConfig, getConfigPath } from './mcp-server.js'
import { isModalityReady } from './config.js'
import { startWebuiServer } from './webui/server.js'

const HELP = `
Duo-MCP — 独立多模态生成 MCP Server

用法：
  duo-mcp                       以 stdio MCP 模式运行（供 Claude / Cursor / Cline 等 agent 接入）
  duo-mcp --webui               启动本地 WebUI 配置台 + 试用台（浏览器打开 http://127.0.0.1:<port>）
  duo-mcp --webui --port 8080   指定 WebUI 端口（默认 17899）
  duo-mcp --output-dir <path>   覆盖生成物输出目录
  duo-mcp --help                显示本帮助

配置文件：
  ${'$'} 默认 ~/.duo-mcp/config.json（可用 DUO_MCP_CONFIG 环境变量覆盖）

首次使用建议先跑：duo-mcp --webui
在浏览器里配置各模态的 API Key 与模型，然后用「接入向导」一键复制 agent 配置。
`.trim()

interface ParsedArgs {
  webui: boolean
  port: number
  outputDir?: string
  help: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { webui: false, port: 17899, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--webui' || arg === 'webui') parsed.webui = true
    else if (arg === '--port') {
      const next = argv[i + 1]
      const port = Number(next)
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        parsed.port = port
        i++
      }
    } else if (arg === '--output-dir') {
      const next = argv[i + 1]
      if (next) {
        parsed.outputDir = next
        i++
      }
    }
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
      `[duo-mcp] 警告：当前没有任何模态配置好（需 enabled + apiKey + 模型）。\n` +
        `[duo-mcp] 请先运行 \`duo-mcp --webui\` 完成配置。配置文件：${getConfigPath()}\n` +
        `[duo-mcp] server 仍会启动，但不会暴露任何生成工具。\n\n`,
    )
  } else {
    process.stderr.write(
      `[duo-mcp] 已就绪模态：${readyModalities.join(', ')}\n` +
        `[duo-mcp] 配置文件：${getConfigPath()}\n\n`,
    )
  }

  const server = createMcpServer(outputDir)
  const transport = await connectStdio(server)

  // 优雅退出
  const shutdown = async () => {
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

  if (args.webui) {
    await startWebuiServer(args.port)
    return
  }

  await runStdio(args.outputDir)
}

main().catch((err) => {
  process.stderr.write(`[duo-mcp] 启动失败：${err instanceof Error ? err.stack || err.message : String(err)}\n`)
  process.exit(1)
})
