/**
 * MCP Server（mcp-server）
 *
 * 把引擎 + 配置 + 落盘串起来，对外暴露三个工具：
 * - generate_image：文生图 / 参考图编辑 / 多轮迭代
 * - generate_video：文生视频（异步）
 * - generate_audio：TTS / 音乐 / 声音克隆
 *
 * 采用底层 Server + setRequestHandler + JSON Schema（与 Run 的 runtime tools 一致），
 * 规避 zod 与高层 McpServer 的泛型深度递归（TS2589）。工具 schema 用纯 JSON Schema 定义。
 *
 * 工具按"模态是否已配置好"动态暴露：只有 enabled + 有 apiKey + 能解析出 model 的模态
 * 才会暴露对应工具，避免给 agent 暴露一堆用不了的空壳。
 *
 * handler 流程（fork 自 Run media-generation-mcp.ts 的 runMediaGeneration，去耦合化）：
 *   读 config → 解析 credentials → generateMedia → selectGeneratedImages → persistGenerated
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { resolve } from 'node:path'
import {
  generateMedia,
  resolveMediaConfig,
  resolveEffectiveMediaCredentials,
  setLastGenerated,
  getLastGenerated,
  selectGeneratedImagesForImageRequest,
  MEDIA_MODEL_PRESETS,
  getPresetsByModality,
  type MediaModality,
  type ResolvedMediaConfig,
} from './engine/media-generation-engine.js'
import { MINIMAX_VOICES } from './engine/minimax-voices.js'
import {
  loadConfig,
  toEngineCredentials,
  getModalityConfig,
  isModalityReady,
  getConfigPath,
  getDefaultOutputDir,
  type DuoConfig,
} from './config.js'
import { persistGenerated, type McpContent } from './persist.js'

// ===== 参数解析辅助（fork 自 Run mcp.ts） =====

function optionalStringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function optionalNumberArg(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function optionalEnumStringArg<T extends string>(
  args: Record<string, unknown>,
  allowed: readonly T[],
  ...keys: string[]
): T | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value.trim())) return value.trim() as T
  }
  return undefined
}

function optionalBoolArg(args: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'boolean') return value
  }
  return undefined
}

// ===== JSON Schema 工具定义（fork 自 Run mcp.ts，纯 JSON Schema 无 zod） =====

interface ToolDefinition {
  name: 'generate_image' | 'generate_video' | 'generate_audio'
  description: string
  modality: MediaModality
  inputSchema: Record<string, unknown>
}

const IMAGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Detailed image prompt / edit instruction.' },
    referenceImagePaths: { type: 'array', items: { type: 'string' }, description: 'Local file paths of reference images to edit (for editing or multi-turn).' },
    size: { type: 'string', description: 'Output size WIDTHxHEIGHT, e.g. 1024x1024.' },
    numberOfImages: { type: 'number', description: 'How many images (1-4, default 1).' },
    quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: 'OpenAI Images only: quality level.' },
    outputFormat: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'OpenAI Images only: output format.' },
    outputCompression: { type: 'number', description: 'OpenAI Images only: compression 0-100, only for jpeg/webp.' },
    background: { type: 'string', enum: ['transparent', 'opaque', 'auto'], description: 'OpenAI Images only: background.' },
    moderation: { type: 'string', enum: ['auto', 'low'], description: 'OpenAI Images only: moderation strictness.' },
    negativePrompt: { type: 'string', description: 'Optional negative prompt (supported by DashScope/Stability/Kling/etc.).' },
    seed: { type: 'number', description: 'Optional random seed where supported.' },
    promptEnhance: { type: 'boolean', description: 'Enable/disable provider prompt enhancement where supported.' },
    watermark: { type: 'boolean', description: 'Enable/disable watermark where supported.' },
    stylePreset: { type: 'string', description: 'Stability AI style preset where supported.' },
    guidanceScale: { type: 'number', description: 'CFG/guidance scale where supported.' },
    aspectRatio: { type: 'string', enum: ['1:1', '16:9', '4:3', '9:16', '3:4'], description: 'Gemini only: output aspect ratio (default 1:1).' },
    imageSize: { type: 'string', enum: ['auto', '1K', '2K', '4K'], description: 'Gemini only: output resolution (default auto).' },
  },
  required: ['prompt'],
}

const VIDEO_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Description of the video to generate.' },
    duration: { type: 'number', description: 'Video duration in seconds (default 5).' },
    size: { type: 'string', description: 'Aspect ratio or resolution, e.g. 16:9 or 1280x720.' },
    referenceImagePaths: { type: 'array', items: { type: 'string' }, description: 'Optional local reference image paths for image-to-video.' },
    negativePrompt: { type: 'string', description: 'Optional negative prompt where supported.' },
    seed: { type: 'number', description: 'Optional random seed where supported.' },
    promptEnhance: { type: 'boolean', description: 'Enable/disable provider prompt enhancement where supported.' },
    watermark: { type: 'boolean', description: 'Enable/disable watermark where supported.' },
    resolution: { type: 'string', description: 'Provider-specific resolution, e.g. 720P, 1080P.' },
    fps: { type: 'number', description: 'Frames per second where supported.' },
    withAudio: { type: 'boolean', description: 'Generate video with AI audio where supported.' },
    frames: { type: 'number', description: 'Total output frames where supported.' },
    returnLastFrame: { type: 'boolean', description: 'Return last frame metadata where supported.' },
    cameraFixed: { type: 'boolean', description: 'Fix/disable camera motion where supported.' },
    mode: { type: 'string', description: 'Provider-specific generation mode, e.g. std/pro.' },
    guidanceScale: { type: 'number', description: 'CFG/guidance scale where supported.' },
  },
  required: ['prompt'],
}

const AUDIO_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Text to synthesize (for TTS/music), or description for music.' },
    task: { type: 'string', enum: ['tts', 'music', 'clone'], description: 'Audio task: tts (default), music, or clone.' },
    voice: { type: 'string', description: 'Voice ID/name for TTS. For clone, ignored (uses sample).' },
    instruction: { type: 'string', description: 'Optional voice style or emotion instruction.' },
    lyrics: { type: 'string', description: 'Lyrics for music generation.' },
    referencePaths: { type: 'array', items: { type: 'string' }, description: 'Sample audio path for voice cloning or music-cover reference.' },
    speed: { type: 'number', description: 'Speech speed where supported.' },
    volume: { type: 'number', description: 'Speech volume where supported.' },
    pitch: { type: 'number', description: 'Speech pitch where supported.' },
    audioFormat: { type: 'string', enum: ['mp3', 'wav', 'flac', 'pcm'], description: 'Output audio format where supported.' },
    instrumental: { type: 'boolean', description: 'MiniMax music: instrumental without vocals.' },
    lyricsOptimizer: { type: 'boolean', description: 'MiniMax music-2.6: auto-generate lyrics from prompt.' },
    musicOutputFormat: { type: 'string', enum: ['hex', 'url'], description: 'MiniMax music: response format.' },
    sampleRate: { type: 'number', description: 'MiniMax music audio_setting.sample_rate.' },
    bitrate: { type: 'number', description: 'MiniMax music audio_setting.bitrate.' },
  },
  required: ['text'],
}

// ===== Qwen3-TTS / MiniMax 音色提示文本（动态追加到 description） =====

const QWEN_TTS_VOICES =
  'Qwen3 available voices: Cherry (默认，阳光亲切)、Serena (温柔知性)、Chelsie (动漫女友)、Momo (活泼少女)、Vivian (傲娇可爱)、Maia (知性温柔)、Bella (元气少女)、Katerina (成熟女性)、Ethan (阳光男声)、Moon (俊朗男声)、Kai (磁性男声/朗诵)、Nofish、Ryan、Eldric Sage (老者)、Mochi、Vincent、Neil (新闻播音)、Jada (上海话女)、Dylan (北京话男)、Li (南京话男)、Marcus (陕西话男)、Roy (闽南语男)、Peter (天津话男)、Sunny (四川话女)、Eric (四川话男)、Rocky (粤语男)、Kiki (粤语女). Do not invent voices such as 中文女声/男声; use one of these IDs.'

// ===== 核心：解析某模态的运行配置 =====

interface ResolvedModality {
  config: ResolvedMediaConfig
  apiKey: string
}

/** 解析某模态的有效配置（复用引擎的 resolveEffectiveMediaCredentials / resolveMediaConfig） */
export function resolveModality(config: DuoConfig, modality: MediaModality): ResolvedModality | null {
  const mod = getModalityConfig(config, modality)
  if (!mod?.apiKey?.trim()) return null
  const credentials = resolveEffectiveMediaCredentials(toEngineCredentials(mod), modality)
  const resolved = resolveMediaConfig(credentials, modality)
  if (!resolved || !resolved.baseUrl.trim()) return null
  return { config: resolved, apiKey: credentials.apiKey }
}

// ===== 描述文本构造 =====

function buildImageDescription(config: DuoConfig): string {
  let desc = 'Generate or edit images using AI. Supports multiple mainstream models (OpenAI gpt-image, Google Gemini/nano-banana, Doubao Seedream, Zhipu GLM-Image/CogView, MiniMax, Tongyi Wanx, Qwen-Image). Supports text-to-image, reference-image editing, and multi-turn iterative refinement. Generated images are saved to the working directory.'
  // 当配置的是 Gemini 时，补充专属参数说明（English prompts 最佳）
  try {
    const resolved = resolveModality(config, 'image')
    if (resolved && resolved.config.protocol === 'gemini-generate-content') {
      desc += '\n\nCurrently using Gemini (Nano Banana): use English prompts for best results. Supports aspectRatio (1:1/16:9/4:3/9:16/3:4) and imageSize (auto/1K/2K/4K).'
    }
  } catch {
    // 解析失败时静默，用基础描述
  }
  return desc
}

function buildVideoDescription(): string {
  return 'Generate videos from a text prompt. Supports mainstream models (Zhipu CogVideoX, Doubao Seedance, Kling, MiniMax video, Tongyi Wanx, Qwen HappyHorse). Video generation is asynchronous and may take 1-5 minutes. Generated videos are saved to the working directory.'
}

function buildAudioDescription(config: DuoConfig): string {
  let desc = 'Generate audio from text. Supports TTS (CosyVoice, GLM-TTS, MiniMax speech), music generation (MiniMax music), and voice cloning. Generated audio is saved to the working directory.'
  try {
    const resolved = resolveModality(config, 'audio')
    if (resolved) {
      if (resolved.config.protocol === 'dashscope-sync' && resolved.config.model.startsWith('qwen3-tts')) {
        desc += `\n\n${QWEN_TTS_VOICES}`
      } else if (resolved.config.protocol === 'minimax' || resolved.config.protocol === 'minimax-tts-async') {
        desc += `\n\n${MINIMAX_VOICES}`
      }
    }
  } catch {
    // 解析失败时静默，用基础描述
  }
  return desc
}

// ===== 核心执行 =====

/** 工具执行上下文（对应 Run 的 MediaGenerationMcpContext，但用 sessionId 字符串即可） */
export interface ToolContext {
  /** 会话标识，用于多轮续接的内存缓存 key */
  sessionId?: string
  /** 生成物输出根目录 */
  outputDir: string
}

/**
 * 执行一次媒体生成（对应 Run 的 runMediaGeneration）。
 * 返回 MCP content 块数组。
 */
export async function runGeneration(
  modality: MediaModality,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: McpContent[] }> {
  const config = loadConfig()
  const resolved = resolveModality(config, modality)
  if (!resolved) {
    const modalityName = modality === 'image' ? '图片' : modality === 'video' ? '视频' : '音频'
    throw new Error(
      `${modalityName}生成未配置好。请在 WebUI（duo-mcp --webui）中为该模态填写 API Key 并选择模型后重试。配置文件：${getConfigPath()}`,
    )
  }

  const sessionId = ctx.sessionId ?? `duo-${modality}`

  // prompt / text 参数
  const prompt = typeof (args.prompt ?? args.text) === 'string' ? String(args.prompt ?? args.text) : ''
  if (!prompt.trim()) throw new Error('缺少 prompt/text 参数')

  // 参考文件（图像编辑 / 声音克隆样本）
  const refKey = modality === 'audio' ? 'referencePaths' : 'referenceImagePaths'
  let referencePaths = Array.isArray(args[refKey])
    ? (args[refKey] as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined

  // 多轮兜底：图像/视频若有上一轮生成物且支持编辑，自动续接。
  // 注意：Gemini（gemini-generate-content）有自己的内存多轮历史（geminiSessionHistory），
  // 靠 thoughtSignature 续接，不能再用落盘回喂——否则上一轮图会在历史 model turn 和当前
  // user 前导 part 重复出现两次，导致模型混淆。故对 Gemini 协议跳过此兜底。
  if (
    (!referencePaths || referencePaths.length === 0)
    && resolved.config.supportsEdit
    && modality !== 'audio'
    && resolved.config.protocol !== 'gemini-generate-content'
  ) {
    const last = getLastGenerated(modality, sessionId)
    if (last) referencePaths = [last]
  }
  const isEdit = !!(referencePaths && referencePaths.length > 0)

  const { images: generated } = await generateMedia({
    modality,
    prompt,
    config: resolved.config,
    apiKey: resolved.apiKey,
    size: optionalStringArg(args, 'size'),
    numberOfImages: optionalNumberArg(args, 'numberOfImages'),
    duration: optionalNumberArg(args, 'duration'),
    referencePaths,
    isEdit,
    quality: optionalEnumStringArg(args, ['low', 'medium', 'high', 'auto'] as const, 'quality'),
    outputFormat: optionalEnumStringArg(args, ['png', 'jpeg', 'webp'] as const, 'outputFormat', 'output_format'),
    outputCompression: optionalNumberArg(args, 'outputCompression', 'output_compression'),
    background: optionalEnumStringArg(args, ['transparent', 'opaque', 'auto'] as const, 'background'),
    moderation: optionalEnumStringArg(args, ['auto', 'low'] as const, 'moderation'),
    // Gemini（nano-banana）专属参数
    aspectRatio: optionalEnumStringArg(args, ['1:1', '16:9', '4:3', '9:16', '3:4'] as const, 'aspectRatio', 'aspect_ratio'),
    imageSize: optionalEnumStringArg(args, ['auto', '1K', '2K', '4K'] as const, 'imageSize', 'image_size'),
    negativePrompt: optionalStringArg(args, 'negativePrompt', 'negative_prompt'),
    seed: optionalNumberArg(args, 'seed'),
    promptEnhance: optionalBoolArg(args, 'promptEnhance', 'prompt_enhance'),
    watermark: optionalBoolArg(args, 'watermark'),
    resolution: optionalStringArg(args, 'resolution'),
    fps: optionalNumberArg(args, 'fps'),
    withAudio: optionalBoolArg(args, 'withAudio', 'with_audio'),
    frames: optionalNumberArg(args, 'frames'),
    returnLastFrame: optionalBoolArg(args, 'returnLastFrame', 'return_last_frame'),
    cameraFixed: optionalBoolArg(args, 'cameraFixed', 'camera_fixed'),
    mode: optionalStringArg(args, 'mode'),
    guidanceScale: optionalNumberArg(args, 'guidanceScale', 'cfgScale', 'cfg_scale'),
    stylePreset: optionalStringArg(args, 'stylePreset', 'style_preset'),
    speed: optionalNumberArg(args, 'speed'),
    volume: optionalNumberArg(args, 'volume', 'vol'),
    pitch: optionalNumberArg(args, 'pitch'),
    audioFormat: optionalEnumStringArg(args, ['mp3', 'wav', 'flac', 'pcm'] as const, 'audioFormat', 'audio_format'),
    instruction: optionalStringArg(args, 'instruction'),
    audioTask: typeof args.task === 'string' ? (args.task as 'tts' | 'music' | 'clone') : undefined,
    voice: optionalStringArg(args, 'voice'),
    lyrics: optionalStringArg(args, 'lyrics'),
    instrumental: optionalBoolArg(args, 'instrumental', 'isInstrumental'),
    lyricsOptimizer: optionalBoolArg(args, 'lyricsOptimizer', 'lyrics_optimizer'),
    musicOutputFormat: optionalEnumStringArg(args, ['hex', 'url'] as const, 'musicOutputFormat', 'outputFormat', 'output_format'),
    sampleRate: optionalNumberArg(args, 'sampleRate', 'sample_rate'),
    bitrate: optionalNumberArg(args, 'bitrate'),
    cwd: ctx.outputDir,
    sessionId,
  })

  // 仅图像走数量裁剪
  const selected = modality === 'image'
    ? selectGeneratedImagesForImageRequest(generated, { userMessage: prompt, defaultCount: typeof args.numberOfImages === 'number' ? args.numberOfImages : 1 })
    : generated

  const modalityLabel = modality === 'image' ? '图片' : modality === 'video' ? '视频' : '音频'
  const outDir = resolve(ctx.outputDir, 'generated-media')
  const { content, savedPaths } = persistGenerated(selected, modalityLabel, { outputDir: outDir })

  // 多轮：缓存首项路径
  if (savedPaths.length > 0) setLastGenerated(modality, sessionId, savedPaths[0]!)

  return { content }
}

// ===== 创建 MCP Server（底层 Server API + JSON Schema） =====

/**
 * 创建并配置 Server，按已配置好的模态动态构建工具列表。
 *
 * @param outputDirOverride 可选输出目录覆盖（默认用 config.outputDir 或 getDefaultOutputDir()）
 */
export function createMcpServer(outputDirOverride?: string): Server {
  const config = loadConfig()
  const outputDir = resolve(outputDirOverride || config.outputDir || getDefaultOutputDir())

  // 候选工具列表（按已配置好的模态过滤）
  const candidates: ToolDefinition[] = [
    { name: 'generate_image', description: buildImageDescription(config), modality: 'image', inputSchema: IMAGE_SCHEMA },
    { name: 'generate_video', description: buildVideoDescription(), modality: 'video', inputSchema: VIDEO_SCHEMA },
    { name: 'generate_audio', description: buildAudioDescription(config), modality: 'audio', inputSchema: AUDIO_SCHEMA },
  ]

  const tools = candidates.filter((def) => isModalityReady(config, def.modality))

  const server = new Server(
    { name: 'duo-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  // 列出工具
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
    })),
  }))

  // 调用工具（失败软降级：返回 isError 文本而非抛异常，与 Run 一致）
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    const def = tools.find((t) => t.name === toolName)
    if (!def) {
      return {
        content: [{ type: 'text', text: `未知工具: ${toolName}` }],
        isError: true,
      }
    }
    try {
      const { content } = await runGeneration(def.modality, args, { outputDir })
      return { content }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const label = def.modality === 'image' ? '图片' : def.modality === 'video' ? '视频' : '音频'
      return {
        content: [{ type: 'text', text: `${label}生成失败: ${msg}` }],
        isError: true,
      }
    }
  })

  return server
}

/** 连接 server 到 stdio transport（供 CLI 入口调用） */
export async function connectStdio(server: Server): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  return transport
}

// 重新导出常用项，供 WebUI / CLI 复用
export { loadConfig, getConfigPath, getDefaultOutputDir, MEDIA_MODEL_PRESETS, getPresetsByModality }
