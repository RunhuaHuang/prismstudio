import { afterEach, describe, expect, test } from 'bun:test'
import {
  normalizeGoogleGeminiApiRoot,
  resolveGoogleUpstreamAuth,
  resolveGoogleVertexGenerateContentUrl,
  validateGoogleTokenUri,
} from './google-auth'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

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

  test('显式无效 Base URL 抛错而非静默绕过代理', () => {
    expect(() => normalizeGoogleGeminiApiRoot('not a valid url')).toThrow(/Base URL 无效/)
  })
})

describe('Google OAuth cancellation', () => {
  test('authorized_user token refresh receives the caller AbortSignal', async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | null | undefined
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedSignal = init?.signal
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'token', expires_in: 3600 }),
      } as Response
    }) as typeof fetch

    await resolveGoogleUpstreamAuth(JSON.stringify({
      type: 'authorized_user',
      client_id: `client-${Date.now()}`,
      client_secret: 'secret',
      refresh_token: `refresh-${Date.now()}`,
    }), controller.signal)

    expect(receivedSignal).toBe(controller.signal)
  })

  test('rejects non-Google token_uri before sending JWT or refresh tokens', async () => {
    expect(() => validateGoogleTokenUri('http://127.0.0.1:4318/token')).toThrow(/不受信任/)
    expect(() => validateGoogleTokenUri('https://oauth2.googleapis.com:8443/token')).toThrow(/不安全/)
    expect(() => validateGoogleTokenUri('https://evil.example/token')).toThrow(/不受信任/)
    await expect(resolveGoogleUpstreamAuth(JSON.stringify({
      type: 'authorized_user', client_id: 'client-invalid-uri', client_secret: 'secret',
      refresh_token: 'refresh-invalid-uri', token_uri: 'http://127.0.0.1:4318/token',
    }))).rejects.toThrow(/token_uri/)
  })
})

describe('Google OAuth token refresh dedupe & abort', () => {
  test('并发刷新同一 authorized_user 凭据只交换一次 token（thundering herd 去重）', async () => {
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      await new Promise((r) => setTimeout(r, 20))
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: 'shared-token', expires_in: 3600 }),
      } as Response
    }) as typeof fetch

    const cred = JSON.stringify({
      type: 'authorized_user',
      client_id: 'dupe-client',
      client_secret: 'secret',
      refresh_token: 'dupe-refresh',
    })
    const results = await Promise.all([
      resolveGoogleUpstreamAuth(cred),
      resolveGoogleUpstreamAuth(cred),
      resolveGoogleUpstreamAuth(cred),
    ])
    expect(fetchCalls).toBe(1)
    for (const r of results) {
      expect((r as { accessToken?: string }).accessToken).toBe('shared-token')
    }
  })

  test('token 端点响应读取期间的 AbortError 向上传播，不被 json 解析吞掉', async () => {
    globalThis.fetch = (async () => ({
      ok: true, status: 200,
      json: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) },
    })) as typeof fetch

    await expect(resolveGoogleUpstreamAuth(JSON.stringify({
      type: 'authorized_user', client_id: 'abort-read-client', client_secret: 'secret', refresh_token: 'abort-read-refresh',
    }), new AbortController().signal)).rejects.toThrow('aborted')
  })

  test('形似路径但不存在的凭据文件抛出明确错误，而非当 API Key 发送', async () => {
    await expect(resolveGoogleUpstreamAuth('/definitely/not/real/key.json')).rejects.toThrow(/不存在或无法解析/)
  })

  // 回归：token 寿命计算兼容 number / 字符串 / 非法值（统一回退 3600s）。
  // 部分网关返回 "3600" 字符串，不能因此误判为无效而用过期缓存。
  test('expires_in 兼容字符串形式，非法值回退 3600s（不命中陈旧缓存）', async () => {
    for (const expiresIn of [3600, '3600', 'abc', -1, undefined]) {
      // JSON.stringify 区分 number 3600 ("3600") 与 string "3600" ('"3600"')，
      // 避免跨迭代命中全局 googleTokenCache 的陈旧条目。
      const tag = JSON.stringify(expiresIn)
      let tokenSeq = 0
      globalThis.fetch = (async () => ({
        ok: true, status: 200,
        json: async () => {
          // expires_in<=0 或非法时，缓存仍应被当作有效写入（回退 3600），
          // 连续两次同凭据调用应命中缓存（只 fetch 一次）。
          return { access_token: `token-${tokenSeq++}`, expires_in: expiresIn }
        },
      })) as typeof fetch
      const cred = JSON.stringify({
        type: 'authorized_user', client_id: `exp-client-${tag}`,
        client_secret: 'secret', refresh_token: `exp-refresh-${tag}`,
      })
      await resolveGoogleUpstreamAuth(cred)
      await resolveGoogleUpstreamAuth(cred) // 第二次必须命中缓存，不应再次 fetch
      expect(tokenSeq).toBe(1)
    }
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
