import { describe, expect, test } from 'bun:test'
import {
  normalizeGoogleGeminiApiRoot,
  resolveGoogleVertexGenerateContentUrl,
} from './google-auth'

// google-auth URL 构造回归测试。
// 覆盖两个真实缺陷：完整端点 baseUrl 下的双后缀 / 双段路径。

describe('normalizeGoogleGeminiApiRoot', () => {
  test('普通 root 原样返回', () => {
    expect(normalizeGoogleGeminiApiRoot('https://generativelanguage.googleapis.com')).toBe(
      'https://generativelanguage.googleapis.com',
    )
  })

  test('剥离 /v1beta/models/{model} 后缀', () => {
    expect(normalizeGoogleGeminiApiRoot('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image')).toBe(
      'https://generativelanguage.googleapis.com',
    )
  })

  test('剥离 /v1beta 版本段', () => {
    expect(normalizeGoogleGeminiApiRoot('https://generativelanguage.googleapis.com/v1beta')).toBe(
      'https://generativelanguage.googleapis.com',
    )
  })

  // 回归：api-key 的 Omni interactions 完整端点作为 baseUrl 时，不能再拼出双段
  // /v1beta/interactions/v1beta/interactions（曾导致 404）。
  test('剥离 /interactions 完整端点（修复双段路径）', () => {
    expect(normalizeGoogleGeminiApiRoot('https://generativelanguage.googleapis.com/v1beta/interactions')).toBe(
      'https://generativelanguage.googleapis.com',
    )
  })

  test('空 baseUrl 回退默认 root', () => {
    expect(normalizeGoogleGeminiApiRoot(undefined)).toBe('https://generativelanguage.googleapis.com')
    expect(normalizeGoogleGeminiApiRoot('')).toBe('https://generativelanguage.googleapis.com')
  })
})

describe('resolveGoogleVertexGenerateContentUrl', () => {
  test('普通 Vertex baseUrl 拼出完整 generateContent 路径', () => {
    expect(
      resolveGoogleVertexGenerateContentUrl({
        baseUrl: 'https://aiplatform.googleapis.com/v1/projects/p1/locations/us-central1',
        modelId: 'gemini-3.1-flash-image',
      }),
    ).toBe(
      'https://aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/publishers/google/models/gemini-3.1-flash-image:generateContent',
    )
  })

  test('已是 :generateContent 结尾的完整端点原样返回', () => {
    const full = 'https://aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/publishers/google/models/gemini-3.1-flash-image:generateContent'
    expect(resolveGoogleVertexGenerateContentUrl({ baseUrl: full, modelId: 'gemini-3.1-flash-image' })).toBe(full)
  })

  test(':streamGenerateContent 结尾转换为 :generateContent', () => {
    const stream = 'https://aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/publishers/google/models/gemini-3.1-flash-image:streamGenerateContent'
    expect(resolveGoogleVertexGenerateContentUrl({ baseUrl: stream, modelId: 'gemini-3.1-flash-image' })).toBe(
      'https://aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/publishers/google/models/gemini-3.1-flash-image:generateContent',
    )
  })

  // 回归：用户按 Veo 文档把完整 :predictLongRunning 端点作为 baseUrl 时，
  // generateContent 分支不能把它误判为普通模型路径再追加 :generateContent。
  // （predictLongRunning 调用路径已在前置检查中原样返回，这里验证不会二次追加。）
  test(':predictLongRunning 结尾不会被追加 :generateContent', () => {
    const plr = 'https://aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/publishers/google/models/veo-3.0-generate-001:predictLongRunning'
    expect(resolveGoogleVertexGenerateContentUrl({ baseUrl: plr, modelId: 'veo-3.0-generate-001' })).toBe(plr)
  })

  test('缺少 projectId 且无完整路径时抛错', () => {
    expect(() => resolveGoogleVertexGenerateContentUrl({ modelId: 'gemini-3.1-flash-image' })).toThrow(/project_id/)
  })

  test('官方 aiplatform 域名 + projectId 拼出完整路径', () => {
    expect(
      resolveGoogleVertexGenerateContentUrl({ baseUrl: 'https://aiplatform.googleapis.com', modelId: 'gemini-3.1-flash-image', projectId: 'p1' }),
    ).toBe('https://aiplatform.googleapis.com/v1/projects/p1/locations/global/publishers/google/models/gemini-3.1-flash-image:generateContent')
  })

  // 回归：无法解析的自定义 baseUrl 必须抛错，不能静默丢弃 baseUrl 请求官方域名（绕过企业代理）。
  test('无法解析的自定义 baseUrl 抛错而非绕过代理', () => {
    expect(() =>
      resolveGoogleVertexGenerateContentUrl({ baseUrl: 'https://my-vertex-proxy.example.com/api', modelId: 'gemini-3.1-flash-image', projectId: 'p1' }),
    ).toThrow(/无法从 Base URL 解析 Vertex 请求路径/)
  })

  test('无 baseUrl + projectId 走官方兜底', () => {
    expect(
      resolveGoogleVertexGenerateContentUrl({ modelId: 'gemini-3.1-flash-image', projectId: 'p1' }),
    ).toBe('https://aiplatform.googleapis.com/v1/projects/p1/locations/global/publishers/google/models/gemini-3.1-flash-image:generateContent')
  })
})
