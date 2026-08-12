#!/usr/bin/env node
/**
 * 真实 provider 契约冒烟测试（显式付费 opt-in）。
 * 默认拒绝执行，避免 CI 或开发者误触产生费用。
 */
import { resolve } from 'node:path'
import { loadConfig, getDefaultOutputDir, isModalityReady, type MediaModality } from './config.js'
import { runGeneration } from './mcp-server.js'

const modality = process.argv[2] as MediaModality | undefined
if (process.env.PRISMSTUDIO_RUN_PAID_CONTRACT_TESTS !== '1') {
  throw new Error('真实契约测试可能产生费用；请显式设置 PRISMSTUDIO_RUN_PAID_CONTRACT_TESTS=1')
}
if (!modality || !['image', 'video', 'audio'].includes(modality)) {
  throw new Error('用法: bun run contract:smoke -- image|video|audio')
}

const config = loadConfig()
if (!isModalityReady(config, modality)) throw new Error(`${modality} 模态尚未配置好`)
const prompt = process.env.PRISMSTUDIO_CONTRACT_PROMPT?.trim()
  || (modality === 'audio' ? 'Prismstudio contract test.' : 'A minimal monochrome prism on a plain background.')
const args: Record<string, unknown> = modality === 'audio'
  ? { text: prompt }
  : modality === 'video'
    ? { prompt, numberOfVideos: 1, duration: 4 }
    : { prompt, numberOfImages: 1 }

const result = await runGeneration(modality, args, {
  outputDir: resolve(config.outputDir || getDefaultOutputDir()),
  sessionId: `contract-${Date.now()}`,
})
const summary = result.content.find((item) => item.type === 'text')
process.stdout.write(`${summary?.text ?? `${modality} contract smoke passed`}\n`)
