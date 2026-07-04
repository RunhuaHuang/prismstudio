import { describe, expect, test } from 'bun:test'
import { isLoopbackAuthority, mergeConfigPreservingMaskedKeys, validateLocalApiRequest } from './server'

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
