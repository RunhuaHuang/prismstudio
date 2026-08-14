import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectConfigSecrets, isModalityReady, isValidHttpBaseUrl, loadConfig, normalizeConfig, redactSensitiveText, replaceConfigFileAtomically, resolveGenerationPolicy, saveConfig } from './config'
import { MEDIA_MODEL_PRESETS } from './engine/media-generation-engine'

const originalConfigPath = process.env.PRISMSTUDIO_CONFIG
const tempDirs: string[] = []

afterEach(() => {
  if (originalConfigPath === undefined) delete process.env.PRISMSTUDIO_CONFIG
  else process.env.PRISMSTUDIO_CONFIG = originalConfigPath
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.PRISMSTUDIO_TEST_API_KEY
})

describe('config · sensitive file permissions', () => {
  test('creates config.json as 0600 and repairs overly broad existing permissions', () => {
    if (process.platform === 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'prismstudio-config-test-'))
    tempDirs.push(dir)
    const path = join(dir, 'config.json')
    process.env.PRISMSTUDIO_CONFIG = path

    saveConfig({ image: { enabled: true, presetId: 'custom', apiKey: 'secret' } })
    expect(statSync(path).mode & 0o777).toBe(0o600)

    chmodSync(path, 0o644)
    saveConfig({ image: { enabled: true, presetId: 'custom', apiKey: 'new-secret' } })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('atomically replaces config without leaving secret-bearing temp files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismstudio-config-test-'))
    tempDirs.push(dir)
    const path = join(dir, 'config.json')
    process.env.PRISMSTUDIO_CONFIG = path

    saveConfig({ image: { enabled: true, presetId: 'custom', apiKey: 'old-secret' } })
    saveConfig({ image: { enabled: true, presetId: 'custom', apiKey: 'new-secret' } })

    expect(JSON.parse(readFileSync(path, 'utf-8')).image.apiKey).toBe('new-secret')
    expect(readdirSync(dir)).toEqual(['config.json'])
  })

  test('uses Windows backup-and-restore fallback when an overwrite replacement fails', () => {
    const tempPath = 'config.tmp'
    const path = 'config.json'
    const backupPath = 'config.bak'
    const calls: Array<[string, string]> = []
    const initialOverwriteError = Object.assign(new Error('destination is locked'), { code: 'EPERM' })
    const replacementError = Object.assign(new Error('new file cannot be moved'), { code: 'EACCES' })

    expect(() => replaceConfigFileAtomically(tempPath, path, backupPath, {
      platform: 'win32',
      rename: (from, to) => {
        calls.push([from, to])
        if (calls.length === 1) throw initialOverwriteError
        if (calls.length === 3) throw replacementError
      },
      remove: () => { throw new Error('backup should not be cleaned on a failed replacement') },
      warn: () => { throw new Error('backup cleanup warning should not occur') },
    })).toThrow('new file cannot be moved')

    // Original config is moved aside only after the direct overwrite fails,
    // then moved back when the replacement also fails.
    expect(calls).toEqual([
      [tempPath, path],
      [path, backupPath],
      [tempPath, path],
      [backupPath, path],
    ])
  })
})

describe('config · runtime normalization', () => {
  test('解析失败的配置文件被备份为 .corrupt-<ts>，返回空配置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismstudio-config-test-'))
    tempDirs.push(dir)
    const path = join(dir, 'config.json')
    process.env.PRISMSTUDIO_CONFIG = path
    writeFileSync(path, '{ this is not valid json')

    expect(loadConfig()).toEqual({})
    const backups = readdirSync(dir).filter((name) => name.startsWith('config.json.corrupt-'))
    expect(backups.length).toBe(1)
    expect(readFileSync(join(dir, backups[0]!), 'utf-8')).toBe('{ this is not valid json')
  })

  test('ignores malformed field types instead of crashing readiness checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismstudio-config-test-'))
    tempDirs.push(dir)
    const path = join(dir, 'config.json')
    process.env.PRISMSTUDIO_CONFIG = path
    writeFileSync(path, JSON.stringify({
      image: {
        enabled: 'yes',
        presetId: 42,
        apiKey: { secret: true },
        apiKeyByVendor: { valid: 'key', invalid: 123 },
      },
      video: null,
      outputDir: 99,
      webuiPort: 70_000,
    }))

    expect(loadConfig()).toEqual({
      image: {
        enabled: false,
        presetId: '',
        apiKey: '',
        apiKeyByVendor: { valid: 'key' },
      },
    })
  })

  test('redacts stored keys, split access credentials, and authorization headers', () => {
    const config = {
      image: { enabled: true, presetId: 'custom', apiKey: 'access-key-123:secret-key-456' },
    }
    const message = 'upstream echoed secret-key-456; Authorization: Bearer transient-token; api_key="access-key-123"'
    const redacted = redactSensitiveText(message, collectConfigSecrets(config))
    expect(redacted).not.toContain('secret-key-456')
    expect(redacted).not.toContain('transient-token')
    expect(redacted).not.toContain('access-key-123')
    expect(redacted).toContain('[REDACTED]')
  })

  test('resolves safe policy defaults and normalized custom limits', () => {
    const config = normalizeConfig({ policy: { maxOutputs: 2, maxVideoDurationSec: 9, allow4k: false, maxInlineMiB: 1, maxInputMiB: 64 } })
    expect(resolveGenerationPolicy(config)).toMatchObject({
      maxOutputs: 2,
      maxVideoDurationSec: 9,
      allow4k: false,
      maxInlineBytes: 1024 * 1024,
      maxInputBytes: 64 * 1024 * 1024,
    })
  })

  test('canonicalizes policy bounds and drops unsafe protocol/env/path values', () => {
    const config = normalizeConfig({
      image: { enabled: true, presetId: 'custom', apiKey: 'k', protocol: 'invented', apiKeyEnv: 'BAD-NAME' },
      policy: { maxOutputs: 99.8, maxVideoDurationSec: -5, maxInlineMiB: 999, maxInputMiB: 0, allowedInputDirs: ['relative/path', '/tmp/ok'] },
    })
    expect(config.image?.protocol).toBeUndefined()
    expect(config.image?.enabled).toBe(false)
    expect(config.image?.apiKeyEnv).toBeUndefined()
    expect(config.policy).toEqual({
      maxOutputs: 4,
      maxVideoDurationSec: 1,
      maxInlineMiB: 256,
      maxInputMiB: 1,
      allowedInputDirs: ['/tmp/ok'],
    })
  })

  test('drops prototype-pollution keys from credential maps', () => {
    const config = normalizeConfig(JSON.parse('{"image":{"apiKeyByVendor":{"safe":"key","__proto__":"polluted","constructor":"bad","prototype":"bad"}}}'))
    expect(config.image?.apiKeyByVendor).toEqual({ safe: 'key' })
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  test('supports API keys from named environment variables without storing the value', () => {
    const preset = MEDIA_MODEL_PRESETS.find((item) => item.modality === 'image')
    if (!preset) throw new Error('missing image preset fixture')
    process.env.PRISMSTUDIO_TEST_API_KEY = 'environment-secret'
    const config = {
      image: { enabled: true, presetId: preset.id, apiKey: '', apiKeyEnv: 'PRISMSTUDIO_TEST_API_KEY' },
    }
    expect(isModalityReady(config, 'image')).toBe(true)
    expect(collectConfigSecrets(config)).toContain('environment-secret')
  })

  test('rejects malformed and remote HTTP Base URLs so readiness cannot show false LIVE', () => {
    expect(isValidHttpBaseUrl('not a url')).toBe(false)
    expect(isValidHttpBaseUrl('file:///tmp/provider')).toBe(false)
    expect(isValidHttpBaseUrl('http://provider.example.com')).toBe(false)
    expect(isValidHttpBaseUrl('http://127.0.0.1:8080/v1')).toBe(true)
    expect(isValidHttpBaseUrl('https://provider.example.com/v1')).toBe(true)

    const preset = MEDIA_MODEL_PRESETS.find((item) => item.modality === 'image')
    if (!preset) throw new Error('missing image preset fixture')
    expect(isModalityReady({ image: { enabled: true, presetId: preset.id, apiKey: 'key', baseUrl: 'not a url' } }, 'image')).toBe(false)
  })
})
