import { describe, expect, test } from 'bun:test'
import { enforceGenerationPolicy } from './policy'

const policy = {
  maxOutputs: 2,
  maxVideoDurationSec: 10,
  allow4k: false,
  maxInlineBytes: 1024,
  maxInputBytes: 1024,
  allowedInputDirs: [],
}

describe('generation policy', () => {
  test('rejects explicit and prompt-inferred output counts before generation', () => {
    expect(() => enforceGenerationPolicy('image', { numberOfImages: 3 }, 'cat', policy)).toThrow('策略上限')
    expect(() => enforceGenerationPolicy('image', {}, '请生成三张图片', policy)).toThrow('策略上限')
  })

  test('rejects long video and 4K requests', () => {
    expect(() => enforceGenerationPolicy('video', { duration: 11 }, 'clip', policy)).toThrow('10s')
    expect(() => enforceGenerationPolicy('video', {}, '生成一段 12 秒的视频', policy)).toThrow('10s')
    expect(() => enforceGenerationPolicy('image', { size: '3840x2160' }, 'poster', policy)).toThrow('4K')
    expect(() => enforceGenerationPolicy('image', {}, '生成一张 4K 海报', policy)).toThrow('4K')
    expect(() => enforceGenerationPolicy('image', {}, 'poster', policy, { defaultImageSize: '4K' })).toThrow('4K')
  })

  test('rejects malformed explicit counts before provider dispatch', () => {
    expect(() => enforceGenerationPolicy('image', { numberOfImages: 0 }, 'cat', policy)).toThrow('正整数')
    expect(() => enforceGenerationPolicy('video', { numberOfVideos: 1.5 }, 'clip', policy)).toThrow('正整数')
  })
})
