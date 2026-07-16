/**
 * 多模态生成引擎（media-generation）
 *
 * 统一的图像 / 视频 / 音频生成内核，按「模态 × 协议族」双重分派。
 *
 * 协议族：
 * - openai-images：OpenAI gpt-image、豆包 Seedream、智谱 GLM-Image/CogView（图，同步）
 * - gemini-generate-content：Google Gemini（nano-banana / Gemini Image，图，多轮编辑）
 * - dashscope-async：万相 / Qwen / Vidu / HappyHorse（图、视频，异步轮询）
 * - dashscope-sync：CosyVoice TTS（音频，同步）
 * - dashscope-voice-clone：CosyVoice 声音复刻（音频，两步）
 * - volcengine-async：豆包 Seedance（视频，异步）
 * - kling-async：可灵（视频，异步）
 * - zhipu-async：智谱 CogVideoX（视频异步）、GLM-TTS（音频同步）、GLM-TTS-Clone（音频两步）
 * - minimax：MiniMax（图/视频/音频/音乐）
 * - minimax-tts-async：MiniMax 异步长文本语音合成（音频异步）
 * - minimax-voice-clone：MiniMax 声音复刻（音频，两步）
 *
 * bug 修复（复查 M1-M6）：
 * - M1：万相 size 用 "*" 分隔（W*H），而非前缀星号
 * - M2：万相编辑能力不实（需公网 URL 上传），supportsEdit=false
 * - M5：非 JSON 200 响应给出 HTTP 上下文而非 SyntaxError
 * - M6：MiniMax 透传 n
 */

import { readFileSync, realpathSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { createHmac, randomUUID } from 'node:crypto'
import {
  isGoogleVertexJsonCredential,
  buildGoogleGenerateContentRequestTarget,
  buildGooglePredictLongRunningRequestTarget,
  buildGoogleInteractionsRequestTarget,
} from './google-auth.js'

// ===== 模态与协议族 =====

/**
 * 生成产物（从 RunAI 的 @run/core 内联而来，结构极简）。
 * - mediaType: MIME 类型，如 'image/png' / 'audio/wav' / 'video/mp4'
 * - data: base64 编码的媒体内容
 */
export interface GeneratedImageData {
  mediaType: string
  data: string
}

export type MediaModality = 'image' | 'video' | 'audio'

export type MediaProtocol =
  | 'openai-images'
  | 'dashscope-async'
  | 'dashscope-sync'
  | 'dashscope-voice-clone'
  | 'volcengine-async'
  | 'volcengine-tts'
  | 'volcengine-plan-tts'
  | 'kling-async'
  | 'zhipu-async'
  | 'minimax'
  | 'minimax-tts-async'
  | 'minimax-voice-clone'
  | 'stability'
  | 'tencent-hunyuan-async'
  | 'midjourney'
  | 'gemini-generate-content'
  | 'google-interactions'

// ===== 模型预设 =====

export interface MediaModelPreset {
  id: string
  label: string
  vendor: string
  modality: MediaModality
  protocol: MediaProtocol
  baseUrl: string
  model: string
  /** 编辑模型（文生图/编辑分离的厂商） */
  editModel?: string
  supportsEdit: boolean
  defaultSize: string
  /** 音频子任务：tts | music | clone */
  audioTask?: 'tts' | 'music' | 'clone'
  helpUrl?: string
}

/**
 * 国内外主流多模态模型预设。新增模型只需在此追加一条。
 */
export const MEDIA_MODEL_PRESETS: MediaModelPreset[] = [
  // ===== 图像 =====
  {
    id: 'openai-gpt-image-2', label: 'OpenAI · gpt-image-2', vendor: 'OpenAI',
    modality: 'image', protocol: 'openai-images', baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-2', supportsEdit: true, defaultSize: '1024x1024',
    helpUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openai-gpt-image-1', label: 'OpenAI · gpt-image-1', vendor: 'OpenAI',
    modality: 'image', protocol: 'openai-images', baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-1', supportsEdit: true, defaultSize: '1024x1024',
    helpUrl: 'https://platform.openai.com/api-keys',
  },
  // ===== 图像：Google Gemini（nano-banana / Gemini Image，原生多轮编辑） =====
  {
    id: 'gemini-flash-image', label: 'Gemini · Flash Image (nano-banana)', vendor: 'Google Gemini',
    modality: 'image', protocol: 'gemini-generate-content',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-3.1-flash-image', supportsEdit: true, defaultSize: '1:1',
    helpUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'gemini-pro-image', label: 'Gemini · Pro Image', vendor: 'Google Gemini',
    modality: 'image', protocol: 'gemini-generate-content',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-3.1-pro-image', supportsEdit: true, defaultSize: '1:1',
    helpUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'gemini-flash-lite-image', label: 'Gemini · Flash Lite Image (nano-banana 2 lite)', vendor: 'Google Gemini',
    modality: 'image', protocol: 'gemini-generate-content',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-3.1-flash-lite-image', supportsEdit: true, defaultSize: '1:1',
    helpUrl: 'https://aistudio.google.com/apikey',
  },
  // ===== 图像：Google Cloud（Vertex AI） =====
  {
    id: 'google-vertex-flash-image', label: 'Vertex · Flash Image', vendor: 'Google Cloud Service (Vertex)',
    modality: 'image', protocol: 'gemini-generate-content',
    baseUrl: 'https://aiplatform.googleapis.com',
    model: 'gemini-3.1-flash-image', supportsEdit: true, defaultSize: '1:1',
    helpUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/start/quickstarts/quickstart-multimodal',
  },
  {
    id: 'google-vertex-pro-image', label: 'Vertex · Pro Image', vendor: 'Google Cloud Service (Vertex)',
    modality: 'image', protocol: 'gemini-generate-content',
    baseUrl: 'https://aiplatform.googleapis.com',
    model: 'gemini-3.1-pro-image', supportsEdit: true, defaultSize: '1:1',
    helpUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/start/quickstarts/quickstart-multimodal',
  },
  {
    id: 'google-vertex-flash-lite-image', label: 'Vertex · Flash Lite Image', vendor: 'Google Cloud Service (Vertex)',
    modality: 'image', protocol: 'gemini-generate-content',
    baseUrl: 'https://aiplatform.googleapis.com',
    model: 'gemini-3.1-flash-lite-image', supportsEdit: true, defaultSize: '1:1',
    helpUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/start/quickstarts/quickstart-multimodal',
  },
  {
    id: 'doubao-seedream-5-pro', label: '豆包 · Seedream 5.0 Pro（火山方舟）', vendor: '火山 API',
    modality: 'image', protocol: 'openai-images', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-5-0-pro-260628', supportsEdit: true, defaultSize: '2048x2048',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'doubao-seedream-5-lite', label: '豆包 · Seedream 5.0 Lite（火山方舟）', vendor: '火山 API',
    modality: 'image', protocol: 'openai-images', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-5-0-lite-260214', supportsEdit: true, defaultSize: '2048x2048',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'doubao-seedream-5-lite-agent-plan', label: '豆包 · Seedream 5.0 Lite（Agent Plan）', vendor: '火山 Agent Plan',
    modality: 'image', protocol: 'openai-images', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    model: 'doubao-seedream-5-0-lite', supportsEdit: true, defaultSize: '2048x2048',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?advancedActiveKey=agentPlan',
  },
  {
    id: 'doubao-seedream-5', label: '豆包 · Seedream 5.0（火山方舟）', vendor: '火山 API',
    modality: 'image', protocol: 'openai-images', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-5-0-260128', supportsEdit: true, defaultSize: '2048x2048',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'doubao-seedream-4-5', label: '豆包 · Seedream 4.5（火山方舟）', vendor: '火山 API',
    modality: 'image', protocol: 'openai-images', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-4-5-251128', supportsEdit: true, defaultSize: '2048x2048',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'doubao-seedream-4', label: '豆包 · Seedream 4.0（火山方舟）', vendor: '火山 API',
    modality: 'image', protocol: 'openai-images', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-4-0-250828', supportsEdit: true, defaultSize: '2048x2048',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'doubao-seedream', label: '豆包 · Seedream 3.0（火山方舟）', vendor: '火山 API',
    modality: 'image', protocol: 'openai-images', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-3-0-t2m-250415', supportsEdit: true, defaultSize: '1024x1024',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'zhipu-glm-image', label: '智谱 · GLM-Image', vendor: '智谱',
    modality: 'image', protocol: 'openai-images', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-image', supportsEdit: false, defaultSize: '1280x1280',
    helpUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'zhipu-cogview-4', label: '智谱 · CogView-4', vendor: '智谱',
    modality: 'image', protocol: 'openai-images', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'cogview-4', supportsEdit: false, defaultSize: '1024x1024',
    helpUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'minimax-image-01', label: 'MiniMax · image-01（海螺）', vendor: 'MiniMax',
    modality: 'image', protocol: 'minimax', baseUrl: 'https://api.minimaxi.com/v1',
    model: 'image-01', supportsEdit: true, defaultSize: '1024x1024',
    helpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  },
  {
    id: 'qwen-image-2-pro', label: 'Qwen · qwen-image-2.0-pro', vendor: 'Qwen',
    modality: 'image', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'qwen-image-2.0-pro', supportsEdit: true, defaultSize: '2048*2048',
    helpUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'qwen-image', label: 'Qwen · Qwen-Image（通义千问）', vendor: 'Qwen',
    modality: 'image', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'qwen-image', editModel: 'qwen-image-edit', supportsEdit: true, defaultSize: '1328*1328',
    helpUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'qwen-image-max', label: 'Qwen · qwen-image-max', vendor: 'Qwen',
    modality: 'image', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'qwen-image-max', supportsEdit: false, defaultSize: '1328*1328',
    helpUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'qwen-image-plus', label: 'Qwen · qwen-image-plus', vendor: 'Qwen',
    modality: 'image', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'qwen-image-plus', supportsEdit: false, defaultSize: '1328*1328',
    helpUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'wanx-2-1-turbo', label: '万相 · wanx2.1-t2i-turbo', vendor: '万相',
    modality: 'image', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'wanx2.1-t2i-turbo', supportsEdit: false, defaultSize: '1024*1024',
    helpUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'wanx-2-1-plus', label: '万相 · wanx2.1-t2i-plus', vendor: '万相',
    modality: 'image', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'wanx2.1-t2i-plus', supportsEdit: false, defaultSize: '1024*1024',
    helpUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'stability-sdxl', label: 'Stability AI · SDXL', vendor: 'Stability',
    modality: 'image', protocol: 'stability', baseUrl: 'https://api.stability.ai/v2beta/stable-image/generate',
    model: 'sdxl', supportsEdit: false, defaultSize: '1:1',
    helpUrl: 'https://platform.stability.ai/account/keys',
  },
  {
    id: 'stability-sd3', label: 'Stability AI · SD3.5 Large', vendor: 'Stability',
    modality: 'image', protocol: 'stability', baseUrl: 'https://api.stability.ai/v2beta/stable-image/generate',
    model: 'sd3', supportsEdit: false, defaultSize: '1:1',
    helpUrl: 'https://platform.stability.ai/account/keys',
  },
  {
    id: 'stability-ultra', label: 'Stability AI · Stable Image Ultra', vendor: 'Stability',
    modality: 'image', protocol: 'stability', baseUrl: 'https://api.stability.ai/v2beta/stable-image/generate',
    model: 'ultra', supportsEdit: false, defaultSize: '1:1',
    helpUrl: 'https://platform.stability.ai/account/keys',
  },
  {
    id: 'tencent-hunyuan-image-v3', label: '腾讯混元 · HY-Image-3.0', vendor: '腾讯',
    modality: 'image', protocol: 'tencent-hunyuan-async', baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    model: 'hy-image-v3.0', supportsEdit: false, defaultSize: '1024x1024',
    helpUrl: 'https://tokenhub.tencentmaas.com',
  },
  {
    id: 'tencent-hunyuan-image-lite', label: '腾讯混元 · HY-Image-Lite', vendor: '腾讯',
    modality: 'image', protocol: 'tencent-hunyuan-async', baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    model: 'hy-image-lite', supportsEdit: false, defaultSize: '1024x1024',
    helpUrl: 'https://tokenhub.tencentmaas.com',
  },
  {
    id: 'midjourney', label: 'Midjourney · MJ（第三方网关）', vendor: 'Midjourney',
    modality: 'image', protocol: 'midjourney', baseUrl: '',
    // baseUrl 由用户填入第三方 MJ 网关地址（如 https://your-gateway.com）；
    // 协议遵循 midjourney-proxy 标准：/mj/submit/imagine + /mj/task/{id}/fetch
    model: 'midjourney', supportsEdit: false, defaultSize: '1:1',
    helpUrl: 'https://github.com/trueai-org/midjourney-proxy',
  },

  // ===== 视频 =====
  {
    id: 'doubao-seedance-2', label: '豆包 · Seedance 2.0（火山方舟）', vendor: '火山 API',
    modality: 'video', protocol: 'volcengine-async', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedance-2-0-260128', supportsEdit: false, defaultSize: '1920x1080',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'doubao-seedance-2-fast', label: '豆包 · Seedance 2.0 Fast（火山方舟）', vendor: '火山 API',
    modality: 'video', protocol: 'volcengine-async', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedance-2-0-fast-260128', supportsEdit: false, defaultSize: '1920x1080',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'doubao-seedance-2-mini', label: '豆包 · Seedance 2.0 Mini（火山方舟）', vendor: '火山 API',
    modality: 'video', protocol: 'volcengine-async', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedance-2-0-mini-260615', supportsEdit: false, defaultSize: '1280x720',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'doubao-seedance-2-agent-plan', label: '豆包 · Seedance 2.0（Agent Plan）', vendor: '火山 Agent Plan',
    modality: 'video', protocol: 'volcengine-async', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    model: 'doubao-seedance-2-0', supportsEdit: false, defaultSize: '1920x1080',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?advancedActiveKey=agentPlan',
  },
  {
    id: 'doubao-seedance-2-fast-agent-plan', label: '豆包 · Seedance 2.0 Fast（Agent Plan）', vendor: '火山 Agent Plan',
    modality: 'video', protocol: 'volcengine-async', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    model: 'doubao-seedance-2-0-fast', supportsEdit: false, defaultSize: '1920x1080',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?advancedActiveKey=agentPlan',
  },
  {
    id: 'doubao-seedance-2-mini-agent-plan', label: '豆包 · Seedance 2.0 Mini（Agent Plan）', vendor: '火山 Agent Plan',
    modality: 'video', protocol: 'volcengine-async', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    model: 'doubao-seedance-2-0-mini', supportsEdit: false, defaultSize: '1280x720',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?advancedActiveKey=agentPlan',
  },
  {
    id: 'doubao-seedance-1-5-pro', label: '豆包 · Seedance 1.5 Pro（火山方舟）', vendor: '火山 API',
    modality: 'video', protocol: 'volcengine-async', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedance-1-5-pro-251215', supportsEdit: false, defaultSize: '1920x1080',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'zhipu-cogvideox-3', label: '智谱 · CogVideoX-3', vendor: '智谱',
    modality: 'video', protocol: 'zhipu-async', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'cogvideox-3', supportsEdit: false, defaultSize: '1920x1080',
    helpUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'zhipu-cogvideox-flash', label: '智谱 · CogVideoX-Flash', vendor: '智谱',
    modality: 'video', protocol: 'zhipu-async', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'cogvideox-flash', supportsEdit: false, defaultSize: '1920x1080',
    helpUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'zhipu-cogvideox-2', label: '智谱 · CogVideoX-2', vendor: '智谱',
    modality: 'video', protocol: 'zhipu-async', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'cogvideox-2', supportsEdit: false, defaultSize: '1920x1080',
    helpUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'doubao-seedance', label: '豆包 · Seedance（火山方舟）', vendor: '火山 API',
    modality: 'video', protocol: 'volcengine-async', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-Seedance-1-0-pro-t2v-250428', supportsEdit: false, defaultSize: '1280x720',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'kling-v2', label: '可灵 · kling-v2', vendor: '可灵',
    modality: 'video', protocol: 'kling-async', baseUrl: 'https://api.klingai.com',
    model: 'kling-v2', supportsEdit: false, defaultSize: '16:9',
    helpUrl: 'https://klingai.com/document-api',
  },
  {
    id: 'minimax-video-01', label: 'MiniMax · video-01（海螺）', vendor: 'MiniMax',
    modality: 'video', protocol: 'minimax', baseUrl: 'https://api.minimaxi.com/v1',
    model: 'video-01', supportsEdit: false, defaultSize: '16:9',
    helpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  },
  {
    id: 'minimax-video-hailuo-2.3', label: 'MiniMax · Hailuo-2.3（海螺）', vendor: 'MiniMax',
    modality: 'video', protocol: 'minimax', baseUrl: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-Hailuo-2.3', supportsEdit: false, defaultSize: '16:9',
    helpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  },
  {
    id: 'wanx-2-7-t2v', label: '万相 · wan2.7（智能路由）', vendor: '万相',
    modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'wan2.7-t2v', supportsEdit: false, defaultSize: '1280*720',
    helpUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'wanx-2-7-videoedit', label: '万相 · wan2.7-videoedit（视频编辑）', vendor: '万相',
    modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'wan2.7-videoedit', supportsEdit: true, defaultSize: '1280*720',
    helpUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'qwen-happyhorse', label: 'Qwen · happyhorse-1.1（智能路由）', vendor: 'Qwen',
    modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'happyhorse-1.1-t2v', supportsEdit: false, defaultSize: '1280*720',
    helpUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'tencent-hunyuan-video-v1.5', label: '腾讯混元 · HY-Video-1.5', vendor: '腾讯',
    modality: 'video', protocol: 'tencent-hunyuan-async', baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    model: 'hy-video-1.5', supportsEdit: false, defaultSize: '1280x720',
    helpUrl: 'https://tokenhub.tencentmaas.com',
  },
  {
    id: 'google-veo-31', label: 'Google · Veo 3.1', vendor: 'Google Gemini',
    modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'veo-3.1-generate-preview', supportsEdit: false, defaultSize: '16:9',
    helpUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'google-veo-31-fast', label: 'Google · Veo 3.1 Fast', vendor: 'Google Gemini',
    modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'veo-3.1-fast-generate-preview', supportsEdit: false, defaultSize: '16:9',
    helpUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'google-veo-31-lite', label: 'Google · Veo 3.1 Lite', vendor: 'Google Gemini',
    modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'veo-3.1-lite-generate-preview', supportsEdit: false, defaultSize: '16:9',
    helpUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'google-omni-flash', label: 'Google · Gemini Omni Flash', vendor: 'Google Gemini',
    modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-omni-flash-preview', supportsEdit: false, defaultSize: '16:9',
    helpUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'google-vertex-omni-flash', label: 'Vertex · Gemini Omni Flash', vendor: 'Google Cloud Service (Vertex)',
    modality: 'video', protocol: 'google-interactions', baseUrl: 'https://aiplatform.googleapis.com',
    model: 'gemini-omni-flash-preview', supportsEdit: false, defaultSize: '16:9',
    helpUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/start/quickstarts/quickstart-multimodal',
  },

  // ===== 音频 =====
  {
    id: 'zhipu-glm-tts', label: '智谱 · GLM-TTS', vendor: '智谱',
    modality: 'audio', protocol: 'zhipu-async', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-tts', supportsEdit: false, defaultSize: '', audioTask: 'tts',
    helpUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'zhipu-glm-tts-clone', label: '智谱 · GLM-TTS-Clone（声音复刻）', vendor: '智谱',
    modality: 'audio', protocol: 'zhipu-async', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-tts-clone', supportsEdit: false, defaultSize: '', audioTask: 'clone',
    helpUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'dashscope-cosyvoice', label: '阿里 · CosyVoice', vendor: '阿里',
    modality: 'audio', protocol: 'dashscope-sync', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'cosyvoice-v3.5-plus', supportsEdit: false, defaultSize: '', audioTask: 'tts',
    helpUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'qwen3-tts-flash', label: 'Qwen · Qwen3-TTS-Flash', vendor: 'Qwen',
    modality: 'audio', protocol: 'dashscope-sync', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'qwen3-tts-flash', supportsEdit: false, defaultSize: '', audioTask: 'tts',
    helpUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'qwen3-tts-instruct-flash', label: 'Qwen · Qwen3-TTS-Instruct-Flash', vendor: 'Qwen',
    modality: 'audio', protocol: 'dashscope-sync', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'qwen3-tts-instruct-flash', supportsEdit: false, defaultSize: '', audioTask: 'tts',
    helpUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'qwen3-tts-vd-2026-01-26', label: 'Qwen · Qwen3-TTS-VD-2026-01-26', vendor: 'Qwen',
    modality: 'audio', protocol: 'dashscope-sync', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'qwen3-tts-vd-2026-01-26', supportsEdit: false, defaultSize: '', audioTask: 'tts',
    helpUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'minimax-speech-02', label: 'MiniMax · speech-02-hd（TTS）', vendor: 'MiniMax',
    modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimaxi.com/v1',
    model: 'speech-02-hd', supportsEdit: false, defaultSize: '', audioTask: 'tts',
    helpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  },
  {
    id: 'minimax-speech-async', label: 'MiniMax · 异步长文本 TTS', vendor: 'MiniMax',
    modality: 'audio', protocol: 'minimax-tts-async', baseUrl: 'https://api.minimaxi.com/v1',
    model: 'speech-2.8-hd', supportsEdit: false, defaultSize: '', audioTask: 'tts',
    helpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  },
  {
    id: 'minimax-music', label: 'MiniMax · music-2.6（音乐生成）', vendor: 'MiniMax',
    modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimaxi.com/v1',
    model: 'music-2.6', supportsEdit: false, defaultSize: '', audioTask: 'music',
    helpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  },
  {
    id: 'minimax-music-free', label: 'MiniMax · music-2.6-free（音乐生成）', vendor: 'MiniMax',
    modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimaxi.com/v1',
    model: 'music-2.6-free', supportsEdit: false, defaultSize: '', audioTask: 'music',
    helpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  },
  {
    id: 'minimax-music-cover', label: 'MiniMax · music-cover（翻唱）', vendor: 'MiniMax',
    modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimaxi.com/v1',
    model: 'music-cover', supportsEdit: false, defaultSize: '', audioTask: 'music',
    helpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  },
  {
    id: 'minimax-music-cover-free', label: 'MiniMax · music-cover-free（翻唱）', vendor: 'MiniMax',
    modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimaxi.com/v1',
    model: 'music-cover-free', supportsEdit: false, defaultSize: '', audioTask: 'music',
    helpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  },
  {
    id: 'minimax-voice-clone', label: 'MiniMax · 声音复刻', vendor: 'MiniMax',
    modality: 'audio', protocol: 'minimax-voice-clone', baseUrl: 'https://api.minimaxi.com/v1',
    model: 'speech-02-hd-clone', supportsEdit: false, defaultSize: '', audioTask: 'clone',
    helpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  },
  {
    id: 'doubao-seed-audio', label: '豆包 · Seed Audio 1.0（火山语音）', vendor: '火山语音',
    modality: 'audio', protocol: 'volcengine-tts', baseUrl: 'https://openspeech.bytedance.com',
    model: 'seed-audio-1.0', supportsEdit: false, defaultSize: '', audioTask: 'tts',
    helpUrl: 'https://console.volcengine.com/speech/new/setting/apikeys',
  },
  {
    id: 'doubao-seed-tts-2-agent-plan', label: '豆包 · Seed TTS 2.0（Agent Plan）', vendor: '火山 Agent Plan',
    modality: 'audio', protocol: 'volcengine-plan-tts', baseUrl: 'https://openspeech.bytedance.com',
    model: 'doubao-seed-tts-2.0', supportsEdit: false, defaultSize: '', audioTask: 'tts',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?advancedActiveKey=agentPlan',
  },
]

export const CUSTOM_MEDIA_PRESET_ID = 'custom'

/** 按模态过滤预设（供 UI 下拉分组） */
export function getPresetsByModality(modality: MediaModality): MediaModelPreset[] {
  return MEDIA_MODEL_PRESETS.filter((p) => p.modality === modality)
}

// ===== 配置解析 =====

export interface ResolvedMediaConfig {
  preset: MediaModelPreset | null
  presetId?: string
  modality: MediaModality
  protocol: MediaProtocol
  baseUrl: string
  model: string
  editModel?: string
  supportsEdit: boolean
  audioTask?: 'tts' | 'music' | 'clone'
}

export function findPresetByModel(model: string, modality?: MediaModality): MediaModelPreset | undefined {
  return MEDIA_MODEL_PRESETS.find((p) => p.model === model && (modality === undefined || p.modality === modality))
}

function parseCredentialStringMap(value?: string): Record<string, string> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return {}
  }
}

const AUDIO_CHANNEL_DEFAULTS: Record<string, Pick<MediaModelPreset, 'protocol' | 'baseUrl' | 'audioTask'> & { model: string }> = {
  'qwen-tts': {
    protocol: 'dashscope-sync',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'qwen3-tts-flash',
    audioTask: 'tts',
  },
  'zhipu-tts': {
    protocol: 'zhipu-async',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-tts',
    audioTask: 'tts',
  },
  'dashscope-cosyvoice': {
    protocol: 'dashscope-sync',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'cosyvoice-v3.5-plus',
    audioTask: 'tts',
  },
  'minimax-tts': {
    protocol: 'minimax',
    baseUrl: 'https://api.minimaxi.com/v1',
    model: 'speech-2.8-hd',
    audioTask: 'tts',
  },
  'doubao-seed-audio': {
    protocol: 'volcengine-tts',
    baseUrl: 'https://openspeech.bytedance.com',
    model: 'seed-audio-1.0',
    audioTask: 'tts',
  },
  'doubao-seed-tts-2-agent-plan': {
    protocol: 'volcengine-plan-tts',
    baseUrl: 'https://openspeech.bytedance.com',
    model: 'doubao-seed-tts-2.0',
    audioTask: 'tts',
  },
}

const LEGACY_AUDIO_CHANNEL_IDS: Record<string, string> = {
  'minimax-clone': 'minimax-tts',
  'dashscope-cosyvoice-tts': 'dashscope-cosyvoice',
  'dashscope-cosyvoice-clone': 'dashscope-cosyvoice',
  'minimax-speech-02': 'minimax-tts',
  'minimax-speech-async': 'minimax-tts',
  'minimax-music': 'minimax-tts',
}

function isKnownAudioChannelId(value: string | undefined): boolean {
  return !!value && (value in AUDIO_CHANNEL_DEFAULTS || value === CUSTOM_MEDIA_PRESET_ID)
}

export function resolveEffectiveMediaCredentials(
  credentials: Record<string, string>,
  modality: MediaModality,
): Record<string, string> {
  if (modality !== 'audio') return credentials
  if (credentials.apiKey?.trim() && credentials.model?.trim()) return credentials

  const presetId = credentials.presetId?.trim()
  if (isKnownAudioChannelId(presetId)) return credentials

  const apiKeys = parseCredentialStringMap(credentials.apiKeyByPreset)
  const baseUrls = parseCredentialStringMap(credentials.baseUrlByPreset)
  const models = parseCredentialStringMap(credentials.modelByPreset)
  const fallbackChannelId = (presetId && LEGACY_AUDIO_CHANNEL_IDS[presetId] && apiKeys[LEGACY_AUDIO_CHANNEL_IDS[presetId]]?.trim())
    ? LEGACY_AUDIO_CHANNEL_IDS[presetId]
    : ['qwen-tts', 'zhipu-tts', 'dashscope-cosyvoice', 'minimax-tts'].find((id) => apiKeys[id]?.trim())
  if (!fallbackChannelId) return credentials

  const defaults = AUDIO_CHANNEL_DEFAULTS[fallbackChannelId]
  if (!defaults) return credentials

  return {
    ...credentials,
    apiKey: apiKeys[fallbackChannelId]?.trim() ?? '',
    baseUrl: baseUrls[fallbackChannelId]?.trim() || defaults.baseUrl,
    model: models[fallbackChannelId]?.trim() || defaults.model,
    protocol: defaults.protocol,
    presetId: fallbackChannelId,
    audioTask: defaults.audioTask ?? 'tts',
  }
}

function findPresetForCredentials(credentials: Record<string, string>, modality: MediaModality): MediaModelPreset | undefined {
  const presetId = credentials.presetId?.trim()
  if (presetId === CUSTOM_MEDIA_PRESET_ID) return undefined
  if (presetId && presetId !== CUSTOM_MEDIA_PRESET_ID) {
    const byId = MEDIA_MODEL_PRESETS.find((p) => p.id === presetId && p.modality === modality)
    if (byId && (!credentials.model?.trim() || byId.model === credentials.model.trim())) return byId
  }

  const model = credentials.model?.trim()
  if (!model) return undefined

  const protocol = credentials.protocol?.trim()
  if (protocol) {
    const byModelAndProtocol = MEDIA_MODEL_PRESETS.find((p) => (
      p.model === model && p.modality === modality && p.protocol === protocol
    ))
    if (byModelAndProtocol) return byModelAndProtocol
  }

  return findPresetByModel(model, modality)
}

/**
 * 从凭据解析运行配置。优先按 presetId，其次按 model+protocol 反查预设；未命中走自定义。
 */
export function resolveMediaConfig(
  credentials: Record<string, string>,
  modality: MediaModality,
): ResolvedMediaConfig | null {
  let model = credentials.model?.trim()
  if (!model) return null

  // 智能路由系列（HappyHorse / wan2.7）：旧配置可能存的是 i2v/r2v 变体，
  // 统一归一化为 t2v 基础模型——运行时由 resolveDashscopeVideoVariant 按参考图数量重新选择变体。
  // 这样预设解析（只认 t2v）能正常匹配，UI 下拉也能正确选中「智能路由」选项。
  if (modality === 'video') {
    const base = resolveDashscopeVideoVariant(model, 0)
    if (base) model = base
  }

  const matched = findPresetForCredentials({ ...credentials, model }, modality)
  if (matched) {
    return {
      preset: matched,
      presetId: matched.id,
      modality: matched.modality,
      protocol: (credentials.protocol?.trim() as MediaProtocol) || matched.protocol,
      baseUrl: credentials.baseUrl?.trim() || matched.baseUrl,
      model: matched.model,
      editModel: matched.editModel,
      supportsEdit: matched.supportsEdit,
      audioTask: matched.audioTask,
    }
  }

  // 自定义：凭据须带 protocol + modality；缺省协议按模态选择，避免视频/音频误落到生图协议。
  const defaultProtocolByModality: Record<MediaModality, MediaProtocol> = {
    image: 'openai-images',
    video: 'kling-async',
    audio: 'dashscope-sync',
  }
  const protocol = (credentials.protocol?.trim() as MediaProtocol) || defaultProtocolByModality[modality]
  return {
    preset: null,
    presetId: CUSTOM_MEDIA_PRESET_ID,
    modality,
    protocol,
    baseUrl: credentials.baseUrl?.trim() || '',
    model,
    editModel: credentials.editModel?.trim() || undefined,
    // 自定义模型的编辑能力仅对图像模态自动开启；视频不能把上一轮 mp4 当参考图自动续接。
    supportsEdit: modality === 'image' && protocol !== 'minimax' && protocol !== 'dashscope-sync' && protocol !== 'dashscope-voice-clone' && protocol !== 'minimax-tts-async' && protocol !== 'minimax-voice-clone',
    audioTask: (credentials.audioTask?.trim() as 'tts' | 'music' | 'clone') || 'tts',
  }
}

// ===== 参考图/样本读取 =====

const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.opus': 'audio/opus',
}

export interface ReferenceFile {
  mediaType: string
  base64: string
  filename: string
}

/**
 * 解析路径的真实绝对路径（解析符号链接）；文件不存在或无法解析时返回 null。
 * 用于参考文件越界校验：必须基于 realpath 判定，否则 cwd 内指向敏感目录的软链可绕过校验。
 */
function resolveRealPathSafe(filePath: string): string | null {
  try {
    return realpathSync(filePath)
  } catch {
    return null
  }
}

interface PathBoundaryOps {
  relative(from: string, to: string): string
  isAbsolute(path: string): boolean
}

/**
 * 判断候选路径是否位于根目录内。pathOps 参数用于跨平台单元测试；生产环境使用当前平台实现。
 */
export function isPathWithinRoot(
  allowedRoot: string,
  candidatePath: string,
  pathOps: PathBoundaryOps = { relative, isAbsolute },
): boolean {
  const rel = pathOps.relative(allowedRoot, candidatePath)
  return rel !== '..'
    && !rel.startsWith('../')
    && !rel.startsWith('..\\')
    && !pathOps.isAbsolute(rel)
}

export function readReferenceFiles(paths: string[], cwd?: string): ReferenceFile[] {
  const files: ReferenceFile[] = []
  // 参考文件由用户/MCP agent 明确指定路径（如同「打开文件」语义），读取并发送给厂商是其
  // 预期用途。当提供 cwd 时，额外做一层越界校验：把路径与 cwd 都 realpath 后比较，确保
  // cwd 内的符号链接不会指向白名单外的敏感文件。cwd 缺失时不限制（参考图本就是任意路径）。
  // 若 cwd 传入但 realpath 失败（目录不存在/权限不足），fail-closed 直接拒绝读取，
  // 不静默退化为不校验（否则安全形同虚设）。
  const allowedRoot = cwd ? resolveRealPathSafe(resolve(cwd)) : undefined
  if (cwd && !allowedRoot) {
    console.warn(`[Media Generation] cwd 无法解析，已拒绝读取参考文件: ${cwd}`)
    return files
  }
  for (const rawPath of paths) {
    try {
      const filePath = isAbsolute(rawPath) ? rawPath : resolve(cwd ?? process.cwd(), rawPath)
      const realPath = resolveRealPathSafe(filePath)
      if (!realPath) {
        console.warn(`[Media Generation] 参考文件不存在: ${filePath}`)
        continue
      }
      if (allowedRoot) {
        // 用 realpath 后的路径做越界判定：否则 cwd 内一个指向 /etc 的软链会绕过
        // relative() 校验，读到白名单外的敏感文件。allowedRoot 同样 realpath，
        // 避免软链前缀不一致导致合法文件被误拒（macOS /var → /private/var）。
        if (!isPathWithinRoot(allowedRoot, realPath)) {
          console.warn(`[Media Generation] 参考文件不在工作目录内，已拒绝: ${filePath}`)
          continue
        }
      }
      const ext = extname(filePath).toLowerCase()
      const mimeType = EXT_TO_MIME[ext]
      if (!mimeType) {
        console.warn(`[Media Generation] 不支持的文件类型，跳过: ${filePath}`)
        continue
      }
      files.push({
        mediaType: mimeType,
        base64: readFileSync(realPath).toString('base64'),
        filename: filePath.split(/[\\/]/).pop() ?? 'reference.bin',
      })
    } catch (error) {
      console.warn(`[Media Generation] 读取参考文件失败: ${rawPath}`, error)
    }
  }
  return files
}

// ===== 多轮状态缓存（按 modality + sessionId 隔离） =====

/**
 * 多轮状态缓存按 sessionId 隔离，长驻 MCP server 会累积大量会话（尤其含 base64 图片
 * 的 Gemini 历史，单会话可达数 MB）。给每个会话级 Map 设全局 LRU 上限，超限时淘汰最旧
 * 会话（Map 按插入序遍历，keys().next() 即最旧条目），避免内存无限增长。
 */
const MAX_SESSION_CACHE_ENTRIES = 256

function evictOldestIfNeeded<V>(map: Map<string, V>, limit = MAX_SESSION_CACHE_ENTRIES): void {
  while (map.size >= limit) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

const lastGeneratedByModalitySession = new Map<string, string>()

function cacheKey(modality: MediaModality, sessionId: string): string {
  return `${modality}:${sessionId}`
}

export function setLastGenerated(modality: MediaModality, sessionId: string, path: string): void {
  const key = cacheKey(modality, sessionId)
  lastGeneratedByModalitySession.delete(key) // 删除后重插，使该 session 重新成为最新
  evictOldestIfNeeded(lastGeneratedByModalitySession)
  lastGeneratedByModalitySession.set(key, path)
}

export function getLastGenerated(modality: MediaModality, sessionId: string): string | undefined {
  return lastGeneratedByModalitySession.get(cacheKey(modality, sessionId))
}

export function clearMediaGenerationSessionHistory(sessionId: string): void {
  for (const key of [...lastGeneratedByModalitySession.keys()]) {
    if (key.endsWith(`:${sessionId}`)) {
      lastGeneratedByModalitySession.delete(key)
    }
  }
  // 同时清理 Gemini 多轮历史（统一入口，避免调用方需要分别清理）
  geminiSessionHistory.delete(sessionId)
  googleOmniInteractionHistory.delete(sessionId)
}

// ===== 通用工具 =====

/** M5 修复：安全解析 JSON，失败给出 HTTP 上下文 */
async function safeParseJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} 返回了非 JSON 响应 (${response.status}): ${text.slice(0, 200)}`)
  }
}

/** 下载 url 为 base64 */
async function downloadAsBase64(
  url: string,
  fetchFn: typeof globalThis.fetch,
  signal?: AbortSignal,
  fallbackMediaType = 'image/png',
  headers?: Record<string, string>,
): Promise<GeneratedImageData> {
  const response = await fetchFn(url, { ...(headers ? { headers } : {}), signal })
  if (!response.ok) {
    throw new Error(`下载生成内容失败 (${response.status})`)
  }
  const arrayBuffer = await response.arrayBuffer()
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim() || fallbackMediaType
  return { mediaType, data: Buffer.from(arrayBuffer).toString('base64') }
}

function audioMimeForFilename(filename: string, fallbackMediaType = 'audio/mpeg'): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.flac')) return 'audio/flac'
  if (lower.endsWith('.m4a') || lower.endsWith('.mp4')) return 'audio/mp4'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  if (lower.endsWith('.aac')) return 'audio/aac'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  return fallbackMediaType
}

function audioMimeForFormat(format?: string): string {
  if (format === 'wav') return 'audio/wav'
  if (format === 'flac') return 'audio/flac'
  if (format === 'pcm') return 'audio/wav'
  return 'audio/mpeg'
}

function readTarOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = buffer.toString('ascii', offset, offset + length).replace(/\0.*$/s, '').trim()
  if (!raw) return 0
  const value = Number.parseInt(raw, 8)
  return Number.isFinite(value) ? value : 0
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  return buffer.toString('utf8', offset, offset + length).replace(/\0.*$/s, '').trim()
}

function extractAudioFromTarBuffer(buffer: Buffer, fallbackMediaType = 'audio/mpeg'): GeneratedImageData | null {
  if (buffer.length < 512) return null
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) return null
    const name = readTarString(buffer, offset, 100)
    const prefix = readTarString(buffer, offset + 345, 155)
    const filename = [prefix, name].filter(Boolean).join('/')
    const size = readTarOctal(buffer, offset + 124, 12)
    const typeflag = buffer.toString('ascii', offset + 156, offset + 157)
    const dataOffset = offset + 512
    const dataEnd = dataOffset + size
    if (dataEnd > buffer.length) return null
    if ((typeflag === '0' || typeflag === '\0' || typeflag === '') && /\.(mp3|wav|flac|m4a|mp4|ogg|aac)$/i.test(filename)) {
      return {
        mediaType: audioMimeForFilename(filename, fallbackMediaType),
        data: buffer.subarray(dataOffset, dataEnd).toString('base64'),
      }
    }
    offset = dataOffset + Math.ceil(size / 512) * 512
  }
  return null
}

async function downloadMinimaxAudioAsBase64(
  url: string,
  fetchFn: typeof globalThis.fetch,
  signal?: AbortSignal,
  fallbackMediaType = 'audio/mpeg',
): Promise<GeneratedImageData> {
  const response = await fetchFn(url, { signal })
  if (!response.ok) {
    throw new Error(`下载 MiniMax 音频失败 (${response.status})`)
  }
  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim() || fallbackMediaType
  if (mediaType === 'application/x-tar' || mediaType === 'application/tar' || buffer.toString('ascii', 257, 263) === 'ustar\0') {
    const extracted = extractAudioFromTarBuffer(buffer, fallbackMediaType)
    if (extracted) return extracted
  }
  return { mediaType: mediaType.startsWith('audio/') ? mediaType : fallbackMediaType, data: buffer.toString('base64') }
}

function base64FromMinimaxAudioPayload(value: string, audioFormat?: string): string {
  const trimmed = value.trim()
  if (!trimmed) return trimmed
  // MiniMax TTS 的 data.audio 实际返回十六进制音频串（常见以 494433=ID3 开头），
  // 不能直接当 base64 写入；否则会得到一个有体积但不可播放的“假 mp3”。
  const compact = trimmed.replace(/\s+/g, '')
  const lower = compact.toLowerCase()
  const looksLikeKnownAudioHex = lower.startsWith('494433') // ID3 / MP3
    || lower.startsWith('fffb') || lower.startsWith('fff3') || lower.startsWith('fff2') // 裸 MP3 帧
    || lower.startsWith('52494646') // RIFF / WAV
    || lower.startsWith('664c6143') // fLaC
    || lower.startsWith('4f676753') // OggS
  if (
    compact.length % 2 === 0
    && /^[0-9a-f]+$/i.test(compact)
    && (looksLikeKnownAudioHex || audioFormat === 'pcm')
  ) {
    return Buffer.from(compact, 'hex').toString('base64')
  }
  return trimmed
}

function base64FromHexAudioPayload(value: string, source: string): string {
  const compact = value.trim().replace(/\s+/g, '')
  if (!compact || compact.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(compact)) {
    throw new Error(`${source} 返回的音频不是有效 hex 编码`)
  }
  return Buffer.from(compact, 'hex').toString('base64')
}

function imageMimeForFormat(format?: string): string {
  if (format === 'jpeg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  return 'image/png'
}

function imageDataFromInlineValue(value: string, fallbackMediaType = 'image/png'): GeneratedImageData | null {
  const trimmed = value.trim()
  const dataUrl = trimmed.match(/^data:([^;,]+);base64,(.+)$/s)
  if (dataUrl) return { mediaType: dataUrl[1]!, data: dataUrl[2]!.replace(/\s+/g, '') }
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.replace(/\s+/g, '').length > 64) {
    return { mediaType: fallbackMediaType, data: trimmed.replace(/\s+/g, '') }
  }
  return null
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function createInternalTimeoutSignal(timeoutMs: number, parentSignal?: AbortSignal): {
  signal: AbortSignal
  clear: () => void
  timedOut: () => boolean
} {
  const controller = new AbortController()
  let didTimeout = false
  const timer = setTimeout(() => {
    didTimeout = true
    controller.abort()
  }, timeoutMs)
  const onParentAbort = (): void => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) onParentAbort()
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true })
  const maybeUnref = (timer as { unref?: () => void }).unref
  if (typeof maybeUnref === 'function') maybeUnref.call(timer)
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', onParentAbort)
    },
    timedOut: () => didTimeout,
  }
}

/** "1024x1024" → {w,h}；支持 x / × / * / 中文“乘”。 */
function parseSize(size: string): { w: number; h: number } | null {
  const m = size.trim().match(/(\d{3,5})\s*(?:[*xX×]|乘)\s*(\d{3,5})/)
  if (!m) return null
  return { w: parseInt(m[1]!, 10), h: parseInt(m[2]!, 10) }
}

function hasPortraitHint(text: string): boolean {
  return /竖屏|竖版|纵向|手机|移动端|portrait|vertical|reels?|story|shorts|tiktok|抖音|小红书/.test(text)
}

function hasLandscapeHint(text: string): boolean {
  return /横屏|横版|横向|宽屏|landscape|horizontal|youtube|b站|哔哩|电视|桌面|封面/.test(text)
}

function normalizeSizeText(value: string | undefined, modality: MediaModality): string | undefined {
  if (!value) return undefined
  const text = value.trim().toLowerCase()
  if (!text) return undefined
  if (/^auto$/i.test(text)) return 'auto'

  const explicit = parseSize(text)
  if (explicit) return `${explicit.w}x${explicit.h}`

  const ratio = text.match(/(?:^|[^\d])(\d{1,2})\s*[:：]\s*(\d{1,2})(?:[^\d]|$)/)
  if (ratio) return `${parseInt(ratio[1]!, 10)}:${parseInt(ratio[2]!, 10)}`

  const portrait = hasPortraitHint(text)
  const landscape = hasLandscapeHint(text)
  const square = /正方形|方图|头像|icon|square|1比1|一比一/.test(text)
  if (square) return '1:1'

  const pMatch = text.match(/(?:^|[^\d])(480|720|1080|1440|2160)\s*p(?:[^\d]|$)/)
  if (pMatch) {
    const h = parseInt(pMatch[1]!, 10)
    const wByHeight: Record<number, number> = { 480: 854, 720: 1280, 1080: 1920, 1440: 2560, 2160: 3840 }
    const w = wByHeight[h] ?? Math.round(h * 16 / 9)
    return portrait && !landscape ? `${h}x${w}` : `${w}x${h}`
  }

  if (/(?:^|[^a-z0-9])4k(?:[^a-z0-9]|$)|超高清|uhd/.test(text)) return portrait && !landscape ? '2160x3840' : '3840x2160'
  if (/(?:^|[^a-z0-9])2k(?:[^a-z0-9]|$)|qhd/.test(text)) return portrait && !landscape ? '1440x2560' : '2560x1440'

  if (portrait && !landscape) return modality === 'image' && /海报|poster/.test(text) ? '3:4' : '9:16'
  if (landscape && !portrait) return '16:9'
  return undefined
}

function resolveRequestedSize(input: Pick<GenerateMediaInput, 'size' | 'prompt' | 'modality'>): string | undefined {
  return normalizeSizeText(input.size, input.modality) ?? normalizeSizeText(input.prompt, input.modality)
}

/** 视频比例换算 */
function sizeToAspectRatio(size?: string): string | undefined {
  const normalized = normalizeSizeText(size, 'video') ?? size?.trim()
  const ratio = normalized?.trim()
  if (ratio && /^\d+\s*:\s*\d+$/.test(ratio)) {
    return ratio.replace(/\s+/g, '')
  }
  const p = normalized ? parseSize(normalized) : null
  if (!p) return undefined
  if (p.w === p.h) return '1:1'
  if (p.w / p.h > 1.7) return '16:9'
  if (p.w / p.h < 0.6) return '9:16'
  if (p.w > p.h) return '4:3'
  return '3:4'
}

const POLL_INTERVAL_MS = 5000
const VIDEO_POLL_TIMEOUT_MS = 600000
const IMAGE_POLL_TIMEOUT_MS = 300000
const AUDIO_POLL_TIMEOUT_MS = 300000
const MUSIC_SYNC_TIMEOUT_MS = 300000
const MUSIC_DOWNLOAD_TIMEOUT_MS = 120000

// ===== 调用入口 =====

export type OpenAiImageQuality = 'low' | 'medium' | 'high' | 'auto'
export type OpenAiImageOutputFormat = 'png' | 'jpeg' | 'webp'
export type OpenAiImageBackground = 'transparent' | 'opaque' | 'auto'
export type OpenAiImageModeration = 'auto' | 'low'

export interface GenerateMediaInput {
  modality: MediaModality
  prompt: string
  config: ResolvedMediaConfig
  apiKey: string
  size?: string
  numberOfImages?: number
  /** 视频/音频时长（秒） */
  duration?: number
  /** 参考文件本地路径（编辑/图生视频/声音克隆样本） */
  referencePaths?: string[]
  /** Veo 3.1 末帧控制图路径（lastFrame） */
  lastFramePath?: string
  /** Veo 3.1 视频扩展输入路径（video extension） */
  videoPath?: string
  /** DashScope/Veo 等支持公网视频素材的协议使用；DashScope 要求 HTTP(S)/OSS URL */
  videoUrl?: string
  isEdit?: boolean
  /**
   * DashScope 视频（HappyHorse / wan2.7）智能路由：1 张参考图时的用途语义。
   * 'first_frame'=把图作为视频首帧让它动起来（默认，→ i2v）；
   * 'reference'=把图作为风格/角色参考素材（→ r2v）。
   * 0 张图忽略此参数（→ t2v）；≥2 张图强制 r2v。
   */
  referenceMode?: 'first_frame' | 'reference'
  /** Veo 3.1 参考图语义：asset=主体/对象参考，style=风格参考 */
  referenceType?: 'asset' | 'style'
  /** OpenAI Images 高级参数（仅 openai-images 协议族使用） */
  quality?: OpenAiImageQuality
  outputFormat?: OpenAiImageOutputFormat
  outputCompression?: number
  background?: OpenAiImageBackground
  moderation?: OpenAiImageModeration
  /** Gemini（nano-banana）专属参数（仅 gemini-generate-content 协议族使用） */
  aspectRatio?: '1:1' | '16:9' | '4:3' | '9:16' | '3:4'
  imageSize?: 'auto' | '1K' | '2K' | '4K'
  /** 跨厂商常用高级参数（各协议族按官方字段选择性透传） */
  negativePrompt?: string
  seed?: number
  promptEnhance?: boolean
  watermark?: boolean
  /** 视频常用参数 */
  resolution?: string
  fps?: number
  withAudio?: boolean
  audioSetting?: 'auto' | 'origin'
  audioUrl?: string
  frames?: number
  returnLastFrame?: boolean
  cameraFixed?: boolean
  personGeneration?: string
  mode?: string
  guidanceScale?: number
  stylePreset?: string
  shotType?: 'single' | 'multi'
  /** 音频常用参数 */
  speed?: number
  volume?: number
  pitch?: number
  audioFormat?: 'mp3' | 'wav' | 'flac' | 'pcm'
  /** 语音情感风格控制指令（仅 Qwen3-TTS 等支持） */
  instruction?: string
  /** 音频子任务 */
  audioTask?: 'tts' | 'music' | 'clone'
  /** 音色（TTS 用） */
  voice?: string
  /** 歌词（音乐生成用） */
  lyrics?: string
  /** MiniMax 音乐生成参数 */
  instrumental?: boolean
  lyricsOptimizer?: boolean
  musicOutputFormat?: 'hex' | 'url'
  sampleRate?: number
  bitrate?: number
  coverFeatureId?: string
  aigcWatermark?: boolean
  cwd?: string
  /** 会话标识，用于 Gemini 多轮历史隔离（其它协议忽略） */
  sessionId?: string
  fetchFn?: typeof globalThis.fetch
  signal?: AbortSignal
  pollIntervalMs?: number
}

export interface GenerateMediaOutput {
  images: GeneratedImageData[]
  text?: string
}

/**
 * 统一多媒体生成入口。按 (modality, protocol) 分派。
 */
export async function generateMedia(input: GenerateMediaInput): Promise<GenerateMediaOutput> {
  const fetchFn = input.fetchFn ?? fetch
  const modality = input.modality
  const modelPreset = input.config.preset

  // preset 为 null（自定义配置）时，按 model+modality 反查预设的 audioTask：
  // 仅当模型明确是 music/clone（非 tts）时采用反查结果，纠正下拉框残留的脏 audioTask
  // （如 music 模型残留 'tts'）。tts 不反查，以免破坏同步/异步 TTS 的既有路由判定。
  const presetTaskByModel = findPresetByModel(input.config.model, modality)?.audioTask
  const resolvedTaskByModel = presetTaskByModel === 'music' || presetTaskByModel === 'clone' ? presetTaskByModel : undefined
  const configuredTask = modelPreset?.audioTask ?? resolvedTaskByModel ?? input.config.audioTask
  // resolveMediaConfig 已经把“用户显式覆盖 > 预设默认值”的优先级折叠进
  // config.protocol。这里若再次从 preset 取值，会让解析结果看似正确、实际分派
  // 却悄悄回到预设协议，导致自定义代理/兼容协议完全不生效。
  let protocol = input.config.protocol
  // Agent 侧无实时诉求，统一让所有 MiniMax TTS 走异步长文本接口（t2a_async_v2）
  // 仅对音频模态生效：视频/图像即使 configuredTask 落到默认 'tts' 也必须保留 'minimax' 协议族，
  // 否则会被改写成 'minimax-tts-async'，导致视频落到不支持的协议族而报错。
  if (modality === 'audio' && protocol === 'minimax' && configuredTask === 'tts') {
    protocol = 'minimax-tts-async'
  }
  const config = input.config
  const explicitReferenceCount = input.referencePaths?.length ?? 0
  const references = input.referencePaths?.length
    ? readReferenceFiles(input.referencePaths, input.cwd)
    : []
  if (explicitReferenceCount > 0 && references.length === 0) {
    throw new Error('已提供参考文件路径，但没有可用文件（可能不存在、类型不支持，或不在当前工作目录内）')
  }

  // 图像
  if (modality === 'image') {
    if (protocol === 'openai-images') {
      if (isZhipuImageModel(config.model)) return callZhipuImageApi(input, fetchFn)
      return callOpenAiImagesApi(input, fetchFn, references)
    }
    if (protocol === 'gemini-generate-content') return callGeminiImageApi(input, fetchFn, references)
    if (protocol === 'dashscope-async') return callDashscopeImageApi(input, fetchFn, references)
    if (protocol === 'minimax') return callMinimaxImageApi(input, fetchFn, references)
    if (protocol === 'stability') return callStabilityImageApi(input, fetchFn)
    if (protocol === 'tencent-hunyuan-async') return callTencentHunyuanAsyncApi(input, fetchFn, references)
    if (protocol === 'midjourney') return callMidjourneyApi(input, fetchFn)
    throw new Error(`图像不支持协议族: ${protocol}`)
  }

  // 视频
  if (modality === 'video') {
    if (protocol === 'volcengine-async') return callVolcengineVideoApi(input, fetchFn, references)
    if (protocol === 'kling-async') return callKlingVideoApi(input, fetchFn, references)
    if (protocol === 'zhipu-async') return callZhipuVideoApi(input, fetchFn, references)
    if (protocol === 'dashscope-async') return callDashscopeVideoApi(input, fetchFn, references)
    if (protocol === 'minimax') return callMinimaxVideoApi(input, fetchFn, references)
    if (protocol === 'tencent-hunyuan-async') return callTencentHunyuanAsyncApi(input, fetchFn, references)
    if (protocol === 'google-interactions') return callGoogleInteractionsVideoApi(input, fetchFn, references)
    throw new Error(`视频不支持协议族: ${protocol}`)
  }

  // 音频
  if (modality === 'audio') {
    const requestedTask = input.audioTask
    if (config.preset && requestedTask && configuredTask && requestedTask !== configuredTask) {
      throw new Error(`当前配置的音频模型用于 ${configuredTask}，不能执行 ${requestedTask}；请在设置中切换到对应音频模型后重试`)
    }
    let task = requestedTask ?? configuredTask ?? 'tts'
    if (task === 'tts' && explicitReferenceCount > 0) {
      task = 'clone'
    }
    if (task === 'music') {
      if (protocol !== 'minimax') throw new Error(`音乐生成不支持协议族: ${protocol}`)
      return callMinimaxMusicApi(input, fetchFn)
    }
    if (task === 'clone') {
      if (protocol === 'volcengine-tts') return callVolcengineTtsApi(input, fetchFn, references)
      if (protocol === 'zhipu-async') return callZhipuVoiceCloneApi(input, fetchFn, references)
      if (protocol === 'dashscope-sync' || protocol === 'dashscope-voice-clone') return callDashscopeVoiceCloneApi(input, fetchFn, references)
      if (protocol === 'minimax' || protocol === 'minimax-tts-async' || protocol === 'minimax-voice-clone') return callMinimaxVoiceCloneApi(input, fetchFn, references)
      throw new Error(`声音复刻不支持协议族: ${protocol}`)
    }
    // tts
    if (protocol === 'volcengine-tts') return callVolcengineTtsApi(input, fetchFn, references)
    if (protocol === 'volcengine-plan-tts') return callVolcenginePlanTtsApi(input, fetchFn)
    if (protocol === 'zhipu-async') return callZhipuTtsApi(input, fetchFn)
    if (protocol === 'dashscope-sync') return callDashscopeTtsApi(input, fetchFn)
    // 注意：generateMedia 入口已把所有 minimax+tts 改写成 minimax-tts-async，
    // 正常流程不会走到这里。保留此分支作为防御兜底——若未来有同步 TTS 诉求，
    // 只需在入口取消改写即可恢复同步路径，无需重建分派。
    if (protocol === 'minimax') return callMinimaxTtsApi(input, fetchFn)
    if (protocol === 'minimax-tts-async') return callMinimaxAsyncTtsApi(input, fetchFn)
    throw new Error(`TTS 不支持协议族: ${protocol}`)
  }

  throw new Error(`未知模态: ${modality}`)
}

// ===== 协议族：openai-images（图像） =====

interface OpenAiImageItem {
  b64_json?: string
  image_base64?: string
  result?: string
  mime_type?: string
  media_type?: string
  url?: string
  revised_prompt?: string
}

function isGptImage2Model(model: string): boolean {
  return /^gpt-image-2(?:$|[-.])/.test(model)
}

function assertOneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new Error(`${name} 参数无效: ${value}，可选值: ${allowed.join(', ')}`)
}

function buildOpenAiImageAdvancedOptions(input: GenerateMediaInput, effectiveModel: string): Record<string, string | number> {
  const quality = assertOneOf('quality', input.quality, ['low', 'medium', 'high', 'auto'] as const)
  const outputFormat = assertOneOf('outputFormat', input.outputFormat, ['png', 'jpeg', 'webp'] as const)
  const background = assertOneOf('background', input.background, ['transparent', 'opaque', 'auto'] as const)
  const moderation = assertOneOf('moderation', input.moderation, ['auto', 'low'] as const)

  const options: Record<string, string | number> = {}
  if (quality) options.quality = quality
  if (outputFormat) options.output_format = outputFormat
  if (background) options.background = background
  if (moderation) options.moderation = moderation

  if (isGptImage2Model(effectiveModel) && background === 'transparent') {
    throw new Error('gpt-image-2 不支持透明背景（background=transparent）；请改用 background=auto/opaque，或切换到支持透明背景的图像模型')
  }

  if (input.outputCompression !== undefined) {
    if (!Number.isInteger(input.outputCompression) || input.outputCompression < 0 || input.outputCompression > 100) {
      throw new Error('outputCompression 必须是 0-100 的整数')
    }
    if (outputFormat !== 'jpeg' && outputFormat !== 'webp') {
      throw new Error('outputCompression 仅适用于 outputFormat=jpeg 或 webp')
    }
    options.output_compression = input.outputCompression
  }

  return options
}

function isOpenAiGptImageModel(model: string): boolean {
  return /^gpt-image(?:$|[-.])/.test(model)
}

function isSeedreamHighResImageModel(model: string): boolean {
  return /^doubao-seedream-(?:4|5)(?:-|$)/i.test(model)
}

function isSeedreamProImageModel(model: string): boolean {
  return /^doubao-seedream-5-0-pro-/i.test(model)
}

function isVolcengineSeedreamModel(model: string): boolean {
  return /^doubao-seedream-/i.test(model)
}

function roundUpToMultiple(value: number, multiple: number): number {
  return Math.ceil(value / multiple) * multiple
}

function roundDownToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.floor(value / multiple) * multiple)
}

function scaleSizeToPixelRange(size: { w: number; h: number }, minPixels: number, maxPixels: number): { w: number; h: number } {
  const currentPixels = size.w * size.h
  if (currentPixels >= minPixels && currentPixels <= maxPixels) return size

  const ratio = Math.max(1 / 16, Math.min(16, size.w / size.h))
  const targetPixels = currentPixels < minPixels ? minPixels : maxPixels
  const round = currentPixels < minPixels ? roundUpToMultiple : roundDownToMultiple
  let h = round(Math.sqrt(targetPixels / ratio), 16)
  let w = round(h * ratio, 16)

  // 向下取整时可能刚好低于下限，向上取整时可能刚好超过上限；做一次安全修正。
  if (w * h < minPixels) {
    h = roundUpToMultiple(h + 16, 16)
    w = roundUpToMultiple(h * ratio, 16)
  }
  if (w * h > maxPixels) {
    h = roundDownToMultiple(h - 16, 16)
    w = roundDownToMultiple(h * ratio, 16)
  }
  return { w, h }
}

function formatSeedreamHighResSize(size: string): string {
  const normalized = normalizeSizeText(size, 'image') ?? size.trim()
  if (normalized === 'auto') return '2K'

  const ratio = sizeToAspectRatio(normalized)
  const minPixels = 2560 * 1440
  const maxPixels = 4096 * 4096
  const ratioMap: Record<string, string> = {
    '1:1': '2048x2048',
    '16:9': '2560x1440',
    '9:16': '1440x2560',
    '4:3': '2304x1728',
    '3:4': '1728x2304',
  }
  if (/^\d+\s*:\s*\d+$/.test(normalized)) {
    return ratioMap[normalized.replace(/\s+/g, '')] ?? '2K'
  }

  const parsed = parseSize(normalized)
  if (!parsed) return '2K'
  const aspect = parsed.w / parsed.h
  if (aspect < 1 / 16 || aspect > 16) {
    throw new Error('Seedream 图像 size 宽高比必须在 [1/16, 16] 范围内')
  }
  const pixels = parsed.w * parsed.h
  if (pixels >= minPixels && pixels <= maxPixels) return `${parsed.w}x${parsed.h}`
  if (pixels < minPixels && ratio && ratioMap[ratio]) return ratioMap[ratio]
  const scaled = scaleSizeToPixelRange(parsed, minPixels, maxPixels)
  return `${scaled.w}x${scaled.h}`
}

function formatSeedreamProSize(size: string): string {
  const normalized = normalizeSizeText(size, 'image') ?? size.trim()
  if (normalized === 'auto') return '2K'

  // Seedream 5.0 Pro 的像素范围与 5.0 Lite/4.5 不同：[1280x720, 2048x2048]，
  // 因此不能复用 formatSeedreamHighResSize 的 minPixels=2560*1440 约束，
  // 否则合法小尺寸会被错误提升到超限值。比例档位取官方 1K 档像素值。
  const minPixels = 1280 * 720
  const maxPixels = 2048 * 2048
  const ratioMap: Record<string, string> = {
    '1:1': '1024x1024',
    '16:9': '1312x736',
    '9:16': '736x1312',
    '4:3': '1152x864',
    '3:4': '864x1152',
  }
  if (/^\d+\s*:\s*\d+$/.test(normalized)) {
    return ratioMap[normalized.replace(/\s+/g, '')] ?? '2K'
  }

  const parsed = parseSize(normalized)
  if (!parsed) return '2K'
  const aspect = parsed.w / parsed.h
  if (aspect < 1 / 16 || aspect > 16) {
    throw new Error('Seedream 图像 size 宽高比必须在 [1/16, 16] 范围内')
  }
  const pixels = parsed.w * parsed.h
  if (pixels >= minPixels && pixels <= maxPixels) return `${parsed.w}x${parsed.h}`
  if (pixels < minPixels) {
    const ratio = sizeToAspectRatio(normalized)
    if (ratio && ratioMap[ratio]) return ratioMap[ratio]!
  }
  const scaled = scaleSizeToPixelRange(parsed, minPixels, maxPixels)
  return `${scaled.w}x${scaled.h}`
}

function formatOpenAiImageSize(size: string, model: string): string {
  const normalized = normalizeSizeText(size, 'image') ?? size.trim()
  if (normalized === 'auto') return normalized
  const ratio = sizeToAspectRatio(normalized)
  if (isSeedreamHighResImageModel(model)) {
    // 火山 Seedream 4/5 使用 OpenAI-compatible Images 路径，但不接受 1024x1024
    // 这类小图；5.0 Pro 像素范围 [1280x720, 2048x2048] 与 Lite/4.5 的
    // [2560x1440, 4096x4096] 不同，需走独立尺寸约束。
    if (isSeedreamProImageModel(model)) return formatSeedreamProSize(normalized)
    return formatSeedreamHighResSize(normalized)
  }
  if (isOpenAiGptImageModel(model)) {
    // OpenAI GPT Image 系列不接受任意像素值；把自然语言/比例/分辨率映射为最接近的官方尺寸档。
    if (ratio === '1:1') return '1024x1024'
    if (ratio === '9:16' || ratio === '3:4') return '1024x1536'
    if (ratio === '16:9' || ratio === '4:3') return '1536x1024'
  }
  if (/^\d+\s*:\s*\d+$/.test(normalized)) {
    const ratioMap: Record<string, string> = {
      '1:1': '1024x1024', '16:9': '1280x720', '9:16': '720x1280',
      '4:3': '1024x768', '3:4': '768x1024',
    }
    return ratioMap[normalized] ?? '1024x1024'
  }
  return normalized
}

function isZhipuImageModel(model: string): boolean {
  return /^(?:glm-image|cogview-)/i.test(model)
}

function normalizeZhipuImageSize(size: string, model: string): string {
  const normalized = normalizeSizeText(size, 'image') ?? size.trim()
  const isGlmImage = /^glm-image$/i.test(model)
  const ratio = /^\d+\s*:\s*\d+$/.test(normalized) ? normalized.replace(/\s+/g, '') : sizeToAspectRatio(normalized)
  const ratioMap = isGlmImage
    ? { '1:1': '1280x1280', '16:9': '1728x960', '9:16': '960x1728', '4:3': '1472x1088', '3:4': '1088x1472' } as Record<string, string>
    : { '1:1': '1024x1024', '16:9': '1344x768', '9:16': '768x1344', '4:3': '1152x864', '3:4': '864x1152' } as Record<string, string>
  if (ratio && ratioMap[ratio] && !parseSize(normalized)) return ratioMap[ratio]

  const parsed = parseSize(normalized)
  if (!parsed) return ratioMap['1:1']!
  const multiple = isGlmImage ? 32 : 16
  const minSide = isGlmImage ? 1024 : 512
  const maxPixels = isGlmImage ? 2 ** 22 : 2 ** 21
  const maxSide = 2048
  let w = Math.min(maxSide, Math.max(minSide, roundUpToMultiple(parsed.w, multiple)))
  let h = Math.min(maxSide, Math.max(minSide, roundUpToMultiple(parsed.h, multiple)))
  if (w * h > maxPixels) {
    const scaled = scaleSizeToPixelRange({ w, h }, minSide * minSide, maxPixels)
    w = roundDownToMultiple(Math.min(maxSide, Math.max(minSide, scaled.w)), multiple)
    h = roundDownToMultiple(Math.min(maxSide, Math.max(minSide, scaled.h)), multiple)
  }
  return `${w}x${h}`
}

function zhipuImageQuality(value: OpenAiImageQuality | undefined, model: string): 'hd' | 'standard' | undefined {
  if (!value || value === 'auto') return undefined
  if (/^glm-image$/i.test(model)) return 'hd'
  return value === 'high' ? 'hd' : 'standard'
}

async function callZhipuImageApi(input: GenerateMediaInput, fetchFn: typeof globalThis.fetch): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('智谱图像缺少 baseUrl')
  const count = input.numberOfImages ?? 1
  if (count !== 1) throw new Error('智谱图像接口当前一次只返回 1 张图片，请把 numberOfImages 设为 1')
  const body: Record<string, unknown> = {
    model,
    prompt: input.prompt,
    size: normalizeZhipuImageSize(resolveRequestedSize(input) || input.config.preset?.defaultSize || '1280x1280', model),
  }
  const quality = zhipuImageQuality(input.quality, model)
  if (quality) body.quality = quality
  if (input.watermark !== undefined) body.watermark_enabled = input.watermark
  const res = await fetchFn(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: input.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`智谱图像生成失败 (${res.status}): ${text.slice(0, 300)}`)
  }
  const parsed = (await safeParseJson(res, '智谱图像')) as { data?: Array<{ url?: string }> }
  const images: GeneratedImageData[] = []
  for (const item of parsed.data ?? []) {
    if (item.url) images.push(await downloadAsBase64(item.url, fetchFn, input.signal))
  }
  if (images.length === 0) throw new Error('智谱图像成功但未返回图片 URL')
  return { images }
}

async function callVolcengineSeedreamImageApi(
  input: GenerateMediaInput,
  fetchFn: typeof globalThis.fetch,
  references: ReferenceFile[],
): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('Seedream 图像缺少 baseUrl')
  const requestedCount = input.numberOfImages ?? 1
  const body: Record<string, unknown> = {
    model,
    prompt: input.prompt,
    size: formatOpenAiImageSize(resolveRequestedSize(input) || input.config.preset?.defaultSize || '2048x2048', model),
    // 火山 Seedream 文档推荐非流式 + URL 返回；URL 下载后仍会保存为本地附件。
    response_format: 'url',
    stream: false,
  }
  if (references.length > 0) {
    body.image = references.map((ref) => `data:${ref.mediaType};base64,${ref.base64}`)
  }
  if (input.watermark !== undefined) body.watermark = input.watermark
  if (input.seed !== undefined) body.seed = input.seed
  if (requestedCount > 1 && isSeedreamHighResImageModel(model)) {
    body.sequential_image_generation = 'auto'
    body.sequential_image_generation_options = { max_images: requestedCount }
  } else if (isSeedreamHighResImageModel(model)) {
    body.sequential_image_generation = 'disabled'
  }

  const res = await fetchFn(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: input.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Seedream 图像生成失败 (${res.status}): ${text.slice(0, 300)}`)
  }
  const parsed = (await safeParseJson(res, 'Seedream 图像')) as { data?: OpenAiImageItem[] }
  const images: GeneratedImageData[] = []
  for (const item of parsed.data ?? []) {
    const base64 = item.b64_json ?? item.image_base64 ?? item.result
    if (typeof base64 === 'string' && base64.length > 0) {
      images.push({ mediaType: item.mime_type ?? item.media_type ?? imageMimeForFormat(input.outputFormat), data: base64 })
    } else if (typeof item.url === 'string' && item.url.length > 0) {
      images.push(await downloadAsBase64(item.url, fetchFn, input.signal))
    }
  }
  if (images.length === 0) throw new Error('Seedream 图像成功但未返回图片')
  return { images }
}

async function callOpenAiImagesApi(
  input: GenerateMediaInput, fetchFn: typeof globalThis.fetch, references: ReferenceFile[],
): Promise<GenerateMediaOutput> {
  const { baseUrl, model, editModel } = input.config
  if (!baseUrl) throw new Error('openai-images 缺少 baseUrl')
  if (isVolcengineSeedreamModel(model)) return callVolcengineSeedreamImageApi(input, fetchFn, references)
  const isEdit = !!input.isEdit && references.length > 0
  const effectiveModel = isEdit && editModel ? editModel : model
  const size = formatOpenAiImageSize(resolveRequestedSize(input) || input.config.preset?.defaultSize || '1024x1024', effectiveModel)
  const advancedOptions = buildOpenAiImageAdvancedOptions(input, effectiveModel)
  const fallbackImageMime = imageMimeForFormat(input.outputFormat)

  let response: Response
  if (isEdit) {
    const form = new FormData()
    form.append('model', effectiveModel)
    form.append('prompt', input.prompt)
    form.append('size', size)
    for (const [key, value] of Object.entries(advancedOptions)) form.append(key, String(value))
    for (const ref of references) {
      form.append('image', new Blob([Buffer.from(ref.base64, 'base64')], { type: ref.mediaType }), ref.filename)
    }
    response = await fetchFn(`${baseUrl}/images/edits`, {
      method: 'POST', headers: { Authorization: `Bearer ${input.apiKey}` }, body: form, signal: input.signal,
    })
  } else {
    response = await fetchFn(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: effectiveModel, prompt: input.prompt, size, n: input.numberOfImages ?? 1, ...advancedOptions }),
      signal: input.signal,
    })
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`图片 API 错误 (${response.status}): ${text.slice(0, 300)}`)
  }
  const body = (await safeParseJson(response, '图片 API')) as { data?: OpenAiImageItem[] }
  const images: GeneratedImageData[] = []
  const revisedPrompts: string[] = []
  for (const item of body.data ?? []) {
    const base64 = item.b64_json ?? item.image_base64 ?? item.result
    if (typeof base64 === 'string' && base64.length > 0) {
      images.push({ mediaType: item.mime_type ?? item.media_type ?? fallbackImageMime, data: base64 })
    } else if (typeof item.url === 'string' && item.url.length > 0) {
      images.push(await downloadAsBase64(item.url, fetchFn, input.signal))
    }
    if (typeof item.revised_prompt === 'string' && item.revised_prompt.trim()) revisedPrompts.push(item.revised_prompt.trim())
  }
  if (images.length === 0) {
    throw new Error('图片 API 未返回图片（请检查模型名、API Key 权限或额度）')
  }
  return { images, text: revisedPrompts.length > 0 ? revisedPrompts.join('\n') : undefined }
}

// ===== 协议族：gemini-generate-content（Google Gemini / nano-banana，图，原生多轮编辑） =====
// 移植自 RunAI 的 nano-banana-mcp.ts，收敛进引擎统一分派体系。
// 特性：Gemini generateContent + inlineData 参考图 + 多轮对话历史（含 thoughtSignature 兼容）。

interface GeminiInlineData {
  mimeType: string
  data: string
}
interface GeminiPart {
  text?: string
  inlineData?: GeminiInlineData
  thoughtSignature?: string
  thought_signature?: string
  /** Flash 思考模式下的 reasoning part，不应作为输出图展示 */
  thought?: boolean
}
interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[]; role?: string }; finishReason?: string }>
  error?: { message: string; code: number }
}

/** Gemini 多轮对话历史（按 sessionId 隔离，跨调用保持上下文以支持迭代编辑） */
const geminiSessionHistory = new Map<string, GeminiContent[]>()

/** thoughtSignature 占位符（多轮编辑必需，见 Gemini 官方文档） */
const GEMINI_DUMMY_SIGNATURE = 'skip_thought_signature_validator'

function geminiHistoryHasSignature(history: GeminiContent[]): boolean {
  return history.some((c) => c.parts.some((p) => p.thoughtSignature || p.thought_signature))
}

/**
 * 构建 Gemini generateContent 请求体。
 * 参考图作为 user message 前导 parts（inlineData base64），prompt 作为 text part。
 * imageConfig 仅在非默认值（aspectRatio≠1:1 或 imageSize≠auto）时附加。
 */
function buildGeminiRequest(
  prompt: string,
  referenceImageParts: GeminiPart[],
  history: GeminiContent[],
  aspectRatio?: string,
  imageSize?: string,
): Record<string, unknown> {
  const needsSignature = history.length > 0 && geminiHistoryHasSignature(history)
  const userParts: GeminiPart[] = [
    ...referenceImageParts,
    { text: prompt, ...(needsSignature && { thoughtSignature: GEMINI_DUMMY_SIGNATURE }) },
  ]
  const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'] }
  const imageConfig: Record<string, unknown> = {}
  if (aspectRatio && aspectRatio !== '1:1') {
    imageConfig.aspectRatio = aspectRatio
  }
  if (imageSize && imageSize !== 'auto') {
    imageConfig.imageSize = imageSize
  }
  if (Object.keys(imageConfig).length > 0) {
    generationConfig.imageConfig = imageConfig
  }
  return {
    contents: [...history, { role: 'user', parts: userParts }],
    generationConfig,
  }
}

/**
 * 调用 Gemini Image Generation（generateContent）。
 *
 * 与其他协议不同：Gemini 的参考图编辑依赖多轮对话上下文，因此用 geminiSessionHistory
 * 维护历史（含 thoughtSignature）。numberOfImages 仅在响应端裁剪，不转发给 API。
 */
async function callGeminiImageApi(
  input: GenerateMediaInput,
  fetchFn: typeof globalThis.fetch,
  references: ReferenceFile[],
): Promise<GenerateMediaOutput> {
  const model = input.config.model
  const baseUrl = input.config.baseUrl
  const apiKey = input.apiKey
  if (!apiKey?.trim()) throw new Error('未配置 Gemini API Key')

  // sessionId 用于隔离多轮历史；缺省时用固定 key（单轮也能工作）
  const sessionId = input.sessionId ?? 'duo-gemini'
  const history = geminiSessionHistory.get(sessionId) ?? []

  // 参考图：引擎已读取为 ReferenceFile，转成 Gemini inlineData parts
  const referenceImageParts: GeminiPart[] = references.map((r) => ({
    inlineData: { mimeType: r.mediaType, data: r.base64 },
  }))

  // 宽高比：只用 Gemini 专属 aspectRatio 字段。
  // 不回退到通用 size（"1024x1024" 风格），否则会触发 Gemini API 400（aspectRatio 仅接受比例枚举）。
  const aspectRatio = input.aspectRatio?.trim() || undefined

  const requestBody = buildGeminiRequest(input.prompt, referenceImageParts, history, aspectRatio, input.imageSize)
  const target = await buildGoogleGenerateContentRequestTarget({ rawCredential: apiKey, baseUrl, modelId: model })

  const response = await fetchFn(target.url, {
    method: 'POST',
    headers: target.headers,
    body: JSON.stringify(requestBody),
    ...(input.signal ? { signal: input.signal } : {}),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`Gemini API 请求失败 (${response.status}): ${errorText.slice(0, 200)}`)
  }

  const data = (await safeParseJson(response, 'Gemini')) as GeminiResponse
  if (data.error) throw new Error(`Gemini API 错误: ${data.error.message}`)
  if (!data.candidates?.length) throw new Error('Gemini 未返回任何内容')

  const candidate = data.candidates[0]
  const parts = candidate?.content?.parts
  if (!parts || parts.length === 0) {
    const reason = candidate?.finishReason
    throw new Error(`Gemini 未返回内容${reason ? `（finishReason: ${reason}；可能被安全策略拦截）` : ''}`)
  }

  // 提取图片（跳过 thought parts）和文本
  const images: GeneratedImageData[] = []
  const textParts: string[] = []
  for (const part of parts) {
    if (part.thought) continue // Flash 思考过程的推理图，不作为输出
    if (part.inlineData) {
      images.push({ mediaType: part.inlineData.mimeType, data: part.inlineData.data })
    } else if (part.text) {
      textParts.push(part.text)
    }
  }

  // 按请求张数裁剪（numberOfImages 仅在此生效，不转发 API）
  const selectedImages = selectGeneratedImagesForImageRequest(images, {
    userMessage: input.prompt,
    defaultCount: input.numberOfImages ?? 1,
  })
  // Gemini 返回了文本/思考 parts 但没有任何 inlineData 图片（如 finishReason: NO_IMAGE），
  // 需显式报错——其他图像协议对"成功但零图"也视为失败。
  if (selectedImages.length === 0) {
    const reason = candidate?.finishReason
    const textHint = textParts.length > 0 ? `，模型回复: ${textParts.join(' ').slice(0, 100)}` : ''
    throw new Error(`Gemini 未生成图片${reason ? `（finishReason: ${reason}）` : ''}${textHint}`)
  }

  // 更新多轮历史（保留原始 parts 含 thoughtSignature）
  const userContent: GeminiContent = { role: 'user', parts: [...referenceImageParts, { text: input.prompt }] }
  const modelContent: GeminiContent = { role: 'model', parts }
  const updatedHistory = [...history, userContent, modelContent]
  // 自动清理：单会话历史超 40 条 content（约 20 轮对话）时，保留最近 40 条，
  // 避免长驻进程的 geminiSessionHistory 无限增长（含 base64 图片内存占用大）。
  const MAX_GEMINI_HISTORY = 40
  geminiSessionHistory.delete(sessionId) // 重插以更新会话新鲜度（LRU）
  evictOldestIfNeeded(geminiSessionHistory)
  geminiSessionHistory.set(
    sessionId,
    updatedHistory.length > MAX_GEMINI_HISTORY ? updatedHistory.slice(-MAX_GEMINI_HISTORY) : updatedHistory,
  )

  return { images: selectedImages, text: textParts.length > 0 ? textParts.join('\n') : undefined }
}

/** 清理某会话的 Gemini 多轮历史（与 clearMediaGenerationSessionHistory 对应） */
export function clearGeminiSessionHistory(sessionId: string): void {
  geminiSessionHistory.delete(sessionId)
}

// ===== 协议族：dashscope-async（图像 / 视频） =====

interface DashscopeTaskResponse {
  output?: {
    task_id?: string
    task_status?: string
    results?: Array<{ url?: string; b64_image?: string; code?: string; message?: string }>
    /** 视频生成返回的单个视频 URL（万相/HappyHorse 文生视频用此字段，而非 results 数组） */
    video_url?: string
    message?: string
    code?: string
  }
  request_id?: string
}

interface DashscopeMultimodalImageResponse {
  output?: {
    choices?: Array<{
      message?: {
        content?: Array<{ image?: string; text?: string }>
      }
    }>
  }
  request_id?: string
}

/** M1 修复：dashscope 图像 size 格式化。万相用 W*H，qwen-image 用 WxH；比例串归一化为像素 */
function formatDashscopeImageSize(size: string, model: string): string {
  const p = parseSize(size)
  if (!p) {
    // 比例串（如 "16:9"）→ 归一化为默认像素尺寸
    const ratioMap: Record<string, { w: number; h: number }> = {
      '16:9': { w: 1280, h: 720 }, '9:16': { w: 720, h: 1280 },
      '4:3': { w: 1024, h: 768 }, '3:4': { w: 768, h: 1024 }, '1:1': { w: 1024, h: 1024 },
    }
    const mapped = ratioMap[size.trim()]
    // 兜底正方形：分隔符必须随 model 走（万相用 *，qwen-image 用 x），否则 qwen-image
    // 传 1024*1024 会被 DashScope 拒收（与下方像素分支的分隔符约定保持一致）。
    if (!mapped) return model.startsWith('wanx') || model.startsWith('wan2') ? '1024*1024' : '1024x1024'
    if (model.startsWith('wanx') || model.startsWith('wan2')) return `${mapped.w}*${mapped.h}`
    return `${mapped.w}x${mapped.h}`
  }
  // 万相系列用 "*" 分隔
  if (model.startsWith('wanx') || model.startsWith('wan2')) return `${p.w}*${p.h}`
  // qwen-image 用 "x" 分隔
  return `${p.w}x${p.h}`
}

function isQwenImage2Model(model: string): boolean {
  return /^qwen-image-2(?:$|[-.])/.test(model)
}

function isDashscopeMultimodalImageModel(model: string): boolean {
  return /^qwen-image(?:$|[-.])/.test(model)
    || /^wan2\.(?:6|7)(?:-image|-t2i)(?:$|-)/.test(model)
    || /^z-image(?:$|-)/.test(model)
}

function formatDashscopeMultimodalImageSize(size: string, model: string): string {
  const normalized = normalizeSizeText(size, 'image') ?? size.trim()
  if (normalized === 'auto') return isQwenImage2Model(model) ? '2048*2048' : '1328*1328'

  const parsed = parseSize(normalized)
  const ratio = /^\d+\s*:\s*\d+$/.test(normalized) ? normalized.replace(/\s+/g, '') : (parsed ? undefined : sizeToAspectRatio(normalized))
  if (isQwenImage2Model(model)) {
    const ratioMap: Record<string, string> = {
      '1:1': '2048*2048', '16:9': '2688*1536', '9:16': '1536*2688',
      '4:3': '2304*1728', '3:4': '1728*2304',
    }
    if (ratio && ratioMap[ratio]) return ratioMap[ratio]
    if (!parsed) return '2048*2048'
    const pixels = parsed.w * parsed.h
    const minPixels = 512 * 512
    const maxPixels = 2048 * 2048
    if (pixels >= minPixels && pixels <= maxPixels) return `${parsed.w}*${parsed.h}`
    const scaled = scaleSizeToPixelRange(parsed, minPixels, maxPixels)
    return `${scaled.w}*${scaled.h}`
  }

  const ratioMap: Record<string, string> = {
    '1:1': '1328*1328', '16:9': '1664*928', '9:16': '928*1664',
    '4:3': '1472*1104', '3:4': '1104*1472',
  }
  if (ratio && ratioMap[ratio]) return ratioMap[ratio]
  if (!parsed) return '1328*1328'
  const parsedRatio = sizeToAspectRatio(`${parsed.w}x${parsed.h}`)
  return parsedRatio && ratioMap[parsedRatio] ? ratioMap[parsedRatio] : '1328*1328'
}

function buildDashscopeMultimodalImageParameters(input: GenerateMediaInput, model: string): Record<string, unknown> {
  const size = formatDashscopeMultimodalImageSize(resolveRequestedSize(input) || input.config.preset?.defaultSize || '1328*1328', model)
  const parameters: Record<string, unknown> = { size }
  const requestedN = input.numberOfImages ?? 1
  if (/^qwen-image-(?:max|plus)$/.test(model) && requestedN !== 1) {
    throw new Error(`${model} 只支持生成 1 张图片，请把 numberOfImages 设为 1`)
  }
  if (!/^z-image(?:$|-)/.test(model)) parameters.n = requestedN
  if (input.negativePrompt) parameters.negative_prompt = input.negativePrompt
  if (input.seed !== undefined) parameters.seed = input.seed
  if (input.promptEnhance !== undefined) parameters.prompt_extend = input.promptEnhance
  if (input.watermark !== undefined) parameters.watermark = input.watermark
  return parameters
}

async function callDashscopeMultimodalImageApi(
  input: GenerateMediaInput,
  fetchFn: typeof globalThis.fetch,
  references: ReferenceFile[],
  model: string,
): Promise<GenerateMediaOutput> {
  const { baseUrl } = input.config
  if (!baseUrl) throw new Error('dashscope-async 缺少 baseUrl')
  if (references.length > 0 && !isQwenImage2Model(model)) {
    throw new Error(`${model} 当前生图链路不支持直接传参考图；请切换到支持编辑的 Qwen Image 编辑模型或移除 referenceImagePaths`)
  }
  const submitUrl = `${baseUrl}/services/aigc/multimodal-generation/generation`
  const content: Array<Record<string, string>> = []
  for (const ref of references) {
    content.push({ image: `data:${ref.mediaType};base64,${ref.base64}` })
  }
  content.push({ text: input.prompt })
  const requestBody = {
    model,
    input: { messages: [{ role: 'user', content }] },
    parameters: buildDashscopeMultimodalImageParameters(input, model),
  }

  const response = await fetchFn(submitUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: input.signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`DashScope Qwen 生图失败 (${response.status}): ${text.slice(0, 300)}`)
  }
  const body = (await safeParseJson(response, 'DashScope Qwen 生图')) as DashscopeMultimodalImageResponse
  const images: GeneratedImageData[] = []
  const texts: string[] = []
  for (const choice of body.output?.choices ?? []) {
    for (const item of choice.message?.content ?? []) {
      if (typeof item.image === 'string' && item.image.trim()) {
        const inline = imageDataFromInlineValue(item.image)
        images.push(inline ?? await downloadAsBase64(item.image, fetchFn, input.signal))
      }
      if (typeof item.text === 'string' && item.text.trim()) texts.push(item.text.trim())
    }
  }
  if (images.length === 0) throw new Error('DashScope Qwen 生图成功但未返回图片')
  return { images, text: texts.length > 0 ? texts.join('\n') : undefined }
}

async function callDashscopeImageApi(
  input: GenerateMediaInput, fetchFn: typeof globalThis.fetch, references: ReferenceFile[],
): Promise<GenerateMediaOutput> {
  const { baseUrl, model, editModel } = input.config
  if (!baseUrl) throw new Error('dashscope-async 缺少 baseUrl')
  const requestedEdit = !!input.isEdit && references.length > 0
  const isLegacyEdit = requestedEdit && !!editModel && !isQwenImage2Model(model)
  const effectiveModel = isLegacyEdit ? editModel! : model

  // qwen-image-2.0-pro / qwen-image-max / qwen-image-plus 等新版 Qwen 生图，以及
  // wan2.6/wan2.7-image、z-image-turbo 使用同步 multimodal-generation 接口；
  // 不能走旧 text2image/image-synthesis 异步任务，否则 DashScope 会返回 “url error”。
  if (isDashscopeMultimodalImageModel(effectiveModel) && effectiveModel !== 'qwen-image-edit') {
    return callDashscopeMultimodalImageApi(input, fetchFn, references, effectiveModel)
  }

  // M2 修复：仅 qwen-image-edit 支持编辑（接受 base64 data URI）；万相 imageedit 需公网 URL，不支持
  const submitUrl = isLegacyEdit
    ? `${baseUrl}/services/aigc/image-generation/generation`
    : `${baseUrl}/services/aigc/text2image/image-synthesis`

  const size = formatDashscopeImageSize(resolveRequestedSize(input) || input.config.preset?.defaultSize || '1024*1024', effectiveModel)
  const parameters: Record<string, unknown> = { size, n: input.numberOfImages ?? 1 }
  if (input.negativePrompt) parameters.negative_prompt = input.negativePrompt
  if (input.seed !== undefined) parameters.seed = input.seed
  if (input.promptEnhance !== undefined) parameters.prompt_extend = input.promptEnhance
  if (input.watermark !== undefined) parameters.watermark = input.watermark
  const requestBody: Record<string, unknown> = isLegacyEdit
    ? {
        model: effectiveModel,
        input: { prompt: input.prompt, image_url: references[0] ? `data:${references[0].mediaType};base64,${references[0].base64}` : undefined },
        parameters,
      }
    : {
        model: effectiveModel,
        input: { prompt: input.prompt },
        parameters,
      }

  const submitRes = await fetchFn(submitUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
    body: JSON.stringify(requestBody), signal: input.signal,
  })
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => '')
    throw new Error(`DashScope 提交任务失败 (${submitRes.status}): ${text.slice(0, 300)}`)
  }
  const submitBody = (await safeParseJson(submitRes, 'DashScope 提交')) as DashscopeTaskResponse
  const taskId = submitBody.output?.task_id
  if (!taskId) throw new Error(`DashScope 未返回 task_id: ${submitBody.output?.message ?? '未知错误'}`)
  return pollTask(taskId, baseUrl, input.apiKey, fetchFn, input.signal, input.pollIntervalMs ?? POLL_INTERVAL_MS, IMAGE_POLL_TIMEOUT_MS, 'DashScope')
}

/**
 * 智能路由：HappyHorse / wan2.7 系列根据参考图数量 + 用途语义（referenceMode）
 * 自动选择 t2v/i2v/r2v 变体。非该系列模型返回 null（不做路由）。
 *
 * 路由规则：
 *   0 张参考图        → t2v
 *   ≥2 张参考图       → r2v（参考生视频，无歧义）
 *   恰好 1 张参考图   → 由 referenceMode 决定：'reference'→r2v，否则→i2v（首帧，默认）
 *
 * 匹配的系列（不含 videoedit）：
 *   happyhorse-1.x-t2v / happyhorse-1.x-i2v / happyhorse-1.x-r2v
 *   wan2.7-t2v / wan2.7-i2v / wan2.7-r2v（含 -2026-xx-xx 日期快照）
 */
export function resolveDashscopeVideoVariant(
  model: string,
  refCount: number,
  referenceMode?: 'first_frame' | 'reference',
): string | null {
  // happyhorse-1.x-{variant}（x 可为 0 或 1，兼容 1.0/1.1），保留完整 "happyhorse-1.x" 前缀与可选日期快照
  const hh = model.match(/^(happyhorse-\d+\.\d+)-(?:t2v|i2v|r2v)(-\d{4}-\d{2}-\d{2})?$/)
  // wan2.7-{variant}，保留完整 "wan2.7" 前缀与可选日期快照
  const wan = !hh ? model.match(/^(wan2\.7)-(?:t2v|i2v|r2v)(-\d{4}-\d{2}-\d{2})?$/) : null
  const base = hh?.[1] ?? wan?.[1]
  if (!base) return null
  const suffix = hh?.[2] ?? wan?.[2] ?? ''
  const targetVariant = refCount === 0 ? 't2v' : refCount >= 2 ? 'r2v' : (referenceMode === 'reference' ? 'r2v' : 'i2v')
  return `${base}-${targetVariant}${suffix}`
}

function isUrlLike(value?: string): boolean {
  return !!value && /^(?:https?:\/\/|oss:\/\/)/i.test(value)
}

function dashscopeReferenceDataUrl(ref: ReferenceFile): string {
  return `data:${ref.mediaType};base64,${ref.base64}`
}

function dashscopeRequestedResolution(input: GenerateMediaInput): string | undefined {
  if (input.resolution) {
    const normalized = normalizeDashscopeResolution(input.resolution)
    if (!normalized) throw new Error(`DashScope 视频分辨率仅支持 720P 或 1080P，当前传入: ${input.resolution}`)
    return normalized
  }
  const requestedSize = resolveRequestedSize(input)
  if (!requestedSize) return undefined
  const normalized = normalizeDashscopeResolution(requestedSize)
  if (normalized) return normalized
  if (/(?:^|[^a-z0-9])4k(?:[^a-z0-9]|$)|2160p|3840\s*[*xX×]\s*2160|2160\s*[*xX×]\s*3840/i.test(requestedSize)) {
    throw new Error('DashScope 视频分辨率仅支持 720P 或 1080P，不支持 4K')
  }
  const parsed = parseSize(requestedSize)
  return parsed?.h && parsed.h >= 1080 ? '1080P' : '720P'
}

function normalizeDashscopeResolution(value?: string): '720P' | '1080P' | undefined {
  const text = value?.trim()
  if (!text) return undefined
  if (/^720p$/i.test(text)) return '720P'
  if (/^1080p$/i.test(text)) return '1080P'
  if (/^(?:hd|高清)$/i.test(text)) return '720P'
  if (/^(?:fhd|full\s*hd|全高清)$/i.test(text)) return '1080P'
  const parsed = parseSize(text)
  if (parsed) {
    const longSide = Math.max(parsed.w, parsed.h)
    const shortSide = Math.min(parsed.w, parsed.h)
    if (longSide <= 1500 && shortSide <= 1100) return '720P'
    if (longSide <= 2100 && shortSide <= 1700) return '1080P'
    return undefined
  }
  return undefined
}

function resolveDashscopeDurationSeconds(input: GenerateMediaInput): number | undefined {
  return input.duration ?? parseDurationSecondsFromText(input.prompt)
}

function normalizeIntegerDuration(value: number, model: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${model} 的 duration 需要传整数秒`)
  }
  return value
}

function assertDurationRange(model: string, duration: number, min: number, max: number, extra = ''): void {
  if (duration < min || duration > max) {
    throw new Error(`${model} 的 duration 支持 ${min}~${max} 秒整数${extra}`)
  }
}

function dashscopeVideoUrl(input: GenerateMediaInput): string | undefined {
  const value = input.videoUrl ?? input.videoPath
  if (!value) return undefined
  if (!isUrlLike(value)) {
    throw new Error('DashScope 视频素材需要公网 HTTP(S) URL 或 OSS 临时 URL；本地视频文件请先上传后通过 videoUrl 传入')
  }
  return value
}

async function callDashscopeVideoApi(input: GenerateMediaInput, fetchFn: typeof globalThis.fetch, references: ReferenceFile[]): Promise<GenerateMediaOutput> {
  const { baseUrl } = input.config
  if (!baseUrl) throw new Error('dashscope-async 缺少 baseUrl')
  // 智能路由：HappyHorse / wan2.7 系列按参考图数量 + referenceMode 选择变体。
  // 非该系列模型 resolveDashscopeVideoVariant 返回 null，保持原 model 不变。
  const initialIsWan27 = input.config.model.startsWith('wan2.7')
  const hasVideoInput = initialIsWan27 && !!(input.videoUrl ?? input.videoPath)
  const routeRefCount = hasVideoInput ? Math.max(1, references.length) : references.length
  const routed = resolveDashscopeVideoVariant(input.config.model, routeRefCount, input.referenceMode)
  const model = routed ?? input.config.model
  const isHappyHorse = model.startsWith('happyhorse-')
  const isWan27 = model.startsWith('wan2.7')
  // 模型变体判定：t2v（文生）/ i2v（首帧图生）/ r2v（参考图生）/ videoedit（视频编辑）
  // HappyHorse 与 wan2.7 均使用 DashScope 新接口（resolution + ratio），不再用 size。
  const isT2v = /(?:^|-)t2v(?:-|$)/.test(model)
  const isI2v = /(?:^|-)i2v(?:-|$)/.test(model) || /(?:^|-)kf2v(?:-|$)/.test(model)
  const isR2v = /(?:^|-)r2v(?:-|$)/.test(model)
  const isVideoEdit = /(?:^|-)video-?edit(?:-|$)/.test(model)
  const videoUrl = dashscopeVideoUrl(input)
  const needsImageRef = (isI2v && !videoUrl) || isR2v
  const requestedSize = resolveRequestedSize(input)
  const aspectRatio = sizeToAspectRatio(requestedSize || input.config.preset?.defaultSize || '16:9') ?? '16:9'
  if (needsImageRef && references.length === 0) {
    const hint = isR2v ? '（参考生视频可提供最多 9 张参考图）' : ''
    throw new Error(`${model} 需要参考图，请先提供路径（referencePaths）或把图片拖到对话框里${hint}`)
  }
  if (isVideoEdit && !videoUrl) {
    throw new Error(`${model} 是视频编辑模型，需要通过 videoUrl 提供待编辑视频的公网 HTTP(S) URL 或 OSS 临时 URL`)
  }
  if (videoUrl && isHappyHorse && !isVideoEdit) {
    throw new Error('HappyHorse 仅视频编辑模型支持 videoUrl；文生/图生/参考生视频请使用文本和 referenceImagePaths')
  }
  const parameters: Record<string, unknown> = {}
  const resolution = dashscopeRequestedResolution(input)
  if (resolution) parameters.resolution = resolution
  const requestedDuration = resolveDashscopeDurationSeconds(input)
  if (requestedDuration !== undefined) {
    const duration = normalizeIntegerDuration(requestedDuration, model)
    if (isHappyHorse && isVideoEdit) {
      throw new Error('happyhorse-1.0-video-edit 不支持通过 duration 指定输出时长；输出时长跟随输入视频，最长 15 秒')
    } else if (isHappyHorse) {
      assertDurationRange(model, duration, 3, 15)
      parameters.duration = duration
    } else if (isWan27 && isVideoEdit) {
      if (duration !== 0) assertDurationRange(model, duration, 2, 10, '，或传 0 表示跟随输入视频')
      parameters.duration = duration
    } else if (isWan27 && isR2v && videoUrl) {
      assertDurationRange(model, duration, 2, 10, '（参考视频输入场景）')
      parameters.duration = duration
    } else if (isWan27) {
      assertDurationRange(model, duration, 2, 15)
      parameters.duration = duration
    } else if (!isVideoEdit) {
      parameters.duration = duration
    }
  }
  if (!isVideoEdit && (isT2v || isR2v)) parameters.ratio = aspectRatio
  if (isVideoEdit && input.size) parameters.ratio = aspectRatio
  // prompt_extend 仅 wan2.7 文档支持；HappyHorse 过滤未知字段，避免 400。
  if (isWan27 && input.promptEnhance !== undefined) parameters.prompt_extend = input.promptEnhance
  if (input.seed !== undefined) parameters.seed = input.seed
  if (input.watermark !== undefined) parameters.watermark = input.watermark
  if (input.audioSetting && isVideoEdit) parameters.audio_setting = input.audioSetting
  const mediaInput: Record<string, unknown> = { prompt: input.prompt }
  if (isWan27 && input.negativePrompt) mediaInput.negative_prompt = input.negativePrompt
  if (isWan27 && isT2v && input.audioUrl) mediaInput.audio_url = input.audioUrl
  const media: Array<Record<string, string>> = []
  const imageRefs = references.filter((ref) => ref.mediaType.startsWith('image/'))
  const buildImageItem = (type: string, ref: ReferenceFile) => ({ type, url: dashscopeReferenceDataUrl(ref) })
  if (isI2v) {
    if (videoUrl) {
      media.push({ type: 'first_clip', url: videoUrl })
    } else if (imageRefs[0]) {
      media.push(buildImageItem('first_frame', imageRefs[0]))
    }
    if (isWan27 && input.lastFramePath) {
      const lastFrame = readReferenceFiles([input.lastFramePath], input.cwd).find((ref) => ref.mediaType.startsWith('image/'))
      if (!lastFrame) throw new Error('已提供 lastFrameImagePath，但没有可用图片文件')
      media.push(buildImageItem('last_frame', lastFrame))
    }
    if (isWan27 && input.audioUrl) media.push({ type: 'driving_audio', url: input.audioUrl })
  } else if (isR2v) {
    const maxImages = isHappyHorse ? 9 : 5
    for (const ref of imageRefs.slice(0, maxImages)) media.push(buildImageItem('reference_image', ref))
    if (isWan27 && videoUrl) media.push({ type: 'reference_video', url: videoUrl })
    if (isWan27 && input.audioUrl) mediaInput.reference_voice = input.audioUrl
  } else if (isVideoEdit) {
    media.push({ type: 'video', url: videoUrl! })
    const maxImages = isHappyHorse ? 5 : 4
    for (const ref of imageRefs.slice(0, maxImages)) media.push(buildImageItem('reference_image', ref))
  }
  if (media.length > 0) {
    mediaInput.media = media
  }
  const body: Record<string, unknown> = {
    model,
    input: mediaInput,
    parameters,
  }
  const endpoint = `${baseUrl}/services/aigc/video-generation/video-synthesis`
  const submitRes = await fetchFn(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
    body: JSON.stringify(body), signal: input.signal,
  })
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => '')
    throw new Error(`DashScope 视频提交失败 (${submitRes.status}): ${text.slice(0, 300)}`)
  }
  const submitBody = (await safeParseJson(submitRes, 'DashScope 视频')) as DashscopeTaskResponse
  const taskId = submitBody.output?.task_id
  if (!taskId) throw new Error(`DashScope 视频未返回 task_id: ${submitBody.output?.message ?? '未知错误'}`)
  return pollTask(taskId, baseUrl, input.apiKey, fetchFn, input.signal, input.pollIntervalMs ?? POLL_INTERVAL_MS, VIDEO_POLL_TIMEOUT_MS, 'DashScope 视频', 'video/mp4')
}

const DASHSCOPE_ACTIVE_TASK_STATUSES = new Set(['PENDING', 'RUNNING', 'QUEUED', 'STARTING', 'PROCESSING'])
const DASHSCOPE_FAILURE_TASK_STATUSES = new Set([
  'FAILED', 'FAILURE', 'CANCELED', 'CANCELLED', 'ABORTED', 'TIMEOUT', 'TIMED_OUT',
  'STOPPED', 'REJECTED', 'ERROR', 'UNKNOWN',
])

/** 通用 dashscope 任务轮询 */
async function pollTask(
  taskId: string, baseUrl: string, apiKey: string,
  fetchFn: typeof globalThis.fetch, signal: AbortSignal | undefined,
  pollIntervalMs: number, timeoutMs: number, label: string, fallbackMediaType = 'image/png',
): Promise<GenerateMediaOutput> {
  const queryUrl = `${baseUrl}/tasks/${taskId}`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (Date.now() > deadline) throw new Error(`${label} 任务轮询超时（${timeoutMs / 1000}s）: task_id=${taskId}`)
    if (pollIntervalMs > 0) await sleep(pollIntervalMs, signal)
    const res = await fetchFn(queryUrl, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`${label} 查询失败 (${res.status}): ${text.slice(0, 300)}`)
    }
    const body = (await safeParseJson(res, label)) as DashscopeTaskResponse
    const status = body.output?.task_status
    const upperStatus = typeof status === 'string' ? status.trim().toUpperCase() : ''
    if (upperStatus === 'SUCCEEDED') {
      const images: GeneratedImageData[] = []
      // 图像：output.results[].url / b64_image
      for (const r of body.output?.results ?? []) {
        if (r.url) images.push(await downloadAsBase64(r.url, fetchFn, signal, fallbackMediaType))
        else if (r.b64_image) images.push({ mediaType: fallbackMediaType, data: r.b64_image })
      }
      // 视频：output.video_url（单字符串，万相/HappyHorse 文生视频用此字段）
      if (body.output?.video_url) {
        images.push(await downloadAsBase64(body.output.video_url, fetchFn, signal, fallbackMediaType))
      }
      if (images.length === 0) throw new Error(`${label} 任务成功但未返回内容`)
      return { images }
    }
    if (!upperStatus) throw new Error(`${label} 查询响应缺少 task_status: task_id=${taskId}`)

    if (DASHSCOPE_ACTIVE_TASK_STATUSES.has(upperStatus)) continue

    if (DASHSCOPE_FAILURE_TASK_STATUSES.has(upperStatus) || /FAIL|CANCEL|ABORT|ERROR|TIMEOUT|STOP|REJECT/.test(upperStatus)) {
      throw new Error(`${label} 任务失败 (${status}): ${body.output?.message ?? body.output?.code ?? '未知错误'}`)
    }

    // 未知状态不应静默轮询到硬超时；直接暴露协议变化，便于及时适配厂商新增状态。
    throw new Error(`${label} 返回未知任务状态 (${status}): task_id=${taskId}`)
  }
}

// ===== 协议族：dashscope-sync（CosyVoice TTS） =====

const QWEN_TTS_VOICES = [
  'Cherry',
  'Serena',
  'Chelsie',
  'Momo',
  'Vivian',
  'Maia',
  'Bella',
  'Katerina',
  'Ethan',
  'Moon',
  'Kai',
  'Nofish',
  'Ryan',
  'Eldric Sage',
  'Mochi',
  'Vincent',
  'Neil',
  'Jada',
  'Dylan',
  'Li',
  'Marcus',
  'Roy',
  'Peter',
  'Sunny',
  'Eric',
  'Rocky',
  'Kiki',
] as const

function normalizeQwenVoiceKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

const QWEN_TTS_VOICE_BY_KEY = new Map<string, string>(
  QWEN_TTS_VOICES.map((voice) => [normalizeQwenVoiceKey(voice), voice]),
)

function resolveQwenTtsVoice(voice: string | undefined): string {
  const raw = voice?.trim()
  if (!raw) return 'Cherry'

  const known = QWEN_TTS_VOICE_BY_KEY.get(normalizeQwenVoiceKey(raw))
  if (known) return known

  if (/粤语|广东话|广东/i.test(raw)) return /女/.test(raw) ? 'Kiki' : 'Rocky'
  if (/四川|川普/i.test(raw)) return /女/.test(raw) ? 'Sunny' : 'Eric'
  if (/上海/i.test(raw)) return 'Jada'
  if (/北京/i.test(raw)) return 'Dylan'
  if (/南京/i.test(raw)) return 'Li'
  if (/陕西/i.test(raw)) return 'Marcus'
  if (/闽南|台语/i.test(raw)) return 'Roy'
  if (/天津/i.test(raw)) return 'Peter'
  if (/老者|沧桑|长者|老人/i.test(raw)) return 'Eldric Sage'
  if (/新闻|播音|主播/i.test(raw)) return 'Neil'
  if (/戏剧|夸张|高能|情绪张力/i.test(raw)) return 'Ryan'
  if (/风趣|幽默|搞笑|俏皮|不吃鱼/i.test(raw)) return 'Nofish'
  if (/沙哑|烟嗓|烟音/i.test(raw)) return 'Vincent'
  if (/成熟|成熟女|御姐|稳重女|大气女/i.test(raw)) return 'Katerina'
  if (/温柔|知性|柔和|舒缓|轻柔/i.test(raw)) return /女/.test(raw) ? 'Serena' : 'Ethan'
  if (/傲娇/i.test(raw)) return 'Vivian'
  if (/动漫|女友/i.test(raw)) return 'Chelsie'
  if (/少女|活泼|元气|可爱|甜美/i.test(raw)) return 'Momo'
  if (/低沉|浑厚|磁性|朗诵/i.test(raw)) return 'Kai'
  if (/俊朗|潇洒|帅气/i.test(raw)) return 'Moon'
  if (/青年|年轻|机灵/i.test(raw)) return 'Mochi'
  if (/男/i.test(raw)) return 'Kai'
  if (/女|中文|普通话|亲切/i.test(raw)) return 'Cherry'

  return 'Cherry'
}

async function callDashscopeTtsApi(input: GenerateMediaInput, fetchFn: typeof globalThis.fetch): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('dashscope-sync 缺少 baseUrl')
  const audioFormat = input.audioFormat ?? 'mp3'
  
  const isQwenTts = model.startsWith('qwen3-tts')
  const parameters: Record<string, unknown> = {
    voice: isQwenTts ? resolveQwenTtsVoice(input.voice) : (input.voice ?? 'longxiaochun'),
    format: audioFormat
  }
  if (input.speed !== undefined) {
    // qwen3-tts 官方字段是 speed；CosyVoice 官方字段是 rate。两者各发各的字段，
    // 避免对某一方下发未知参数触发 DashScope 400（该平台对未知参数校验较严格）。
    if (isQwenTts) parameters.speed = input.speed
    else parameters.rate = input.speed
  }
  if (input.volume !== undefined) parameters.volume = input.volume
  if (input.pitch !== undefined) parameters.pitch = input.pitch
  
  if (isQwenTts) {
    if (input.instruction?.trim()) {
      parameters.instructions = input.instruction.trim()
      parameters.optimize_instructions = true
    }
  }

  const urlPath = isQwenTts ? 'services/aigc/multimodal-generation/generation' : 'services/audio/tts/text2audio'
  const res = await fetchFn(`${baseUrl}/${urlPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: { text: input.prompt },
      parameters,
    }),
    signal: input.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${isQwenTts ? 'Qwen' : 'CosyVoice'} TTS 错误 (${res.status}): ${text.slice(0, 300)}`)
  }
  const body = (await safeParseJson(res, isQwenTts ? 'Qwen TTS' : 'CosyVoice TTS')) as {
    output?: { audio?: { data?: string; url?: string }; url?: string; audio_format?: string }
  }
  const data = body.output?.audio?.data
  const url = body.output?.url ?? body.output?.audio?.url
  if (data) return { images: [{ mediaType: audioMimeForFormat(audioFormat), data }] }
  if (url) return { images: [await downloadAsBase64(url, fetchFn, input.signal, audioMimeForFormat(audioFormat))] }
  throw new Error(`${isQwenTts ? 'Qwen' : 'CosyVoice'} TTS 未返回音频数据`)
}


// ===== 协议族：volcengine-tts（火山语音 Seed Audio 1.0，HTTP 非流式） =====

async function callVolcengineTtsApi(
  input: GenerateMediaInput,
  fetchFn: typeof globalThis.fetch,
  references: ReferenceFile[],
): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('volcengine-tts 缺少 baseUrl')
  const audioFormat = input.audioFormat ?? 'mp3'
  const body: Record<string, unknown> = {
    model,
    text_prompt: input.prompt,
  }
  // speaker 与参考音频互斥：有参考音频时走参考音频生成模式，否则用 speaker（若提供）
  if (references.length > 0) {
    body.references = references.map((ref) => ({ audio_data: ref.base64 }))
  } else if (input.voice?.trim()) {
    body.speaker = input.voice.trim()
  }
  const audioConfig: Record<string, unknown> = {
    format: audioFormat,
    sample_rate: 24000,
  }
  if (input.speed !== undefined) audioConfig.speech_rate = input.speed
  if (input.volume !== undefined) audioConfig.loudness_rate = input.volume
  if (input.pitch !== undefined) audioConfig.pitch_rate = input.pitch
  body.audio_config = audioConfig

  const res = await fetchFn(`${baseUrl}/api/v3/tts/create`, {
    method: 'POST',
    headers: {
      'X-Api-Key': input.apiKey,
      'X-Api-Request-Id': randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: input.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`火山语音 TTS 失败 (${res.status}): ${text.slice(0, 300)}`)
  }
  const resp = (await safeParseJson(res, '火山语音 TTS')) as {
    code?: number
    message?: string
    audio?: string
    url?: string
  }
  // 火山语音 TTS 成功码为 3000，非 3000 视为错误
  if (resp.code !== undefined && resp.code !== 3000) {
    throw new Error(`火山语音 TTS 错误 (${resp.code}): ${resp.message ?? '未知错误'}`)
  }
  if (resp.audio) return { images: [{ mediaType: audioMimeForFormat(audioFormat), data: resp.audio }] }
  if (resp.url) return { images: [await downloadAsBase64(resp.url, fetchFn, input.signal, audioMimeForFormat(audioFormat))] }
  throw new Error('火山语音 TTS 未返回音频数据')
}

// ===== 协议族：volcengine-plan-tts（火山 Agent Plan Seed TTS 2.0，HTTP 单向流式） =====

async function callVolcenginePlanTtsApi(
  input: GenerateMediaInput,
  fetchFn: typeof globalThis.fetch,
): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('volcengine-plan-tts 缺少 baseUrl')
  const audioFormat = input.audioFormat ?? 'mp3'
  const body = {
    req_params: {
      text: input.prompt,
      speaker: input.voice?.trim() || 'zh_female_gaolengyujie_uranus_bigtts',
      audio_params: {
        format: audioFormat,
        sample_rate: 24000,
      },
    },
  }
  const res = await fetchFn(`${baseUrl}/api/v3/plan/tts/unidirectional`, {
    method: 'POST',
    headers: {
      'X-Api-Key': input.apiKey,
      'X-Api-Resource-Id': 'seed-tts-2.0',
      'X-Api-Connect-Id': randomUUID(),
      'Content-Type': 'application/json',
      'Connection': 'keep-alive',
    },
    body: JSON.stringify(body),
    signal: input.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Agent Plan TTS 失败 (${res.status}): ${text.slice(0, 300)}`)
  }
  // 响应为 NDJSON（每行一个 JSON），逐行解析拼接 base64 音频片段。
  const rawText = await res.text()
  const chunks: Buffer[] = []
  let lastCode = 0
  let lastMessage = ''
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: { code?: number; data?: string; message?: string }
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (parsed.data) {
      chunks.push(Buffer.from(parsed.data, 'base64'))
    }
    if (typeof parsed.code === 'number') {
      lastCode = parsed.code
      if (parsed.message) lastMessage = parsed.message
    }
    // code=20000000 表示全部音频已返回完毕
    if (parsed.code === 20000000) break
  }
  if (lastCode > 0 && lastCode !== 20000000) {
    throw new Error(`Agent Plan TTS 错误 (${lastCode}): ${lastMessage || '未知错误'}`)
  }
  if (chunks.length === 0) throw new Error('Agent Plan TTS 未返回音频数据')
  const combined = Buffer.concat(chunks).toString('base64')
  return { images: [{ mediaType: audioMimeForFormat(audioFormat), data: combined }] }
}
// ===== 协议族：dashscope-voice-clone（CosyVoice 声音复刻，两步） =====

async function callDashscopeVoiceCloneApi(
  input: GenerateMediaInput, fetchFn: typeof globalThis.fetch, references: ReferenceFile[],
): Promise<GenerateMediaOutput> {
  if (references.length === 0) throw new Error('声音复刻需要提供样本音频路径（referencePaths）')
  const { baseUrl } = input.config
  if (!baseUrl) throw new Error('dashscope-voice-clone 缺少 baseUrl')
  const sample = references[0]!
  // Step 1: 创建音色（customization 接口，baseUrl 已含 /api/v1）
  const cloneRes = await fetchFn(`${baseUrl}/services/audio/tts/customization`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'voice-enrollment',
      input: { audio_url: `data:${sample.mediaType};base64,${sample.base64}` },
    }),
    signal: input.signal,
  })
  if (!cloneRes.ok) {
    const text = await cloneRes.text().catch(() => '')
    throw new Error(`CosyVoice 声音复刻创建失败 (${cloneRes.status}): ${text.slice(0, 300)}`)
  }
  const cloneBody = (await safeParseJson(cloneRes, '声音复刻')) as { output?: { voice_id?: string }; message?: string }
  const voiceId = cloneBody.output?.voice_id
  if (!voiceId) throw new Error(`声音复刻未返回 voice_id: ${cloneBody.message ?? '未知错误'}`)
  // Step 2: 用克隆音色合成
  return callDashscopeTtsApi({ ...input, voice: voiceId }, fetchFn)
}

// ===== 协议族：volcengine-async（豆包 Seedance 视频） =====

interface VolcTaskResponse {
  id?: string
  status?: string
  content?: { video_url?: string; file_url?: string; last_frame_url?: string }
  error?: { message?: string }
}

function normalizeSeedanceModel(model: string): string {
  // 兼容旧 UI/历史配置里的大小写模型名；火山新模型统一使用小写。
  if (/^doubao-Seedance-1-0-pro-t2v-250428$/.test(model)) return 'doubao-seedance-1-0-pro-250528'
  return model
}

async function callVolcengineVideoApi(input: GenerateMediaInput, fetchFn: typeof globalThis.fetch, references: ReferenceFile[]): Promise<GenerateMediaOutput> {
  const { baseUrl } = input.config
  if (!baseUrl) throw new Error('volcengine-async 缺少 baseUrl')
  const model = normalizeSeedanceModel(input.config.model)
  const ref = references[0]
  const body: Record<string, unknown> = {
    model,
    content: ref
      ? [
          { type: 'text', text: input.prompt },
          { type: 'image_url', image_url: { url: `data:${ref.mediaType};base64,${ref.base64}` } },
        ]
      : [{ type: 'text', text: input.prompt }],
  }
  const ratio = sizeToAspectRatio(resolveRequestedSize(input))
  if (ratio) body.ratio = ratio
  if (input.duration !== undefined) body.duration = input.duration
  if (input.resolution) body.resolution = input.resolution
  if (input.fps !== undefined) body.framespersecond = input.fps
  if (input.frames !== undefined) body.frames = input.frames
  if (input.seed !== undefined) body.seed = input.seed
  if (input.cameraFixed !== undefined) body.camera_fixed = input.cameraFixed
  if (input.watermark !== undefined) body.watermark = input.watermark
  if (input.withAudio !== undefined) body.generate_audio = input.withAudio
  if (input.returnLastFrame !== undefined) body.return_last_frame = input.returnLastFrame
  const submitRes = await fetchFn(`${baseUrl}/contents/generations/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: input.signal,
  })
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => '')
    throw new Error(`Seedance 提交失败 (${submitRes.status}): ${text.slice(0, 300)}`)
  }
  const submitBody = (await safeParseJson(submitRes, 'Seedance')) as VolcTaskResponse
  const taskId = submitBody.id
  if (!taskId) throw new Error('Seedance 未返回 task id')

  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error(`Seedance 轮询超时: ${taskId}`)
    if ((input.pollIntervalMs ?? POLL_INTERVAL_MS) > 0) await sleep(input.pollIntervalMs ?? POLL_INTERVAL_MS, input.signal)
    const res = await fetchFn(`${baseUrl}/contents/generations/tasks/${taskId}`, {
      method: 'GET', headers: { Authorization: `Bearer ${input.apiKey}` }, signal: input.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Seedance 查询失败 (${res.status}): ${text.slice(0, 300)}`)
    }
    const body = (await safeParseJson(res, 'Seedance 查询')) as VolcTaskResponse
    if (body.status === 'succeeded') {
      const videoUrl = body.content?.video_url ?? body.content?.file_url
      if (!videoUrl) throw new Error('Seedance 成功但未返回视频 URL')
      return { images: [await downloadAsBase64(videoUrl, fetchFn, input.signal, 'video/mp4')] }
    }
    if (body.status === 'failed') throw new Error(`Seedance 失败: ${body.error?.message ?? '未知错误'}`)
  }
}

// ===== 协议族：kling-async（可灵视频） =====

interface KlingTaskResponse {
  code?: number
  message?: string
  data?: { task_id?: string; task_status?: string; task_result?: { videos?: Array<{ url?: string }> } }
}

async function callKlingVideoApi(input: GenerateMediaInput, fetchFn: typeof globalThis.fetch, references: ReferenceFile[]): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('kling-async 缺少 baseUrl')
  const ref = references[0]
  const body: Record<string, unknown> = {
    model,
    prompt: input.prompt,
    duration: input.duration ?? 5,
    aspect_ratio: sizeToAspectRatio(resolveRequestedSize(input)) ?? '16:9',
    // 可灵 image 字段接受公网 URL 或裸 base64；这里不要加 Data URI 前缀。
    ...(ref ? { image: ref.base64 } : {}),
  }
  if (input.negativePrompt) body.negative_prompt = input.negativePrompt
  if (input.mode) body.mode = input.mode
  if (input.guidanceScale !== undefined) body.cfg_scale = input.guidanceScale
  if (input.cameraFixed !== undefined) body.camera_control = { type: input.cameraFixed ? 'fixed' : 'none' }
  let authHeader = `Bearer ${input.apiKey}`
  if (input.apiKey.includes(':')) {
    const [ak, sk] = input.apiKey.split(':')
    if (ak && sk) {
      try {
        const token = generateKlingJwt(ak.trim(), sk.trim())
        authHeader = `Bearer ${token}`
      } catch (err) {
        console.error('[Kling Auth] JWT Generation failed:', err)
      }
    }
  }

  const submitRes = await fetchFn(`${baseUrl}/v1/videos/${ref ? 'image2video' : 'text2video'}`, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: input.signal,
  })
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => '')
    throw new Error(`可灵提交失败 (${submitRes.status}): ${text.slice(0, 300)}`)
  }
  const submitBody = (await safeParseJson(submitRes, '可灵')) as KlingTaskResponse
  const taskId = submitBody.data?.task_id
  if (!taskId) throw new Error(`可灵未返回 task_id: ${submitBody.message ?? '未知错误'}`)

  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error(`可灵轮询超时: ${taskId}`)
    if ((input.pollIntervalMs ?? POLL_INTERVAL_MS) > 0) await sleep(input.pollIntervalMs ?? POLL_INTERVAL_MS, input.signal)
    
    let currentAuthHeader = `Bearer ${input.apiKey}`
    if (input.apiKey.includes(':')) {
      const [ak, sk] = input.apiKey.split(':')
      if (ak && sk) {
        try {
          const token = generateKlingJwt(ak.trim(), sk.trim())
          currentAuthHeader = `Bearer ${token}`
        } catch (err) {
          console.error('[Kling Auth] JWT Generation failed:', err)
        }
      }
    }

    const res = await fetchFn(`${baseUrl}/v1/videos/${ref ? 'image2video' : 'text2video'}/${taskId}`, {
      method: 'GET', headers: { Authorization: currentAuthHeader }, signal: input.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`可灵查询失败 (${res.status}): ${text.slice(0, 300)}`)
    }
    const body = (await safeParseJson(res, '可灵查询')) as KlingTaskResponse
    const status = body.data?.task_status
    if (status === 'succeed') {
      const videoUrl = body.data?.task_result?.videos?.[0]?.url
      if (!videoUrl) throw new Error('可灵成功但未返回视频 URL')
      return { images: [await downloadAsBase64(videoUrl, fetchFn, input.signal, 'video/mp4')] }
    }
    if (status === 'failed') throw new Error(`可灵失败: ${body.message ?? '未知错误'}`)
  }
}

function generateKlingJwt(ak: string, sk: string): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: ak,
    exp: now + 1800, // Valid for 30 minutes
    nbf: now - 5,
  }
  
  const base64Url = (str: string | Buffer): string => {
    const base64 = typeof str === 'string'
      ? Buffer.from(str).toString('base64')
      : str.toString('base64')
    return base64
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
  }
  
  const headerPart = base64Url(JSON.stringify(header))
  const payloadPart = base64Url(JSON.stringify(payload))
  
  const hmac = createHmac('sha256', sk)
  hmac.update(`${headerPart}.${payloadPart}`)
  const signaturePart = base64Url(hmac.digest())
  
  return `${headerPart}.${payloadPart}.${signaturePart}`
}

// ===== 协议族：zhipu-async（CogVideoX 视频 / GLM-TTS / GLM-TTS-Clone） =====

interface ZhipuAsyncResponse {
  id?: string
  task_status?: string
  video_result?: Array<{ url?: string; cover_image_url?: string }>
  output?: { audio?: string; url?: string }
  message?: string
}

function normalizeZhipuVideoModel(model: string): string {
  if (/^CogVideoX-3$/i.test(model)) return 'cogvideox-3'
  if (/^CogVideoX-Flash$/i.test(model)) return 'cogvideox-flash'
  if (/^CogVideoX-2$/i.test(model)) return 'cogvideox-2'
  return model
}

function formatZhipuVideoSize(size: string | undefined, model: string): string | undefined {
  const normalized = size ? normalizeSizeText(size, 'video') ?? size.trim() : undefined
  if (!normalized) return undefined
  const ratio = /^\d+\s*:\s*\d+$/.test(normalized) ? normalized.replace(/\s+/g, '') : sizeToAspectRatio(normalized)
  const isCogVideoX3 = /^cogvideox-3$/i.test(model)
  const ratioMap = isCogVideoX3
    ? { '1:1': '1024x1024', '16:9': '1920x1080', '9:16': '1080x1920', '4:3': '1280x720', '3:4': '720x1280' } as Record<string, string>
    : { '1:1': '1024x1024', '16:9': '1920x1080', '9:16': '1080x1920', '4:3': '1280x960', '3:4': '960x1280' } as Record<string, string>
  if (ratio && ratioMap[ratio] && !parseSize(normalized)) return ratioMap[ratio]
  const parsed = parseSize(normalized)
  if (!parsed) return undefined
  const value = `${parsed.w}x${parsed.h}`
  const allowed = isCogVideoX3
    ? new Set(['1280x720', '720x1280', '1024x1024', '1920x1080', '1080x1920', '2048x1080', '3840x2160'])
    : new Set(['720x480', '1024x1024', '1280x960', '960x1280', '1920x1080', '1080x1920', '2048x1080', '3840x2160'])
  if (allowed.has(value)) return value
  return ratio && ratioMap[ratio] ? ratioMap[ratio] : (parsed.w >= parsed.h ? '1920x1080' : '1080x1920')
}

async function callZhipuVideoApi(input: GenerateMediaInput, fetchFn: typeof globalThis.fetch, references: ReferenceFile[]): Promise<GenerateMediaOutput> {
  const { baseUrl } = input.config
  if (!baseUrl) throw new Error('zhipu-async 缺少 baseUrl')
  const model = normalizeZhipuVideoModel(input.config.model)
  const ref = references[0]
  const requestBody: Record<string, unknown> = {
    model,
    prompt: input.prompt,
  }
  if (ref) requestBody.image_url = `data:${ref.mediaType};base64,${ref.base64}`
  const size = formatZhipuVideoSize(resolveRequestedSize(input) || input.config.preset?.defaultSize, model)
  if (size) requestBody.size = size
  if (input.fps !== undefined) requestBody.fps = input.fps
  if (input.duration !== undefined) requestBody.duration = input.duration
  if (input.mode === 'speed' || input.mode === 'quality') requestBody.quality = input.mode
  if (input.withAudio !== undefined) requestBody.with_audio = input.withAudio
  if (input.watermark !== undefined) requestBody.watermark_enabled = input.watermark
  const submitRes = await fetchFn(`${baseUrl}/videos/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: input.signal,
  })
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => '')
    throw new Error(`智谱视频提交失败 (${submitRes.status}): ${text.slice(0, 300)}`)
  }
  const submitBody = (await safeParseJson(submitRes, '智谱视频')) as ZhipuAsyncResponse
  const taskId = submitBody.id
  if (!taskId) throw new Error(`智谱视频未返回 task_id: ${submitBody.message ?? '未知错误'}`)

  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error(`智谱视频轮询超时: ${taskId}`)
    if ((input.pollIntervalMs ?? POLL_INTERVAL_MS) > 0) await sleep(input.pollIntervalMs ?? POLL_INTERVAL_MS, input.signal)
    const res = await fetchFn(`${baseUrl}/async-result/${taskId}`, {
      method: 'GET', headers: { Authorization: `Bearer ${input.apiKey}` }, signal: input.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`智谱视频查询失败 (${res.status}): ${text.slice(0, 300)}`)
    }
    const body = (await safeParseJson(res, '智谱视频查询')) as ZhipuAsyncResponse
    if (body.task_status === 'SUCCESS') {
      const videoUrl = body.video_result?.[0]?.url
      if (!videoUrl) throw new Error('智谱视频成功但未返回视频 URL')
      return { images: [await downloadAsBase64(videoUrl, fetchFn, input.signal, 'video/mp4')] }
    }
    if (body.task_status === 'FAIL') throw new Error(`智谱视频失败: ${body.message ?? '未知错误'}`)
  }
}

async function callZhipuTtsApi(input: GenerateMediaInput, fetchFn: typeof globalThis.fetch): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('zhipu-async 缺少 baseUrl')
  const audioFormat = input.audioFormat ?? 'wav'
  if (audioFormat !== 'wav' && audioFormat !== 'pcm') {
    throw new Error('GLM-TTS 仅支持 audioFormat=wav 或 pcm')
  }
  const body: Record<string, unknown> = {
    model,
    input: input.prompt,
    voice: input.voice ?? 'tongtong',
    response_format: audioFormat,
    stream: false,
  }
  if (input.speed !== undefined) body.speed = input.speed
  if (input.volume !== undefined) body.volume = input.volume
  if (input.watermark !== undefined) body.watermark_enabled = input.watermark
  const res = await fetchFn(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: input.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GLM-TTS 错误 (${res.status}): ${text.slice(0, 300)}`)
  }
  const contentType = res.headers.get('content-type')?.split(';')[0]?.trim()
  if (contentType?.includes('json')) {
    const parsed = (await safeParseJson(res, 'GLM-TTS')) as ZhipuAsyncResponse
    const data = parsed.output?.audio
    if (data) return { images: [{ mediaType: audioMimeForFormat(audioFormat), data }] }
    throw new Error('GLM-TTS 未返回音频数据')
  }
  const arrayBuffer = await res.arrayBuffer()
  return { images: [{ mediaType: contentType || audioMimeForFormat(audioFormat), data: Buffer.from(arrayBuffer).toString('base64') }] }
}

async function uploadZhipuVoiceCloneFile(
  baseUrl: string,
  apiKey: string,
  sample: ReferenceFile,
  fetchFn: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData()
  form.append('purpose', 'voice-clone-input')
  form.append('file', new Blob([Buffer.from(sample.base64, 'base64')], { type: sample.mediaType }), sample.filename)
  const res = await fetchFn(`${baseUrl}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GLM-TTS-Clone 样本上传失败 (${res.status}): ${text.slice(0, 300)}`)
  }
  const body = (await safeParseJson(res, 'GLM-TTS-Clone 样本上传')) as { id?: string; message?: string }
  if (!body.id) throw new Error(`GLM-TTS-Clone 样本上传未返回 file_id: ${body.message ?? '未知错误'}`)
  return body.id
}

async function callZhipuVoiceCloneApi(
  input: GenerateMediaInput, fetchFn: typeof globalThis.fetch, references: ReferenceFile[],
): Promise<GenerateMediaOutput> {
  if (references.length === 0) throw new Error('声音复刻需要提供样本音频路径（referencePaths）')
  const { baseUrl } = input.config
  if (!baseUrl) throw new Error('zhipu-async 缺少 baseUrl')
  const sample = references[0]!
  const fileId = await uploadZhipuVoiceCloneFile(baseUrl, input.apiKey, sample, fetchFn, input.signal)
  const voiceName = (input.voice?.trim() || `runai_clone_${Date.now()}`).replace(/[^\w-]/g, '_').slice(0, 64)
  // Step 1: 用上传后的 file_id 创建克隆音色。智谱接口会返回 voice，可继续用于 /audio/speech 合成。
  const cloneRes = await fetchFn(`${baseUrl}/voice/clone`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-tts-clone',
      voice_name: voiceName,
      input: input.prompt,
      file_id: fileId,
    }),
    signal: input.signal,
  })
  if (!cloneRes.ok) {
    const text = await cloneRes.text().catch(() => '')
    throw new Error(`GLM-TTS-Clone 声音复刻失败 (${cloneRes.status}): ${text.slice(0, 300)}`)
  }
  const cloneBody = (await safeParseJson(cloneRes, 'GLM-TTS-Clone')) as { voice?: string; voice_id?: string; message?: string }
  const voiceId = cloneBody.voice ?? cloneBody.voice_id
  if (!voiceId) throw new Error(`GLM-TTS-Clone 未返回 voice: ${cloneBody.message ?? '未知错误'}`)
  // Step 2: 用克隆音色合成语音
  return callZhipuTtsApi({ ...input, voice: voiceId }, fetchFn)
}

// ===== 协议族：minimax（图像 / 视频 / 音频 / 音乐） =====

// M6 修复：透传 n
async function callMinimaxImageApi(
  input: GenerateMediaInput, fetchFn: typeof globalThis.fetch, references: ReferenceFile[] = [],
): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('minimax 缺少 baseUrl')
  const requestBody: Record<string, unknown> = {
    model, prompt: input.prompt,
    aspect_ratio: sizeToAspectRatio(resolveRequestedSize(input) || input.config.preset?.defaultSize),
    n: input.numberOfImages ?? 1,
    response_format: 'url',
  }
  if (input.seed !== undefined) requestBody.seed = input.seed
  if (input.promptEnhance !== undefined) requestBody.prompt_optimizer = input.promptEnhance
  
  const ref = references[0]
  if (ref) {
    requestBody.subject_reference = [
      {
        type: 'character',
        image_file: `data:${ref.mediaType};base64,${ref.base64}`,
      },
    ]
  }

  const res = await fetchFn(`${baseUrl}/image_generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: input.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`MiniMax 图片 API 错误 (${res.status}): ${text.slice(0, 300)}`)
  }
  const body = (await safeParseJson(res, 'MiniMax 图片')) as { data?: { image_urls?: string[]; base64?: string }; base_resp?: { status_msg?: string } }
  if ((!body.data?.image_urls || body.data.image_urls.length === 0) && body.base_resp?.status_msg) {
    throw new Error(`MiniMax 生成失败: ${body.base_resp.status_msg}`)
  }
  const images: GeneratedImageData[] = []
  for (const url of body.data?.image_urls ?? []) images.push(await downloadAsBase64(url, fetchFn, input.signal))
  if (images.length === 0 && body.data?.base64) images.push({ mediaType: 'image/png', data: body.data.base64 })
  // M2 修复：空结果给出明确错误而非静默返回空
  if (images.length === 0) {
    throw new Error('MiniMax 未返回图片（请检查模型名、API Key 权限或额度）')
  }
  return { images }
}

async function callMinimaxVideoApi(input: GenerateMediaInput, fetchFn: typeof globalThis.fetch, references: ReferenceFile[]): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('minimax 缺少 baseUrl')
  const ref = references[0]
  const body: Record<string, unknown> = {
    model,
    prompt: input.prompt,
    ...(ref ? { first_frame_image: `data:${ref.mediaType};base64,${ref.base64}` } : {}),
  }
  if (input.duration !== undefined) body.duration = input.duration
  // MiniMax 要求分辨率档位带大写 P（720P / 768P / 1080P），agent 常传小写（720p），
  // 这里归一化大小写，避免 "does not support resolution 1080p" 类报错。
  if (input.resolution) body.resolution = input.resolution.replace(/p$/i, 'P')
  if (input.promptEnhance !== undefined) body.prompt_optimizer = input.promptEnhance
  if (input.watermark !== undefined) body.aigc_watermark = input.watermark
  const submitRes = await fetchFn(`${baseUrl}/video_generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: input.signal,
  })
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => '')
    throw new Error(`MiniMax 视频提交失败 (${submitRes.status}): ${text.slice(0, 300)}`)
  }
  const submitBody = (await safeParseJson(submitRes, 'MiniMax 视频')) as { task_id?: string; base_resp?: { status_msg?: string } }
  const taskId = submitBody.task_id
  if (!taskId) throw new Error(`MiniMax 视频未返回 task_id: ${submitBody.base_resp?.status_msg ?? '未知错误'}`)

  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error(`MiniMax 视频轮询超时: ${taskId}`)
    if ((input.pollIntervalMs ?? POLL_INTERVAL_MS) > 0) await sleep(input.pollIntervalMs ?? POLL_INTERVAL_MS, input.signal)
    const res = await fetchFn(`${baseUrl}/query/video_generation?task_id=${taskId}`, {
      method: 'GET', headers: { Authorization: `Bearer ${input.apiKey}` }, signal: input.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`MiniMax 视频查询失败 (${res.status}): ${text.slice(0, 300)}`)
    }
    const body = (await safeParseJson(res, 'MiniMax 视频查询')) as {
      status?: string; file_id?: string; videos?: Array<{ url?: string }>; base_resp?: { status_msg?: string }
    }
    if (body.status === 'Success') {
      const videoUrl = body.videos?.[0]?.url
      if (!videoUrl && body.file_id) {
        const retrievedUrl = await retrieveMinimaxFileDownloadUrl(baseUrl, input.apiKey, body.file_id, fetchFn, input.signal)
        return { images: [await downloadAsBase64(retrievedUrl, fetchFn, input.signal, 'video/mp4')] }
      }
      if (!videoUrl) throw new Error('MiniMax 视频成功但未返回 URL 或 file_id')
      return { images: [await downloadAsBase64(videoUrl, fetchFn, input.signal, 'video/mp4')] }
    }
    if (body.status === 'Failed' || body.status === 'Fail') throw new Error(`MiniMax 视频失败: ${body.base_resp?.status_msg ?? '未知错误'}`)
  }
}

async function retrieveMinimaxFileDownloadUrl(
  baseUrl: string,
  apiKey: string,
  fileId: string,
  fetchFn: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetchFn(`${baseUrl}/files/retrieve?file_id=${encodeURIComponent(fileId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`MiniMax 视频文件下载地址获取失败 (${res.status}): ${text.slice(0, 300)}`)
  }
  const body = (await safeParseJson(res, 'MiniMax 视频文件')) as {
    file?: { download_url?: string }
    base_resp?: { status_msg?: string }
  }
  const downloadUrl = body.file?.download_url
  if (!downloadUrl) {
    throw new Error(`MiniMax 视频文件未返回 download_url: ${body.base_resp?.status_msg ?? '未知错误'}`)
  }
  return downloadUrl
}

const MINIMAX_TTS_VOICE_ALIASES: Record<string, string> = {
  'male-qn-qingse': 'male-qn-qingse',
  'male-qn-jingying': 'male-qn-jingying',
  'male-qn-badao': 'male-qn-badao',
  'male-qn-daxuesheng': 'male-qn-daxuesheng',
  'female-shaonv': 'female-shaonv',
  'female-yujie': 'female-yujie',
  'female-chengshu': 'female-chengshu',
  'female-tianmei': 'female-tianmei',
  'audiobook_male_1': 'audiobook_male_1',
  'audiobook_female_1': 'audiobook_female_1',
  clever_boy: 'clever_boy',
  cute_boy: 'cute_boy',
  lovely_girl: 'lovely_girl',
  cartoon_pig: 'cartoon_pig',
  bingjiao_didi: 'bingjiao_didi',
  junlang_nanyou: 'junlang_nanyou',
  chunzhen_xuedi: 'chunzhen_xuedi',
  lengdan_xiongzhang: 'lengdan_xiongzhang',
  badao_shaoye: 'badao_shaoye',
  tianxin_xiaoling: 'tianxin_xiaoling',
  qiaopi_mengmei: 'qiaopi_mengmei',
  wumei_yujie: 'wumei_yujie',
  diadia_xuemei: 'diadia_xuemei',
  danya_xuejie: 'danya_xuejie',
  Cantonese_ProfessionalHostF: 'Cantonese_ProfessionalHost（F)',
  Cantonese_ProfessionalHostM: 'Cantonese_ProfessionalHost（M)',
  Cantonese_GentleLady: 'Cantonese_GentleLady',
  Cantonese_PlayfulMan: 'Cantonese_PlayfulMan',
  Cantonese_CuteGirl: 'Cantonese_CuteGirl',
  Cantonese_KindWoman: 'Cantonese_KindWoman',
}

function normalizeMinimaxVoiceKey(value: string): string {
  return value.trim().toLowerCase().replace(/[（）()_\s-]+/g, '')
}

const MINIMAX_TTS_VOICE_BY_KEY = new Map<string, string>(
  Object.entries(MINIMAX_TTS_VOICE_ALIASES).flatMap(([alias, voice]) => [
    [normalizeMinimaxVoiceKey(alias), voice] as const,
    [normalizeMinimaxVoiceKey(voice), voice] as const,
  ]),
)

function looksLikeMinimaxCustomVoiceId(value: string): boolean {
  return /^v[a-z0-9]{6,}$/i.test(value.trim())
}

function looksLikeMinimaxSystemVoiceId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_（）() -]*$/.test(value.trim()) && /[_-]|[（）()]/.test(value)
}

function resolveMinimaxTtsVoice(voice: string | undefined, defaultVoice: string): string {
  const raw = voice?.trim()
  if (!raw) return defaultVoice
  if (looksLikeMinimaxCustomVoiceId(raw)) return raw

  const known = MINIMAX_TTS_VOICE_BY_KEY.get(normalizeMinimaxVoiceKey(raw))
  if (known) return known
  if (looksLikeMinimaxSystemVoiceId(raw)) return raw

  if (/粤语|广东话|广东|cantonese/i.test(raw)) {
    if (/女|female|lady|girl/i.test(raw)) return 'Cantonese_GentleLady'
    return 'Cantonese_PlayfulMan'
  }
  if (/童|儿童|小孩|孩子|child|kid|boy/i.test(raw)) return /女|girl/i.test(raw) ? 'lovely_girl' : 'clever_boy'
  if (/新闻|主播|anchor/i.test(raw)) return /女|female|lady|woman/i.test(raw) ? 'Chinese (Mandarin)_News_Anchor' : 'Chinese (Mandarin)_Male_Announcer'
  if (/播报|播音|announcer/i.test(raw)) return /女|female|lady|woman/i.test(raw) ? 'Chinese (Mandarin)_News_Anchor' : 'Chinese (Mandarin)_Male_Announcer'
  if (/电台|主持|host/i.test(raw)) return 'Chinese (Mandarin)_Radio_Host'
  if (/御姐|姐姐|成熟女|成熟女性|adult woman|mature woman/i.test(raw)) return /御姐/.test(raw) ? 'female-yujie' : 'female-chengshu'
  if (/成熟男|稳重男|沉稳|高管|executive/i.test(raw)) return 'Chinese (Mandarin)_Reliable_Executive'
  if (/温柔|柔和|轻柔|舒缓|gentle|soft/i.test(raw)) return /男|male|man/i.test(raw) ? 'Chinese (Mandarin)_Gentleman' : 'Chinese (Mandarin)_Soft_Girl'
  if (/甜美|甜心|sweet/i.test(raw)) return 'female-tianmei'
  if (/少女|清脆|元气|活泼|young girl/i.test(raw)) return 'female-shaonv'
  if (/可爱|萌|cute/i.test(raw)) return /男|male|boy/i.test(raw) ? 'cute_boy' : 'lovely_girl'
  if (/御姐|妩媚|魅惑/i.test(raw)) return 'wumei_yujie'
  if (/霸道/i.test(raw)) return 'male-qn-badao'
  if (/俊朗|男友|帅气/i.test(raw)) return 'junlang_nanyou'
  if (/青年|大学生|年轻男/i.test(raw)) return 'male-qn-daxuesheng'
  if (/新闻|播报|播音|主播|announcer|anchor/i.test(raw)) return 'male-qn-jingying'
  if (/低沉|浑厚|磁性|朗诵|成熟男|male|man|男/i.test(raw)) return 'male-qn-jingying'
  if (/女|female|girl|lady|woman/i.test(raw)) return 'female-tianmei'

  if (/[\u3400-\u9fff]/.test(raw) || /\b(voice|male|female|girl|boy|man|woman|gentle|warm|sweet|deep)\b/i.test(raw)) {
    return defaultVoice
  }
  return raw
}

async function callMinimaxTtsApi(input: GenerateMediaInput, fetchFn: typeof globalThis.fetch): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('minimax 缺少 baseUrl')
  const audioFormat = input.audioFormat ?? 'mp3'
  const voiceSetting: Record<string, unknown> = { voice_id: resolveMinimaxTtsVoice(input.voice, 'male-qn-qingse') }
  if (input.speed !== undefined) voiceSetting.speed = input.speed
  if (input.volume !== undefined) voiceSetting.vol = input.volume
  if (input.pitch !== undefined) voiceSetting.pitch = input.pitch
  const res = await fetchFn(`${baseUrl}/t2a_v2`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model, text: input.prompt, voice_setting: voiceSetting,
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: audioFormat },
    }),
    signal: input.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`MiniMax TTS 错误 (${res.status}): ${text.slice(0, 300)}`)
  }
  const body = (await safeParseJson(res, 'MiniMax TTS')) as {
    data?: { audio?: string; hex_data?: string }; extra_info?: { audio_format?: string }
    base_resp?: { status_msg?: string }
  }
  if (body.data?.audio) {
    return { images: [{ mediaType: audioMimeForFormat(audioFormat), data: base64FromMinimaxAudioPayload(body.data.audio, audioFormat) }] }
  }
  if (body.data?.hex_data) {
    return { images: [{ mediaType: audioMimeForFormat(audioFormat), data: Buffer.from(body.data.hex_data, 'hex').toString('base64') }] }
  }
  throw new Error(`MiniMax TTS 未返回音频: ${body.base_resp?.status_msg ?? '未知错误'}`)
}

async function callMinimaxAsyncTtsApi(input: GenerateMediaInput, fetchFn: typeof globalThis.fetch): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('minimax-tts-async 缺少 baseUrl')
  const audioFormat = input.audioFormat ?? 'mp3'
  const voiceSetting: Record<string, unknown> = { voice_id: resolveMinimaxTtsVoice(input.voice, 'audiobook_male_1') }
  if (input.speed !== undefined) voiceSetting.speed = input.speed
  if (input.volume !== undefined) voiceSetting.vol = input.volume
  if (input.pitch !== undefined) voiceSetting.pitch = input.pitch
  const audioSetting: Record<string, unknown> = {
    audio_sample_rate: input.sampleRate ?? 32000,
    bitrate: input.bitrate ?? 128000,
    format: audioFormat,
    channel: 2,
  }
  const submitRes = await fetchFn(`${baseUrl}/t2a_async_v2`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      text: input.prompt,
      language_boost: 'auto',
      voice_setting: voiceSetting,
      audio_setting: audioSetting,
    }),
    signal: input.signal,
  })
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => '')
    throw new Error(`MiniMax 异步 TTS 创建失败 (${submitRes.status}): ${text.slice(0, 300)}`)
  }
  const submitBody = (await safeParseJson(submitRes, 'MiniMax 异步 TTS')) as {
    task_id?: string | number
    file_id?: string | number
    base_resp?: { status_code?: number; status_msg?: string }
  }
  if (submitBody.base_resp && submitBody.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 异步 TTS 创建失败: ${submitBody.base_resp.status_msg ?? submitBody.base_resp.status_code}`)
  }
  const taskId = submitBody.task_id
  if (!taskId) throw new Error(`MiniMax 异步 TTS 未返回 task_id: ${submitBody.base_resp?.status_msg ?? '未知错误'}`)

  const deadline = Date.now() + AUDIO_POLL_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error(`MiniMax 异步 TTS 轮询超时（${AUDIO_POLL_TIMEOUT_MS / 1000}s）: ${taskId}`)
    if ((input.pollIntervalMs ?? POLL_INTERVAL_MS) > 0) await sleep(input.pollIntervalMs ?? POLL_INTERVAL_MS, input.signal)
    const queryRes = await fetchFn(`${baseUrl}/query/t2a_async_query_v2?task_id=${encodeURIComponent(String(taskId))}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: input.signal,
    })
    if (!queryRes.ok) {
      const text = await queryRes.text().catch(() => '')
      throw new Error(`MiniMax 异步 TTS 查询失败 (${queryRes.status}): ${text.slice(0, 300)}`)
    }
    const queryBody = (await safeParseJson(queryRes, 'MiniMax 异步 TTS 查询')) as {
      status?: string
      file_id?: string | number
      base_resp?: { status_code?: number; status_msg?: string }
    }
    if (queryBody.status === 'Success' || queryBody.status === 'success') {
      const fileId = queryBody.file_id ?? submitBody.file_id
      if (!fileId) throw new Error('MiniMax 异步 TTS 成功但未返回 file_id')
      const downloadUrl = await retrieveMinimaxFileDownloadUrl(baseUrl, input.apiKey, String(fileId), fetchFn, input.signal)
      return { images: [await downloadMinimaxAudioAsBase64(downloadUrl, fetchFn, input.signal, audioMimeForFormat(audioFormat))] }
    }
    if (queryBody.status === 'Failed' || queryBody.status === 'Fail' || queryBody.status === 'failed') {
      throw new Error(`MiniMax 异步 TTS 失败: ${queryBody.base_resp?.status_msg ?? '未知错误'}`)
    }
  }
}

async function callMinimaxMusicApi(input: GenerateMediaInput, fetchFn: typeof globalThis.fetch): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('minimax 缺少 baseUrl')

  // 内部超时与调用方取消合并：长任务不能沿用过短的定时器策略，但用户明确
  // 取消 MCP 请求时仍必须立即停止后续网络请求和可能产生费用的生成任务。
  const timeout = createInternalTimeoutSignal(MUSIC_SYNC_TIMEOUT_MS, input.signal)
  const musicSignal = timeout.signal
  try {
    let coverFeatureId = input.coverFeatureId
    let lyrics = input.lyrics
    const reference = input.referencePaths?.[0] ? readReferenceFiles([input.referencePaths[0]], input.cwd)[0] : undefined
    if (/^music-cover(?:-|$)/.test(model) && !coverFeatureId && reference) {
      const preprocessRes = await fetchFn(`${baseUrl}/music_cover_preprocess`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          audio_base64: reference.base64,
        }),
        signal: musicSignal,
      })
      if (!preprocessRes.ok) {
        const text = await preprocessRes.text().catch(() => '')
        throw new Error(`MiniMax 翻唱前处理失败 (${preprocessRes.status}): ${text.slice(0, 300)}`)
      }
      const preprocessBody = (await safeParseJson(preprocessRes, 'MiniMax 翻唱前处理')) as {
        cover_feature_id?: string
        formatted_lyrics?: string
        base_resp?: { status_code?: number; status_msg?: string }
      }
      if (preprocessBody.base_resp && preprocessBody.base_resp.status_code !== 0) {
        throw new Error(`MiniMax 翻唱前处理失败: ${preprocessBody.base_resp.status_msg ?? preprocessBody.base_resp.status_code}`)
      }
      coverFeatureId = preprocessBody.cover_feature_id
      lyrics = lyrics ?? preprocessBody.formatted_lyrics
      if (!coverFeatureId) throw new Error('MiniMax 翻唱前处理未返回 cover_feature_id')
    }

    const audioFormat = input.audioFormat ?? 'mp3'
    // 兜底：music 任务缺 lyrics 时，MiniMax 会报 "lyrics is required"。
    // agent 常把歌词误塞进 prompt 而忘传 lyrics，这里把 prompt 降级为歌词，并自动开启
    // lyrics_optimizer（让模型据 prompt 润色词作结构），保证无论 agent 如何传参都不崩。
    // 纯音乐（instrumental）允许留空歌词。
    let effectiveLyrics = lyrics
    let effectiveLyricsOptimizer = input.lyricsOptimizer
    if (!effectiveLyrics && !input.instrumental) {
      effectiveLyrics = input.prompt?.trim() || undefined
      if (effectiveLyrics) effectiveLyricsOptimizer = effectiveLyricsOptimizer ?? true
    }
    const body: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      audio_setting: {
        sample_rate: input.sampleRate ?? 44100,
        bitrate: input.bitrate ?? 256000,
        format: audioFormat,
      },
    }
    if (effectiveLyrics) body.lyrics = effectiveLyrics
    if (input.instrumental !== undefined) body.is_instrumental = input.instrumental
    if (effectiveLyricsOptimizer !== undefined) body.lyrics_optimizer = effectiveLyricsOptimizer
    if (input.musicOutputFormat) body.output_format = input.musicOutputFormat
    if (input.aigcWatermark !== undefined) body.aigc_watermark = input.aigcWatermark
    if (coverFeatureId) body.cover_feature_id = coverFeatureId
    if (input.audioUrl) body.audio_url = input.audioUrl
    if (/^music-cover(?:-|$)/.test(model) && reference && !coverFeatureId) body.audio_base64 = reference.base64

    const res = await fetchFn(`${baseUrl}/music_generation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: musicSignal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`MiniMax 音乐生成失败 (${res.status}): ${text.slice(0, 300)}`)
    }
    const responseBody = (await safeParseJson(res, 'MiniMax 音乐生成')) as {
      data?: { audio?: string; audio_url?: string; status?: number }
      base_resp?: { status_code?: number; status_msg?: string }
    }
    if (responseBody.base_resp && responseBody.base_resp.status_code !== 0) {
      throw new Error(`MiniMax 音乐生成失败: ${responseBody.base_resp.status_msg ?? responseBody.base_resp.status_code}`)
    }
    const audio = responseBody.data?.audio
    const audioUrl = responseBody.data?.audio_url ?? (/^https?:\/\//.test(String(audio ?? '')) ? String(audio) : undefined)
    if (audioUrl) {
      timeout.clear()
      const downloadTimeout = createInternalTimeoutSignal(MUSIC_DOWNLOAD_TIMEOUT_MS, input.signal)
      try {
        return { images: [await downloadAsBase64(audioUrl, fetchFn, downloadTimeout.signal, audioMimeForFormat(audioFormat))] }
      } catch (err) {
        if (downloadTimeout.timedOut()) {
          throw new Error(`MiniMax 音乐音频下载超时（${MUSIC_DOWNLOAD_TIMEOUT_MS / 1000}s）：生成已完成，但下载音频文件耗时过长`)
        }
        throw err
      } finally {
        downloadTimeout.clear()
      }
    }
    if (audio) {
      return { images: [{ mediaType: audioMimeForFormat(audioFormat), data: base64FromHexAudioPayload(audio, 'MiniMax 音乐生成') }] }
    }
    throw new Error(`MiniMax 音乐生成未返回音频: ${responseBody.base_resp?.status_msg ?? '未知错误'}`)
  } catch (err) {
    if (timeout.timedOut()) {
      throw new Error(`MiniMax 音乐生成超时（${MUSIC_SYNC_TIMEOUT_MS / 1000}s）：该模型通常需要 30-120 秒，请稍后重试或检查 MiniMax 服务状态`)
    }
    throw err
  } finally {
    timeout.clear()
  }
}

async function callMinimaxVoiceCloneApi(
  input: GenerateMediaInput, fetchFn: typeof globalThis.fetch, references: ReferenceFile[],
): Promise<GenerateMediaOutput> {
  if (references.length === 0) throw new Error('声音复刻需要提供样本音频路径（referencePaths）')
  const { baseUrl } = input.config
  if (!baseUrl) throw new Error('minimax-voice-clone 缺少 baseUrl')
  const sample = references[0]!

  // Step 1: Upload the file
  const form = new FormData()
  form.append('purpose', 'voice_clone')
  form.append('file', new Blob([Buffer.from(sample.base64, 'base64')], { type: sample.mediaType }), sample.filename)
  
  const uploadRes = await fetchFn(`${baseUrl}/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}` },
    body: form,
    signal: input.signal,
  })
  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => '')
    throw new Error(`MiniMax 声音克隆音频上传失败 (${uploadRes.status}): ${text.slice(0, 300)}`)
  }
  const uploadBody = (await safeParseJson(uploadRes, 'MiniMax 声音上传')) as { file?: { id?: string | number; file_id?: string | number }; base_resp?: { status_msg?: string } }
  const fileId = uploadBody.file?.file_id ?? uploadBody.file?.id
  if (!fileId) throw new Error(`MiniMax 声音上传未返回 file_id: ${uploadBody.base_resp?.status_msg ?? '未知错误'}`)

  // Step 2: Create the cloned voice
  const voiceId = 'v' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
  const cloneRes = await fetchFn(`${baseUrl}/voice_clone`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      voice_id: voiceId,
      file_id: fileId,
    }),
    signal: input.signal,
  })
  if (!cloneRes.ok) {
    const text = await cloneRes.text().catch(() => '')
    throw new Error(`MiniMax 声音克隆任务失败 (${cloneRes.status}): ${text.slice(0, 300)}`)
  }
  const cloneBody = (await safeParseJson(cloneRes, 'MiniMax 声音克隆')) as { base_resp?: { status_code?: number; status_msg?: string } }
  if (cloneBody.base_resp && cloneBody.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 声音克隆生成失败: ${cloneBody.base_resp.status_msg ?? cloneBody.base_resp.status_code}`)
  }

  // Step 3: 用克隆音色合成 TTS；MiniMax t2a_v2 不接受带 -clone 后缀的模型名。
  const actualModel = input.config.model.replace(/-clone$/, '')
  const ttsInput: GenerateMediaInput = {
    ...input,
    voice: voiceId,
    config: {
      ...input.config,
      model: actualModel,
    }
  }
  return callMinimaxAsyncTtsApi(ttsInput, fetchFn)
}

// ===== 协议族：stability（Core / Ultra / SD3 / SD3.5 同步） =====

/**
 * Stability AI v2beta 文生图。
 * 端点 POST {base}/{model}（SD3/SD3.5 家族共用 /sd3），multipart/form-data。
 * Accept: application/json → 返回 {image: base64, finish_reason, seed}。
 */
async function callStabilityImageApi(input: GenerateMediaInput, fetchFn: typeof globalThis.fetch): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('stability 缺少 baseUrl')
  // baseUrl 形如 https://api.stability.ai/v2beta/stable-image/generate，拼上 /{model}
  const endpointModel = model.startsWith('sd3') ? 'sd3' : model
  const url = `${baseUrl.replace(/\/$/, '')}/${endpointModel}`
  const form = new FormData()
  form.append('prompt', input.prompt)
  if (endpointModel === 'sd3' && model !== 'sd3') {
    // Stability 的 SD3/SD3.5 家族共用 /sd3 端点，通过 model 字段选择具体模型。
    form.append('model', model)
  }
  // Stability 接受 aspect_ratio（如 1:1 / 16:9）；size 若为比例直接用，否则换算
  const aspect = resolveRequestedSize(input) || input.config.preset?.defaultSize || '1:1'
  form.append('aspect_ratio', aspect.includes(':') ? aspect : (sizeToAspectRatio(aspect) ?? '1:1'))
  const outputFormat = input.outputFormat ?? 'png'
  form.append('output_format', outputFormat)
  if (input.negativePrompt) form.append('negative_prompt', input.negativePrompt)
  if (input.stylePreset) form.append('style_preset', input.stylePreset)
  if (input.guidanceScale !== undefined) form.append('cfg_scale', String(input.guidanceScale))
  if (input.seed !== undefined) form.append('seed', String(input.seed))
  else if (input.numberOfImages && input.numberOfImages > 1) {
    form.append('seed', String(Math.floor(Math.random() * 1_000_000)))
  }

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      Accept: 'application/json',
    },
    body: form,
    signal: input.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Stability 图片 API 错误 (${res.status}): ${text.slice(0, 300)}`)
  }
  const body = (await safeParseJson(res, 'Stability 图片')) as {
    image?: string
    finish_reason?: string
    seed?: number
  }
  if (typeof body.image !== 'string' || body.image.length === 0) {
    // 兜底：部分网关可能用 b64_json 字段
    const b64 = (body as { b64_json?: string }).b64_json
    if (b64) return { images: [{ mediaType: imageMimeForFormat(outputFormat), data: b64 }] }
    throw new Error('Stability 未返回图片数据')
  }
  return { images: [{ mediaType: imageMimeForFormat(outputFormat), data: body.image }] }
}


// ===== 协议族：midjourney（第三方 MJ 网关，midjourney-proxy 标准） =====

interface MjSubmitResponse {
  /** 1=成功 21=已存在 22=排队 24=拒绝(违规) */
  code?: number
  description?: string
  /** 成功时为任务 ID */
  result?: string
  properties?: Record<string, unknown>
}

interface MjTaskResponse {
  id?: string
  status?: 'NOT_START' | 'SUBMITTED' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILURE' | string
  progress?: string
  imageUrl?: string
  failReason?: string
  errorMessage?: string
}

/**
 * Midjourney 第三方网关（遵循 midjourney-proxy 标准）。
 *
 * 提交：POST {base}/mj/submit/imagine，body { botType:'MID_JOURNEY', prompt, ... }，
 *   返回 { code:1, result: taskId }（code 24 表示内容被拒）。
 * 轮询：GET {base}/mj/task/{id}/fetch，状态 SUCCESS 取 imageUrl，FAILURE 取 failReason。
 *
 * MJ prompt 支持 --ar/--v 等原生参数；size 若为 "16:9" 形态会拼成 --ar 16:9 附到 prompt 尾部。
 */
async function callMidjourneyApi(input: GenerateMediaInput, fetchFn: typeof globalThis.fetch): Promise<GenerateMediaOutput> {
  const { baseUrl } = input.config
  if (!baseUrl) throw new Error('midjourney 缺少 baseUrl（请填入第三方 MJ 网关地址，如 https://your-gateway.com）')

  // size/比例 → MJ 原生 --ar 参数
  let prompt = input.prompt
  const sizeRaw = resolveRequestedSize(input) || input.config.preset?.defaultSize
  const aspect = sizeToAspectRatio(sizeRaw)
  if (aspect && !/--ar\b/i.test(prompt)) {
    prompt = `${prompt} --ar ${aspect}`
  }
  // numberOfImages > 1 时 MJ 不支持 n，但可提示（MJ 默认出 4 图）
  if (input.numberOfImages && input.numberOfImages > 1 && !/--grid\b/i.test(prompt)) {
    // MJ imagine 本身返回 2x2 网格（4 张），无需额外参数
  }

  const submitRes = await fetchFn(`${baseUrl}/mj/submit/imagine`, {
    method: 'POST',
    headers: { 'mj-api-secret': input.apiKey, Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ botType: 'MID_JOURNEY', prompt }),
    signal: input.signal,
  })
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => '')
    throw new Error(`MJ 提交失败 (${submitRes.status}): ${text.slice(0, 300)}`)
  }
  const submitBody = (await safeParseJson(submitRes, 'MJ 提交')) as MjSubmitResponse
  // code 24 = 内容被拒绝；其他非 1/21/22 也视为失败
  if (submitBody.code === 24) {
    throw new Error(`Midjourney 拒绝生成（内容违规）: ${submitBody.description ?? '未知原因'}`)
  }
  if (submitBody.code !== 1 && submitBody.code !== 21 && submitBody.code !== 22) {
    throw new Error(`Midjourney 提交失败 (code=${submitBody.code}): ${submitBody.description ?? '未知错误'}`)
  }
  const taskId = submitBody.result
  if (!taskId) throw new Error(`Midjourney 未返回任务 ID: ${submitBody.description ?? '未知错误'}`)

  // 轮询任务状态
  const deadline = Date.now() + IMAGE_POLL_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error(`Midjourney 任务轮询超时: ${taskId}`)
    if ((input.pollIntervalMs ?? POLL_INTERVAL_MS) > 0) await sleep(input.pollIntervalMs ?? POLL_INTERVAL_MS, input.signal)
    const res = await fetchFn(`${baseUrl}/mj/task/${taskId}/fetch`, {
      method: 'GET',
      headers: { 'mj-api-secret': input.apiKey, Authorization: `Bearer ${input.apiKey}` },
      signal: input.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`MJ 查询失败 (${res.status}): ${text.slice(0, 300)}`)
    }
    const body = (await safeParseJson(res, 'MJ 查询')) as MjTaskResponse
    if (body.status === 'SUCCESS') {
      const imageUrl = body.imageUrl
      if (!imageUrl) throw new Error('Midjourney 成功但未返回 imageUrl')
      return { images: [await downloadAsBase64(imageUrl, fetchFn, input.signal, 'image/png')] }
    }
    if (body.status === 'FAILURE') {
      throw new Error(`Midjourney 生成失败: ${body.failReason ?? body.errorMessage ?? '未知错误'}`)
    }
  // NOT_START / SUBMITTED / IN_PROGRESS 继续轮询
  }
}

async function callTencentHunyuanAsyncApi(
  input: GenerateMediaInput, fetchFn: typeof globalThis.fetch, references?: ReferenceFile[],
): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('tencent-hunyuan-async 缺少 baseUrl')

  // 优先使用顶层 input.modality，避免 config.modality 与实际调用模态脱针
  const isVideo = input.modality === 'video'
  const pathPrefix = isVideo ? 'video' : 'image'

  const body: Record<string, unknown> = {
    model,
    prompt: input.prompt,
  }

  const ref = references?.[0]
  if (ref) {
    const dataUri = `data:${ref.mediaType};base64,${ref.base64}`
    if (isVideo) {
      body.image = dataUri
      body.first_frame_image = dataUri
    } else {
      body.image = dataUri
    }
  }

  const size = resolveRequestedSize(input)
  if (size) {
    const parsed = parseSize(size)
    if (parsed) {
      // TokenHub 图像/视频接口均接受 "W:H" 像素尺寸格式
      body.size = `${parsed.w}:${parsed.h}`
      body.width = parsed.w
      body.height = parsed.h
    }
    // 若 resolveRequestedSize 返回的是比例字符串（如 '16:9'），parseSize 会返回 null；
    // TokenHub 不接受比例格式，不传 size 参数，平台将使用默认分辨率。
  }
  const submitRes = await fetchFn(`${baseUrl}/api/${pathPrefix}/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: input.signal,
  })
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => '')
    throw new Error(`腾讯混元 Maas 提交失败 (${submitRes.status}): ${text.slice(0, 300)}`)
  }

  const submitBody = (await safeParseJson(submitRes, '腾讯混元 Maas')) as {
    code?: number
    message?: string
    error?: { message?: string }
    data?: { id?: string }
    id?: string
  }
  const id = submitBody.data?.id ?? submitBody.id
  if (!id) {
    const errorMsg = submitBody.error?.message ?? submitBody.message ?? '未知错误'
    throw new Error(`腾讯混元 Maas 提交失败: ${errorMsg}`)
  }

  const deadline = Date.now() + (isVideo ? VIDEO_POLL_TIMEOUT_MS : IMAGE_POLL_TIMEOUT_MS)
  for (;;) {
    if (Date.now() > deadline) throw new Error(`腾讯混元 Maas 任务轮询超时: ${id}`)
    if ((input.pollIntervalMs ?? POLL_INTERVAL_MS) > 0) await sleep(input.pollIntervalMs ?? POLL_INTERVAL_MS, input.signal)
    
    const res = await fetchFn(`${baseUrl}/api/${pathPrefix}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, id }),
      signal: input.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`腾讯混元 Maas 查询失败 (${res.status}): ${text.slice(0, 300)}`)
    }
    const body = (await safeParseJson(res, '腾讯混元 Maas 查询')) as {
      code?: number
      message?: string
      status?: string
      state?: string
      images?: Array<{ url?: string }>
      image_url?: string
      url?: string
      videos?: Array<{ url?: string }>
      video_url?: string
      error?: { message?: string }
      data?: any // Can be object or array
    }
    const status = String(body.status ?? body.state ?? (typeof body.data === 'object' && body.data !== null && !Array.isArray(body.data) ? (body.data.status ?? body.data.state) : '') ?? '').toUpperCase()
    if (status === 'SUCCEEDED' || status === 'SUCCESS' || status === 'COMPLETED' || status.includes('SUCC') || status.includes('COMP')) {
      if (isVideo) {
        const videoUrl = body.videos?.[0]?.url ?? 
                         body.video_url ?? 
                         body.url ?? 
                         (Array.isArray(body.data) ? (body.data[0]?.video_url ?? body.data[0]?.url) : undefined) ??
                         body.data?.videos?.[0]?.url ?? 
                         body.data?.video_url ?? 
                         body.data?.url
        if (!videoUrl) throw new Error('腾讯混元 Maas 成功但未返回视频 URL')
        return { images: [await downloadAsBase64(videoUrl, fetchFn, input.signal, 'video/mp4')] }
      } else {
        const imageUrl = body.images?.[0]?.url ?? 
                         body.image_url ?? 
                         body.url ?? 
                         (Array.isArray(body.data) ? body.data[0]?.url : undefined) ??
                         body.data?.images?.[0]?.url ?? 
                         body.data?.image_url ?? 
                         body.data?.url
        if (!imageUrl) throw new Error('腾讯混元 Maas 成功但未返回图像 URL')
        return { images: [await downloadAsBase64(imageUrl, fetchFn, input.signal, 'image/png')] }
      }
    }
    if (status === 'FAILED' || status === 'FAIL' || status.includes('FAIL')) {
      const errorMsg = body.error?.message ?? body.message ?? '未知错误'
      throw new Error(`腾讯混元 Maas 失败: ${errorMsg}`)
    }
  }
}

// ===== 协议族：google-interactions（Google Veo / Gemini Omni，视频，predictLongRunning 异步） =====

/** Google predictLongRunning 操作（Long-Running Operation）响应 */
interface GoogleLroResponse {
  /** 操作名，提交后返回；轮询时用作路径 */
  name?: string
  /** 是否完成 */
  done?: boolean
  error?: { code?: number; message?: string; status?: string }
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{
        video?: { uri?: string; gcsUri?: string }
      }>
      generatedVideos?: Array<{
        video?: { uri?: string; gcsUri?: string }
      }>
    }
  }
}

interface GoogleOmniVideoData {
  data?: string
  mimeType?: string
  mime_type?: string
  uri?: string
  fileId?: string
  file_id?: string
  name?: string
}

interface GoogleOmniContentItem extends GoogleOmniVideoData {
  type?: string
}

interface GoogleOmniInteractionResponse {
  id?: string
  name?: string
  output_video?: GoogleOmniVideoData
  outputVideo?: GoogleOmniVideoData
  steps?: Array<{
    content?: GoogleOmniContentItem[]
  }>
  error?: { code?: number; message?: string; status?: string }
}

const googleOmniInteractionHistory = new Map<string, string>()

function isGoogleOmniModel(model: string): boolean {
  return /^gemini-omni-/i.test(model)
}

/** Vertex 仅支持 Omni，不支持 Veo */
function isVertexSupportedGoogleOmniModel(model: string): boolean {
  return model.toLowerCase() === 'gemini-omni-flash-preview'
}

/** 轮询 headers：去掉 content-type（GET 不需要） */
function googlePollingHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'content-type') continue
    result[key] = value
  }
  return result
}

/** 下载 headers：API Key 场景需要 x-goog-api-key；OAuth 场景签名 URL 无需 header */
function googleMediaDownloadHeaders(
  headers: Record<string, string>,
  authKind: 'api-key' | 'oauth',
): Record<string, string> {
  if (authKind === 'api-key') return googlePollingHeaders(headers)
  return {}
}

/** predictLongRunning 操作轮询 URL：api-key 用 /v1beta/，oauth 用 /v1/ */
function resolveGooglePredictLongRunningPollUrl(
  submitUrl: string,
  operationName: string,
  authKind: 'api-key' | 'oauth',
): string {
  if (/^https?:\/\//i.test(operationName)) return operationName
  const url = new URL(submitUrl)
  if (authKind === 'oauth') {
    url.pathname = `/v1/${operationName.replace(/^\/+/, '')}`
    url.search = ''
    return url.toString()
  }
  url.pathname = `/v1beta/${operationName.replace(/^\/+/, '')}`
  url.search = ''
  return url.toString()
}

/** Omni file download URL：从 interactions URL 推导 files/:download 路径 */
function resolveGoogleOmniFileDownloadUrl(interactionsUrl: string, fileId: string, authKind: 'api-key' | 'oauth'): string {
  const url = new URL(interactionsUrl)
  const escapedFileId = encodeURIComponent(fileId)
  const interactionsIndex = url.pathname.lastIndexOf('/interactions')
  const prefix = interactionsIndex >= 0 ? url.pathname.slice(0, interactionsIndex) : '/v1beta'
  url.pathname = `${prefix}/files/${escapedFileId}:download`
  url.search = 'alt=media'
  if (authKind === 'api-key') {
    const apiKey = new URL(interactionsUrl).searchParams.get('key')
    if (apiKey) url.searchParams.set('key', apiKey)
  }
  return url.toString()
}

function normalizeVeoResolution(value?: string): '720p' | '1080p' | '4k' | undefined {
  const text = value?.trim().toLowerCase()
  if (!text) return undefined
  if (/(?:^|[^a-z0-9])4k(?:[^a-z0-9]|$)|2160p|3840\s*x\s*2160|2160\s*x\s*3840/.test(text)) return '4k'
  if (/1080p|1920\s*x\s*1080|1080\s*x\s*1920|full\s*hd|fhd/.test(text)) return '1080p'
  if (/720p|1280\s*x\s*720|720\s*x\s*1280|hd/.test(text)) return '720p'
  return undefined
}

function resolveVeoResolution(input: GenerateMediaInput): '720p' | '1080p' | '4k' | undefined {
  return normalizeVeoResolution(input.resolution)
    ?? normalizeVeoResolution(input.size)
    ?? normalizeVeoResolution(input.prompt)
}

function resolveVeoDurationSeconds(duration: number | undefined, mustUseEightSeconds: boolean): 4 | 6 | 8 | undefined {
  if (mustUseEightSeconds) return 8
  if (duration === undefined) return undefined
  if (duration <= 4) return 4
  if (duration <= 6) return 6
  return 8
}

function parseDurationSecondsFromText(text?: string): number | undefined {
  const match = text?.match(/(?:^|[^\d])(\d{1,2}(?:\.\d+)?)\s*(?:秒|s|sec|secs|second|seconds)(?:[^\d]|$)/i)
  if (!match?.[1]) return undefined
  const value = Number.parseFloat(match[1])
  return Number.isFinite(value) ? value : undefined
}

function resolveRequestedVeoDuration(input: GenerateMediaInput): number | undefined {
  return input.duration ?? parseDurationSecondsFromText(input.prompt)
}

function normalizeVeoPersonGeneration(value?: string): string | undefined {
  const text = value?.trim().toLowerCase()
  if (!text) return undefined
  if (['allow_all', 'allow_adult', 'dont_allow'].includes(text)) return text
  if (/adult|成年人|成人/.test(text)) return 'allow_adult'
  if (/all|所有|人物|人像|person|people/.test(text)) return 'allow_all'
  if (/none|no|dont|don.?t|禁止|不要|不允许/.test(text)) return 'dont_allow'
  return value?.trim()
}

function buildVeoMediaPart(ref: ReferenceFile): { inlineData: { mimeType: string; data: string } } {
  return { inlineData: { mimeType: ref.mediaType, data: ref.base64 } }
}

type VeoInputKind = 'text_or_extension' | 'image_or_reference'

function veoAllowedPersonGeneration(model: string, inputKind: VeoInputKind): readonly string[] {
  // Google Veo 官方参数表：Veo 3.1/3.1 Fast/3.1 Lite/3 & 3 Fast 的人像生成取值按输入形态固定；Veo 2 更宽松。
  // https://ai.google.dev/gemini-api/docs/veo#veo-api-parameters-and-specifications
  const isVeo2 = /^veo-2(?:$|-)/i.test(model)
  if (isVeo2) return inputKind === 'text_or_extension'
    ? ['allow_all', 'allow_adult', 'dont_allow']
    : ['allow_adult', 'dont_allow']
  return inputKind === 'text_or_extension' ? ['allow_all'] : ['allow_adult']
}

function assertVeoPersonGenerationAllowed(model: string, personGeneration: string, inputKind: VeoInputKind): void {
  const allowed = veoAllowedPersonGeneration(model, inputKind)
  if (!allowed.includes(personGeneration)) {
    const scenario = inputKind === 'text_or_extension' ? '文生视频/视频扩展' : '图生视频/插帧/参考图'
    throw new Error(`Google Veo ${scenario} 场景下 personGeneration 仅支持 ${allowed.join(', ')}，当前传入: ${personGeneration}`)
  }
}

function isVeoLiteModel(model: string): boolean {
  return /(?:^|-)lite(?:-|$)/i.test(model)
}

/**
 * Google Veo 视频生成（predictLongRunning）。
 * Gemini Omni Flash 虽然复用 google-interactions 预设组，但走独立的 /v1beta/interactions 分支。
 *
 * 认证用 x-goog-api-key 头（与 Gemini Image 的 ?key= 查询参数不同）。
 */
async function callGoogleInteractionsVideoApi(
  input: GenerateMediaInput,
  fetchFn: typeof globalThis.fetch,
  references: ReferenceFile[],
): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('google-interactions 缺少 baseUrl')
  const apiKey = input.apiKey
  if (!apiKey?.trim()) throw new Error('未配置 Google API Key 或 Vertex JSON 凭据')
  if (isGoogleVertexJsonCredential(apiKey) && !isVertexSupportedGoogleOmniModel(model)) {
    throw new Error('Google Cloud Service (Vertex) 视频当前仅支持 gemini-omni-flash-preview，不支持 Veo；请切换到 Google Gemini API 渠道使用 Veo')
  }
  if (isGoogleOmniModel(model)) return callGoogleOmniVideoApi(input, fetchFn, references)

  const imageRefs = references.filter((ref) => ref.mediaType.startsWith('image/'))
  const lastFrameRefs = input.lastFramePath ? readReferenceFiles([input.lastFramePath], input.cwd).filter((ref) => ref.mediaType.startsWith('image/')) : []
  if (input.lastFramePath && lastFrameRefs.length === 0) throw new Error('已提供 Veo lastFrameImagePath，但没有可用图片文件')
  const videoRefs = input.videoPath ? readReferenceFiles([input.videoPath], input.cwd).filter((ref) => ref.mediaType.startsWith('video/')) : []
  if (input.videoPath && videoRefs.length === 0) throw new Error('已提供 Veo videoPath，但没有可用视频文件')
  const hasVideoExtension = videoRefs.length > 0
  const hasReferenceImages = imageRefs.length > 0 && (input.referenceMode === 'reference' || !!input.referenceType)
  const hasLastFrame = lastFrameRefs.length > 0
  if (hasVideoExtension && (imageRefs.length > 0 || hasLastFrame)) {
    throw new Error('Veo 视频扩展使用 videoPath 时不能同时传 referenceImagePaths 或 lastFrameImagePath；请拆成单独的视频扩展请求')
  }
  if (hasLastFrame && imageRefs.length === 0) {
    throw new Error('Veo lastFrame 必须与首帧 image/referenceImagePaths 一起使用，请同时提供 referenceImagePaths')
  }
  if (hasLastFrame && hasReferenceImages) {
    throw new Error('Veo lastFrame 插帧必须使用首帧 image，不能同时使用 referenceMode=reference 或 referenceType')
  }
  const veoInputKind: VeoInputKind = hasVideoExtension
    ? 'text_or_extension'
    : (imageRefs.length > 0 || hasReferenceImages || hasLastFrame ? 'image_or_reference' : 'text_or_extension')

  // 构造 instances：prompt + 可选首帧/末帧/参考图/视频扩展输入
  const instance: Record<string, unknown> = { prompt: input.prompt }
  if (videoRefs[0]) {
    instance.video = buildVeoMediaPart(videoRefs[0])
  }
  if (imageRefs.length > 0) {
    if (input.referenceMode === 'reference' || input.referenceType) {
      instance.referenceImages = imageRefs.slice(0, 3).map((ref) => ({
        image: buildVeoMediaPart(ref),
        referenceType: input.referenceType ?? 'asset',
      }))
    } else {
      instance.image = buildVeoMediaPart(imageRefs[0]!)
    }
  }
  if (lastFrameRefs[0]) {
    instance.lastFrame = buildVeoMediaPart(lastFrameRefs[0])
  }

  // parameters：Veo 官方字段。duration 会归一到 4/6/8 秒；1080p/4k 按官方限制强制 8 秒。
  const size = resolveRequestedSize(input) || input.config.preset?.defaultSize || '16:9'
  const aspectRatio = sizeToAspectRatio(size) ?? '16:9'
  let resolution = resolveVeoResolution(input)
  if (resolution === '4k' && isVeoLiteModel(model)) {
    throw new Error('Veo 3.1 Lite 不支持 4k 分辨率，请改用 720p/1080p 或切换到 Veo 3.1 / Veo 3.1 Fast')
  }
  if (hasVideoExtension && resolution && resolution !== '720p') {
    throw new Error('Veo 视频扩展仅支持 720p 分辨率，请把 resolution 设为 720p')
  }
  if (hasVideoExtension && !resolution) resolution = '720p'
  const requestedVideoCount = input.numberOfImages ?? 1
  if (requestedVideoCount !== 1) {
    throw new Error('Veo 当前每次请求只支持生成 1 条视频，请把 numberOfVideos 设为 1')
  }
  const mustUseEightSeconds = resolution === '1080p' || resolution === '4k' || hasVideoExtension || hasReferenceImages || hasLastFrame
  const durationSeconds = resolveVeoDurationSeconds(resolveRequestedVeoDuration(input), mustUseEightSeconds)
  const parameters: Record<string, unknown> = { aspectRatio }
  if (input.numberOfImages !== undefined) parameters.numberOfVideos = requestedVideoCount
  if (durationSeconds !== undefined) parameters.durationSeconds = durationSeconds
  if (resolution) parameters.resolution = resolution
  if (input.seed !== undefined) parameters.seed = input.seed
  const personGeneration = normalizeVeoPersonGeneration(input.personGeneration)
  if (personGeneration) {
    assertVeoPersonGenerationAllowed(model, personGeneration, veoInputKind)
    parameters.personGeneration = personGeneration
  }

  const submitBody = { instances: [instance], parameters }
  const target = await buildGooglePredictLongRunningRequestTarget({ rawCredential: apiKey, baseUrl, modelId: model })
  const submitRes = await fetchFn(target.url, {
    method: 'POST',
    headers: target.headers,
    body: JSON.stringify(submitBody),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => '')
    throw new Error(`Google 视频提交失败 (${submitRes.status}): ${text.slice(0, 300)}`)
  }
  const submitBodyJson = (await safeParseJson(submitRes, 'Google 视频提交')) as GoogleLroResponse
  const operationName = submitBodyJson.name
  if (!operationName) throw new Error('Google 视频提交未返回 operation name')

  // 轮询 operation 直到 done === true
  const pollUrl = resolveGooglePredictLongRunningPollUrl(target.url, operationName, target.authKind)
  const pollHeaders = googlePollingHeaders(target.headers)
  const downloadHeaders = googleMediaDownloadHeaders(target.headers, target.authKind)
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error(`Google 视频轮询超时（${VIDEO_POLL_TIMEOUT_MS / 1000}s）: ${operationName}`)
    if ((input.pollIntervalMs ?? POLL_INTERVAL_MS) > 0) await sleep(input.pollIntervalMs ?? POLL_INTERVAL_MS, input.signal)
    const res = await fetchFn(pollUrl, {
      method: 'GET',
      headers: pollHeaders,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Google 视频查询失败 (${res.status}): ${text.slice(0, 300)}`)
    }
    const body = (await safeParseJson(res, 'Google 视频查询')) as GoogleLroResponse
    if (body.done) {
      if (body.error) throw new Error(`Google 视频生成失败: ${body.error.message ?? body.error.status ?? '未知错误'}`)
      const videoUri = body.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
        ?? body.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.gcsUri
        ?? body.response?.generateVideoResponse?.generatedVideos?.[0]?.video?.uri
        ?? body.response?.generateVideoResponse?.generatedVideos?.[0]?.video?.gcsUri
      if (!videoUri) throw new Error('Google 视频生成成功但未返回视频 URI')
      return { images: [await downloadAsBase64(videoUri, fetchFn, input.signal, 'video/mp4', downloadHeaders)] }
    }
  }
}

function extractGoogleOmniFileId(value: GoogleOmniVideoData): string | undefined {
  const raw = value.fileId ?? value.file_id ?? value.name ?? value.uri
  if (!raw) return undefined
  const match = raw.match(/(?:^|\/)files\/([^/:?#]+)/)
  return match?.[1] ?? raw.replace(/^files\//, '')
}

function collectGoogleOmniVideos(body: GoogleOmniInteractionResponse): GoogleOmniVideoData[] {
  const videos: GoogleOmniVideoData[] = []
  if (body.output_video) videos.push(body.output_video)
  if (body.outputVideo) videos.push(body.outputVideo)
  for (const step of body.steps ?? []) {
    for (const item of step.content ?? []) {
      const mediaType = item.mimeType ?? item.mime_type
      if (item.type === 'video' || mediaType?.startsWith('video/')) {
        videos.push(item)
      }
    }
  }
  return videos
}

function buildGoogleOmniInput(prompt: string, references: ReferenceFile[]): unknown {
  if (references.length === 0) return prompt
  return [
    ...references.map((ref) => ({
      type: 'image',
      mime_type: ref.mediaType,
      data: ref.base64,
    })),
    { type: 'text', text: prompt },
  ]
}

async function callGoogleOmniVideoApi(
  input: GenerateMediaInput,
  fetchFn: typeof globalThis.fetch,
  references: ReferenceFile[],
): Promise<GenerateMediaOutput> {
  const { baseUrl, model } = input.config
  if (!baseUrl) throw new Error('google-interactions 缺少 baseUrl')
  const apiKey = input.apiKey
  if (!apiKey?.trim()) throw new Error('未配置 Google API Key 或 Vertex JSON 凭据')
  if (isGoogleVertexJsonCredential(apiKey) && !isVertexSupportedGoogleOmniModel(model)) {
    throw new Error('Google Cloud Service (Vertex) 视频当前仅支持 gemini-omni-flash-preview')
  }

  const sessionId = input.sessionId ?? 'google-omni'
  const requestBody: Record<string, unknown> = {
    model,
    input: buildGoogleOmniInput(input.prompt, references),
  }
  const previousInteractionId = googleOmniInteractionHistory.get(sessionId)
  if (previousInteractionId) requestBody.previous_interaction_id = previousInteractionId

  const target = await buildGoogleInteractionsRequestTarget({ rawCredential: apiKey, baseUrl })
  const res = await fetchFn(target.url, {
    method: 'POST',
    headers: target.headers,
    body: JSON.stringify(requestBody),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Google Omni 视频提交失败 (${res.status}): ${text.slice(0, 300)}`)
  }
  const body = (await safeParseJson(res, 'Google Omni 视频')) as GoogleOmniInteractionResponse
  if (body.error) throw new Error(`Google Omni 视频生成失败: ${body.error.message ?? body.error.status ?? '未知错误'}`)

  const interactionId = body.id ?? body.name
  if (interactionId) {
    googleOmniInteractionHistory.delete(sessionId) // 重插以更新会话新鲜度（LRU）
    evictOldestIfNeeded(googleOmniInteractionHistory)
    googleOmniInteractionHistory.set(sessionId, interactionId)
  }

  const outputs = collectGoogleOmniVideos(body)
  const videos: GeneratedImageData[] = []
  for (const item of outputs) {
    const mediaType = item.mimeType ?? item.mime_type ?? 'video/mp4'
    if (item.data) {
      videos.push({ mediaType, data: item.data })
      continue
    }
    if (item.uri && /^https?:\/\//i.test(item.uri)) {
      videos.push(await downloadAsBase64(item.uri, fetchFn, input.signal, mediaType, googleMediaDownloadHeaders(target.headers, target.authKind)))
      continue
    }
    const fileId = extractGoogleOmniFileId(item)
    if (fileId) {
      const downloadUrl = resolveGoogleOmniFileDownloadUrl(target.url, fileId, target.authKind)
      videos.push(await downloadAsBase64(downloadUrl, fetchFn, input.signal, mediaType, googlePollingHeaders(target.headers)))
    }
  }
  if (videos.length === 0) throw new Error('Google Omni 视频成功但未返回视频内容')
  return { images: videos }
}

const CHINESE_COUNT_VALUES: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}
const ENGLISH_COUNT_VALUES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}
const CHINESE_COUNT_TOKEN = '[0-9]+|[一二两俩三四五六七八九十]+'
const CHINESE_IMAGE_OUTPUT_NOUN = '(?:图片|图|海报|插图|封面|logo|头像|壁纸)?'
const CHINESE_IMAGE_COUNT_PATTERNS = [
  new RegExp(
    `(?:生成|做|画|出|来|输出|给我|帮我|制作|绘制|合成|拼成|转成|改成)[^，。,.!?！？\\n]{0,20}?(${CHINESE_COUNT_TOKEN})\\s*(?:张|幅|副|个)${CHINESE_IMAGE_OUTPUT_NOUN}`,
    'iu',
  ),
  new RegExp(`(${CHINESE_COUNT_TOKEN})\\s*(?:张|幅|副|个)(?:图片|图|海报|插图|封面|logo|头像|壁纸)`, 'iu'),
]
const ENGLISH_IMAGE_COUNT_PATTERNS = [
  /\b(?:generate|create|make|draw|render|produce|output|give me|show me)[^\n.!?]{0,40}?\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:images?|pictures?|illustrations?|posters?|logos?|icons?|banners?|variants?)\b/i,
  /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:images?|pictures?|illustrations?|posters?|logos?|icons?|banners?|variants?)\b/i,
]

function parseChineseCountToken(token: string): number | undefined {
  const trimmed = token.trim()
  const numeric = Number.parseInt(trimmed, 10)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  if (trimmed === '十') return 10
  const tenIndex = trimmed.indexOf('十')
  if (tenIndex >= 0) {
    const tensText = trimmed.slice(0, tenIndex)
    const onesText = trimmed.slice(tenIndex + 1)
    const tens = tensText ? CHINESE_COUNT_VALUES[tensText] : 1
    const ones = onesText ? CHINESE_COUNT_VALUES[onesText] : 0
    if (tens !== undefined && ones !== undefined) return tens * 10 + ones
  }
  return CHINESE_COUNT_VALUES[trimmed]
}

function parseImageCountToken(token: string): number | undefined {
  const trimmed = token.trim().toLowerCase()
  const numeric = Number.parseInt(trimmed, 10)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  return ENGLISH_COUNT_VALUES[trimmed] ?? parseChineseCountToken(token)
}

/** 从用户消息解析期望的图片张数（中英文均支持） */
export function resolveRequestedImageCount(userMessage: string): number | undefined {
  for (const pattern of CHINESE_IMAGE_COUNT_PATTERNS) {
    const match = pattern.exec(userMessage)
    const count = match?.[1] ? parseImageCountToken(match[1]) : undefined
    if (count) return count
  }
  for (const pattern of ENGLISH_IMAGE_COUNT_PATTERNS) {
    const match = pattern.exec(userMessage)
    const count = match?.[1] ? parseImageCountToken(match[1]) : undefined
    if (count) return count
  }
  return undefined
}

/** 按内容去重生成的图片 */
export function dedupeGeneratedImages(images: GeneratedImageData[]): GeneratedImageData[] {
  const seen = new Set<string>()
  const uniqueImages: GeneratedImageData[] = []
  for (const image of images) {
    const key = `${image.mediaType}\0${image.data}`
    if (seen.has(key)) continue
    seen.add(key)
    uniqueImages.push(image)
  }
  return uniqueImages
}

/**
 * 按用户请求的张数裁剪生成结果。
 * 去重后，若消息里能解析出张数则按张数裁剪（上限 maxCount），否则返回全部。
 */
export function selectGeneratedImagesForImageRequest(
  images: GeneratedImageData[],
  args: {
    userMessage: string
    defaultCount?: number
    maxCount?: number
  },
): GeneratedImageData[] {
  const uniqueImages = dedupeGeneratedImages(images)
  if (uniqueImages.length === 0) return []
  const maxCount = Math.max(1, Math.floor(args.maxCount ?? 4))
  const requestedCount = resolveRequestedImageCount(args.userMessage) ?? args.defaultCount
  if (!requestedCount) return uniqueImages
  const limit = Math.min(Math.max(Math.round(requestedCount), 1), maxCount)
  return uniqueImages.slice(0, limit)
}
