import { resolveRequestedImageCount, type MediaModality } from './engine/media-generation-engine.js'
import type { ResolvedGenerationPolicy } from './config.js'

export interface GenerationPolicyContext {
  /** 当前预设在调用方未显式传分辨率时采用的默认尺寸。 */
  defaultSize?: string
  /** Gemini 等预设单独声明的默认图像清晰度。 */
  defaultImageSize?: string
}

function parseDurationSecondsFromPrompt(prompt: string): number | undefined {
  const match = prompt.match(/(?:^|[^\d])(\d{1,3}(?:\.\d+)?)\s*(?:秒|s|sec|secs|second|seconds)(?:[^\d]|$)/i)
  if (!match?.[1]) return undefined
  const value = Number.parseFloat(match[1])
  return Number.isFinite(value) ? value : undefined
}

function requests4k(value: string): boolean {
  if (/(?:^|[^a-z0-9])4k(?:[^a-z0-9]|$)|2160\s*p|超高清|\buhd\b/i.test(value)) return true
  const dimensions = value.match(/(\d{3,5})\s*[x*×]\s*(\d{3,5})/i)
  return !!dimensions && Math.max(Number(dimensions[1]), Number(dimensions[2])) >= 3840
}

/** 在任何付费上游请求发出前执行的统一成本/资源策略。 */
export function enforceGenerationPolicy(
  modality: MediaModality,
  args: Record<string, unknown>,
  prompt: string,
  policy: ResolvedGenerationPolicy,
  context: GenerationPolicyContext = {},
): void {
  const explicitCount = modality === 'video' ? args.numberOfVideos : args.numberOfImages
  const inferredCount = modality === 'image' && typeof explicitCount !== 'number'
    ? resolveRequestedImageCount(prompt)
    : undefined
  const requestedCount = typeof explicitCount === 'number' ? explicitCount : inferredCount
  if (typeof requestedCount === 'number' && (!Number.isInteger(requestedCount) || requestedCount < 1)) {
    throw new Error(`生成数量必须是正整数，当前为 ${requestedCount}`)
  }
  if (requestedCount !== undefined && requestedCount > policy.maxOutputs) {
    throw new Error(`生成数量 ${requestedCount} 超过策略上限 ${policy.maxOutputs}，请减少数量或在 WebUI 调整策略`)
  }
  const requestedDuration = modality === 'video'
    ? (typeof args.duration === 'number' ? args.duration : parseDurationSecondsFromPrompt(prompt))
    : undefined
  if (typeof requestedDuration === 'number' && (!Number.isFinite(requestedDuration) || requestedDuration < 0)) {
    throw new Error(`视频时长必须是非负有限数字，当前为 ${requestedDuration}`)
  }
  if (requestedDuration !== undefined && requestedDuration > policy.maxVideoDurationSec) {
    throw new Error(`视频时长 ${requestedDuration}s 超过策略上限 ${policy.maxVideoDurationSec}s`)
  }
  if (!policy.allow4k) {
    const values = [args.imageSize, args.image_size, args.resolution, args.size, prompt, context.defaultSize, context.defaultImageSize]
      .filter((value): value is string => typeof value === 'string')
    if (values.some(requests4k)) throw new Error('当前生成策略禁止 4K 请求；请降低分辨率或在 WebUI 中允许 4K')
  }
}
