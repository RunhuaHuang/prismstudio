import { describe, expect, test } from 'bun:test'
import { isLoopbackAuthority, maskApiKey, mergeConfigPreservingMaskedKeys, resolveGeneratedMediaDir, resolveTestCredentials, validateLocalApiRequest } from './server'

describe('webui server · output path', () => {
  test('always treats configured outputDir as a root, including roots named generated-media', () => {
    expect(resolveGeneratedMediaDir('/tmp/output')).toBe('/tmp/output/generated-media')
    expect(resolveGeneratedMediaDir('/tmp/generated-media')).toBe('/tmp/generated-media/generated-media')
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
  })

  test('only loopback authorities are allowed', () => {
    expect(isLoopbackAuthority('127.0.0.1:17899')).toBe(true)
    expect(isLoopbackAuthority('localhost:17899')).toBe(true)
    expect(isLoopbackAuthority('0.0.0.0:17899')).toBe(false)
    expect(isLoopbackAuthority('example.com')).toBe(false)
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
