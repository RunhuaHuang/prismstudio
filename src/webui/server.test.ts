import { describe, expect, test } from 'bun:test'
import { isLoopbackAuthority, maskApiKey, mergeConfigPreservingMaskedKeys, parseApiRequestUrl, resolveGeneratedMediaDir, resolveTestCredentials, STATIC_ASSET_CACHE_CONTROL, validateConfigPayload, validateLocalApiRequest, validateTestRequestPayload } from './server'
import { resolveModalityApiKey } from '../config'
import { WEBUI_HTML } from './index-html'

describe('webui server · output path', () => {
  test('always treats configured outputDir as a root, including roots named generated-media', () => {
    expect(resolveGeneratedMediaDir('/tmp/output')).toBe('/tmp/output/generated-media')
    expect(resolveGeneratedMediaDir('/tmp/generated-media')).toBe('/tmp/generated-media/generated-media')
  })
})

describe('webui server · browser asset and readiness rendering', () => {
  test('revalidates the fixed Alpine.js asset URL after application upgrades', () => {
    expect(STATIC_ASSET_CACHE_CONTROL).toBe('no-cache')
  })

  test('matches API routes by exact pathname while preserving query parameters', () => {
    const exportUrl = parseApiRequestUrl('/api/export?agent=cursor')
    expect(exportUrl?.pathname).toBe('/api/export')
    expect(exportUrl?.searchParams.get('agent')).toBe('cursor')
    expect(parseApiRequestUrl('/api/export-anything')?.pathname).not.toBe('/api/export')
  })

  test('renders channel readiness from the server status, including apiKeyEnv-backed channels', () => {
    expect(WEBUI_HTML).toContain(':class="isReady(m.key) && \'live\'"')
    expect(WEBUI_HTML).toContain('x-text="isReady(m.key) ? t.statusLive : t.statusIdle"')
    expect(WEBUI_HTML).not.toContain("config[m.key]?.enabled && config[m.key]?.apiKey && 'live'")
  })
})

describe('webui server · local API guard', () => {
  test('accepts same-origin loopback JSON writes', () => {
    expect(validateLocalApiRequest({
      method: 'PUT',
      host: '127.0.0.1:17899',
      origin: 'http://127.0.0.1:17899',
      secFetchSite: 'same-origin',
      contentType: 'application/json; charset=utf-8',
    })).toBeNull()
  })

  test('rejects cross-site browser requests', () => {
    expect(validateLocalApiRequest({
      method: 'POST',
      host: '127.0.0.1:17899',
      origin: 'https://evil.example',
      secFetchSite: 'cross-site',
      contentType: 'application/json',
    })).toContain('Origin')
  })

  test('requires JSON content type for mutating API calls', () => {
    expect(validateLocalApiRequest({
      method: 'POST',
      host: 'localhost:17899',
      origin: 'http://localhost:17899',
      secFetchSite: 'same-origin',
      contentType: 'text/plain',
    })).toContain('application/json')
    expect(validateLocalApiRequest({
      method: 'POST',
      host: 'localhost:17899',
      origin: 'http://localhost:17899',
      secFetchSite: 'same-origin',
      contentType: 'text/application/json',
    })).toContain('application/json')
    expect(validateLocalApiRequest({
      method: 'POST',
      host: 'localhost:17899',
      origin: 'http://localhost:17899',
      secFetchSite: 'same-origin',
      contentType: 'application/problem+json',
    })).toBeNull()
  })

  test('only loopback authorities are allowed', () => {
    expect(isLoopbackAuthority('127.0.0.1:17899')).toBe(true)
    expect(isLoopbackAuthority('localhost:17899')).toBe(true)
    expect(isLoopbackAuthority('0.0.0.0:17899')).toBe(false)
    expect(isLoopbackAuthority('example.com')).toBe(false)
  })
})

describe('webui server · config payload validation', () => {
  test('accepts policy/env-key config and rejects destructive wrong field types', () => {
    expect(validateConfigPayload({
      image: { enabled: true, presetId: 'custom', apiKey: '', apiKeyEnv: 'OPENAI_API_KEY' },
      policy: { maxOutputs: 2, maxInputMiB: 128, allow4k: false, allowedInputDirs: ['/tmp/assets'] },
      diagnostics: { enabled: true, logFile: '/tmp/diag.jsonl' },
    })).toBeNull()
    expect(validateConfigPayload({ image: { enabled: 'yes' } })).toContain('enabled')
    expect(validateConfigPayload({ policy: { allowedInputDirs: '/tmp/assets' } })).toContain('字符串数组')
    expect(validateConfigPayload({ image: { protocol: 'fake-protocol' } })).toContain('protocol')
    expect(validateConfigPayload({ image: { protocol: 'kling-async' } })).toContain('不兼容')
    expect(validateConfigPayload({ image: { apiKeyEnv: 'BAD-NAME' } })).toContain('环境变量')
    expect(validateConfigPayload({ policy: { maxOutputs: 2.5 } })).toContain('整数')
    expect(validateConfigPayload({ policy: { maxInputMiB: 0 } })).toContain('1-2048')
    expect(validateConfigPayload({ policy: { allowedInputDirs: ['relative/path'] } })).toContain('绝对路径')
    expect(validateConfigPayload(JSON.parse('{"image":{"apiKeyByVendor":{"__proto__":"bad"}}}'))).toContain('不安全的键名')
    expect(validateConfigPayload({ outputDir: 'relative/path' })).toContain('绝对路径')
    expect(validateConfigPayload({ outputDir: '/abs/output' })).toBeNull()
  })
})

describe('webui server · playground payload validation', () => {
  test('rejects malformed fields before any provider dispatch', () => {
    expect(validateTestRequestPayload({ modality: 'image', prompt: 'cat', numberOfImages: 1 })).toBeNull()
    expect(validateTestRequestPayload(null)).toContain('JSON 对象')
    expect(validateTestRequestPayload({ modality: 'image', prompt: 'cat', numberOfImages: '4' })).toContain('正整数')
    expect(validateTestRequestPayload({ modality: 'video', prompt: 'clip', duration: Number.NaN })).toContain('有限数字')
    expect(validateTestRequestPayload({ modality: 'audio', prompt: 'voice', referencePaths: '/tmp/a.wav' })).toContain('字符串数组')
    expect(validateTestRequestPayload({ modality: 'image', prompt: 'cat', protocol: 'fake' })).toContain('protocol')
    expect(validateTestRequestPayload({ modality: 'image', prompt: 'cat', apiKeyEnv: 'BAD-NAME' })).toContain('环境变量')
  })
})

describe('webui server · API key merge', () => {
  test('preserves masked per-vendor keys and restores top apiKey for same vendor model switch', () => {
    const merged = mergeConfigPreservingMaskedKeys(
      {
        image: {
          enabled: true,
          presetId: 'gemini-flash-image',
          apiKey: '',
          apiKeyByVendor: { 'Google Gemini': 'real-google-key' },
        },
      },
      {
        image: {
          enabled: true,
          presetId: 'gemini-pro-image',
          apiKey: 'real****-key',
          apiKeyByVendor: { 'Google Gemini': 'real****-key' },
        },
      },
    )

    expect(merged.image?.apiKey).toBe('real-google-key')
    expect(merged.image?.apiKeyByVendor?.['Google Gemini']).toBe('real-google-key')
  })

  test('跨 vendor 切换且目标 vendor 无记忆时，不把旧 vendor 的顶层 key 错配到新 vendor', () => {
    const merged = mergeConfigPreservingMaskedKeys(
      {
        image: {
          enabled: true,
          presetId: 'vendor-a-preset',
          apiKey: 'old-vendor-a-key',
        },
      },
      {
        image: {
          enabled: true,
          // 切到一个完全不同的 vendor，前端只回传了脱敏占位顶层 key，未回传目标 vendor 的脱敏 key。
          presetId: 'vendor-b-preset',
          apiKey: 'old****-a-key',
        },
      },
    )
    // 目标 vendor 无记忆：顶层应清空，而不是把旧 vendor-a 的 key 残留/错配到 vendor-b。
    expect(merged.image?.apiKey).toBe('')
  })

  test('keeps modality key memories independent even when vendor names match', () => {
    const merged = mergeConfigPreservingMaskedKeys(
      {
        image: {
          enabled: true,
          presetId: 'gemini-flash-image',
          apiKey: '',
          apiKeyByVendor: { 'Google Gemini': 'image-google-key' },
        },
        video: {
          enabled: true,
          presetId: 'google-veo-31',
          apiKey: '',
          apiKeyByVendor: { 'Google Gemini': 'video-google-key' },
        },
      },
      {
        image: {
          enabled: true,
          presetId: 'gemini-pro-image',
          apiKey: 'imag****-key',
          apiKeyByVendor: { 'Google Gemini': 'imag****-key' },
        },
        video: {
          enabled: true,
          presetId: 'google-veo-31-fast',
          apiKey: 'vide****-key',
          apiKeyByVendor: { 'Google Gemini': 'vide****-key' },
        },
      },
    )

    expect(merged.image?.apiKey).toBe('image-google-key')
    expect(merged.video?.apiKey).toBe('video-google-key')
  })

  test('prefers the incoming preset vendor key over the current top-level key', () => {
    const merged = mergeConfigPreservingMaskedKeys(
      {
        image: {
          enabled: true,
          presetId: 'doubao-seedream-5',
          apiKey: 'doubao-current-key',
          apiKeyByVendor: {
            'Google Gemini': 'google-stored-key',
            '豆包': 'doubao-current-key',
          },
        },
      },
      {
        image: {
          enabled: true,
          presetId: 'gemini-pro-image',
          apiKey: 'goog****-key',
          apiKeyByVendor: {
            'Google Gemini': 'goog****-key',
            '豆包': 'doub****-key',
          },
        },
      },
    )

    expect(merged.image?.apiKey).toBe('google-stored-key')
  })

  test('falls back to legacy per-preset key memory', () => {
    const merged = mergeConfigPreservingMaskedKeys(
      {
        image: {
          enabled: true,
          presetId: 'gemini-flash-image',
          apiKey: '',
          apiKeyByPreset: { 'gemini-pro-image': 'legacy-preset-key' },
        },
      },
      {
        image: {
          enabled: true,
          presetId: 'gemini-pro-image',
          apiKey: 'lega****-key',
          apiKeyByPreset: { 'gemini-pro-image': 'lega****-key' },
        },
      },
    )

    expect(merged.image?.apiKey).toBe('legacy-preset-key')
    expect(merged.image?.apiKeyByPreset?.['gemini-pro-image']).toBe('legacy-preset-key')
  })
})

describe('webui server · playground credentials', () => {
  test('uses the page environment variable before autosave completes', () => {
    const envName = 'PRISMSTUDIO_TEST_PAGE_KEY'
    const previous = process.env[envName]
    process.env[envName] = 'page-env-secret'
    try {
      const credentials = resolveTestCredentials({
        modality: 'image', prompt: 'cat', presetId: 'gemini-pro-image',
        model: 'gemini-3-pro-image-preview', protocol: 'gemini-generate-content',
        baseUrl: 'https://proxy.example.com', apiKeyEnv: envName,
      }, {})
      expect(credentials.apiKey).toBe('page-env-secret')
    } finally {
      if (previous === undefined) delete process.env[envName]
      else process.env[envName] = previous
    }
  })

  test('uses the same stored inline key as the formal runtime when a page env key also exists', () => {
    const envName = 'PRISMSTUDIO_TEST_PAGE_KEY'
    const previous = process.env[envName]
    process.env[envName] = 'page-env-secret'
    const stored = {
      enabled: true,
      presetId: 'gemini-pro-image',
      apiKey: 'stored-inline-secret',
    }
    try {
      const credentials = resolveTestCredentials({
        modality: 'image', prompt: 'cat', presetId: 'gemini-pro-image',
        model: 'gemini-3-pro-image-preview', protocol: 'gemini-generate-content',
        baseUrl: 'https://proxy.example.com', apiKeyEnv: envName,
      }, { image: stored })

      // `resolveModalityApiKey` is the formal MCP runtime's selector. The
      // playground must not dispatch a paid request with a different key.
      expect(credentials.apiKey).toBe(resolveModalityApiKey(stored))
      expect(credentials.apiKey).toBe('stored-inline-secret')
    } finally {
      if (previous === undefined) delete process.env[envName]
      else process.env[envName] = previous
    }
  })

  test('uses current page preset/protocol/baseUrl and the target vendor key before autosave completes', () => {
    const credentials = resolveTestCredentials({
      modality: 'image',
      prompt: 'cat',
      presetId: 'gemini-pro-image',
      model: 'gemini-3-pro-image-preview',
      protocol: 'gemini-generate-content',
      baseUrl: 'https://proxy.example.com',
    }, {
      image: {
        enabled: true,
        presetId: 'doubao-seedream-5',
        model: 'doubao-seedream-5-0-260128',
        protocol: 'openai-images',
        baseUrl: 'https://old.example.com',
        apiKey: 'old-doubao-key',
        apiKeyByVendor: { 'Google Gemini': 'stored-google-key', '豆包': 'old-doubao-key' },
      },
    })

    expect(credentials.apiKey).toBe('stored-google-key')
    expect(credentials.presetId).toBe('gemini-pro-image')
    expect(credentials.model).toBe('gemini-3-pro-image-preview')
    expect(credentials.protocol).toBe('gemini-generate-content')
    expect(credentials.baseUrl).toBe('https://proxy.example.com')
  })

  test('never reuses the old preset top-level key for a different vendor', () => {
    expect(() => resolveTestCredentials({
      modality: 'image', prompt: 'cat', presetId: 'gemini-pro-image',
      model: 'gemini-3-pro-image-preview', protocol: 'gemini-generate-content', baseUrl: '',
    }, {
      image: {
        enabled: true,
        presetId: 'doubao-seedream-5',
        apiKey: 'old-doubao-key',
      },
    })).toThrow(/当前模型的 API Key/)
  })

  // 回归：顶层 apiKey 清空时，同步删除 vendor/preset 记忆，避免"删掉的 key 复活"。
  test('clearing top-level apiKey also removes vendor/preset key memory', () => {
    const merged = mergeConfigPreservingMaskedKeys(
      {
        image: {
          enabled: true,
          presetId: 'gemini-flash-image',
          apiKey: 'real-google-key',
          apiKeyByVendor: { 'Google Gemini': 'real-google-key' },
          apiKeyByPreset: { 'gemini-flash-image': 'real-google-key' },
        },
      },
      {
        image: {
          enabled: true,
          presetId: 'gemini-flash-image',
          apiKey: '', // 用户清空
          apiKeyByVendor: { 'Google Gemini': '' },
          apiKeyByPreset: { 'gemini-flash-image': '' },
        },
      },
    )
    expect(merged.image?.apiKey).toBe('')
    expect(merged.image?.apiKeyByVendor?.['Google Gemini']).toBeUndefined()
    expect(merged.image?.apiKeyByPreset?.['gemini-flash-image']).toBeUndefined()
  })

  // 回归：mergeMaskedStringMap 空字符串删除磁盘条目（而非保留），脱敏占位仍保留原值。
  test('mergeMaskedStringMap: empty string deletes entry, masked placeholder preserves', () => {
    const merged = mergeConfigPreservingMaskedKeys(
      {
        image: {
          enabled: true,
          presetId: 'gemini-flash-image',
          apiKey: 'real-google-key',
          apiKeyByVendor: { 'Google Gemini': 'real-google-key', 'Other Vendor': 'other-key' },
        },
      },
      {
        image: {
          enabled: true,
          presetId: 'gemini-flash-image',
          apiKey: 'real****-key',
          apiKeyByVendor: { 'Google Gemini': 'real****-key', 'Other Vendor': '' },
        },
      },
    )
    // 脱敏占位 → 保留原值
    expect(merged.image?.apiKeyByVendor?.['Google Gemini']).toBe('real-google-key')
    // 空字符串 → 删除
    expect(merged.image?.apiKeyByVendor?.['Other Vendor']).toBeUndefined()
  })

  test('does not allow special map keys to mutate object prototypes', () => {
    const merged = mergeConfigPreservingMaskedKeys(
      {},
      JSON.parse('{"image":{"enabled":false,"presetId":"custom","apiKey":"","apiKeyByVendor":{"__proto__":"polluted","safe":"value"}}}'),
    )
    expect(merged.image?.apiKeyByVendor).toEqual({ safe: 'value' })
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  // 回归：maskApiKey 对非字符串（坏数据）不抛 TypeError，避免 GET /api/config 永久 500。
  test('maskApiKey handles non-string and empty inputs without throwing', () => {
    expect(maskApiKey('')).toBe('')
    expect(maskApiKey(12345 as unknown as string)).toBe('')
    expect(maskApiKey(null as unknown as string)).toBe('')
    expect(maskApiKey(undefined as unknown as string)).toBe('')
  })

  test('maskApiKey masks string keys and GCP JSON without leaking full secret', () => {
    expect(maskApiKey('sk-1234567890abcdef')).toBe('sk-1****cdef')
    expect(maskApiKey('short')).toBe('****')
    // GCP JSON：只暴露 type 和 projectId，不暴露 private_key
    const gcp = maskApiKey(JSON.stringify({ type: 'service_account', project_id: 'my-proj', private_key: 'SECRET' }))
    expect(gcp).toBe('JSON:service_account:my-proj·****')
    expect(gcp).not.toContain('SECRET')
  })
})
