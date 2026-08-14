import { afterEach, describe, expect, test } from 'bun:test'
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDiagnosticsPath, writeGenerationDiagnostic } from './diagnostics'

const tempDirs: string[] = []
const originalConfigPath = process.env.PRISMSTUDIO_CONFIG

afterEach(() => {
  if (originalConfigPath === undefined) delete process.env.PRISMSTUDIO_CONFIG
  else process.env.PRISMSTUDIO_CONFIG = originalConfigPath
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('diagnostics', () => {
  test('writes only enabled structured events to the configured path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismstudio-diagnostics-test-'))
    tempDirs.push(dir)
    const path = join(dir, 'events.jsonl')
    const config = { diagnostics: { enabled: true, logFile: path } }
    writeGenerationDiagnostic(config, {
      requestId: 'req-1', source: 'mcp', outcome: 'success', modality: 'image',
      protocol: 'openai-images', model: 'test-model', elapsedMs: 42, outputCount: 1,
      ...( { prompt: 'must-not-be-logged' } as unknown as Record<string, unknown> ),
    } as never)
    const event = JSON.parse(readFileSync(getDiagnosticsPath(config), 'utf-8').trim())
    expect(event).toMatchObject({ requestId: 'req-1', source: 'mcp', outcome: 'success', elapsedMs: 42 })
    expect(event.prompt).toBeUndefined()
    expect(event.apiKey).toBeUndefined()
    expect(event.prompt).toBeUndefined()
  })

  test('redacts configured secrets from provider errors before writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismstudio-diagnostics-secret-test-'))
    tempDirs.push(dir)
    const path = join(dir, 'events.jsonl')
    const secret = 'sk-live-super-secret-value'
    const config = {
      image: { enabled: true, presetId: 'custom', apiKey: secret },
      diagnostics: { enabled: true, logFile: path },
    }
    writeGenerationDiagnostic(config, {
      requestId: 'req-secret', source: 'mcp', outcome: 'error', modality: 'image',
      elapsedMs: 5, error: `upstream echoed ${secret}`,
    })
    const raw = readFileSync(path, 'utf-8')
    expect(raw).not.toContain(secret)
    expect(raw).toContain('[REDACTED]')
  })

  test('removes local paths, data URIs, and signed URL queries from errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismstudio-diagnostics-path-test-'))
    tempDirs.push(dir)
    const path = join(dir, 'events.jsonl')
    const config = { diagnostics: { enabled: true, logFile: path } }
    writeGenerationDiagnostic(config, {
      requestId: 'req-path', source: 'webui', outcome: 'error', modality: 'video', elapsedMs: 2,
      error: 'failed /Users/alice/private/ref.png data:image/png;base64,SECRET https://cdn.example.com/file.mp4?X-Amz-Signature=secret&token=abc',
    })
    const raw = readFileSync(path, 'utf-8')
    expect(raw).not.toContain('/Users/alice')
    expect(raw).not.toContain('SECRET')
    expect(raw).not.toContain('X-Amz-Signature')
    expect(raw).not.toContain('token=abc')
    expect(raw).toContain('[LOCAL_PATH]')
    expect(raw).toContain('https://cdn.example.com/file.mp4')
  })

  test('redacts request prompt and temporary WebUI secrets even when they are not in config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismstudio-diagnostics-prompt-test-'))
    tempDirs.push(dir)
    const path = join(dir, 'events.jsonl')
    const config = { diagnostics: { enabled: true, logFile: path } }
    const prompt = 'a unique private prompt 9f31c8'
    const temporaryKey = 'temporary-secret-9f31c8'
    writeGenerationDiagnostic(config, {
      requestId: 'req-prompt', source: 'webui', outcome: 'error', modality: 'audio', elapsedMs: 1,
      error: `provider echoed prompt=${prompt}; key=${temporaryKey}`,
    }, [prompt, temporaryKey])
    const raw = readFileSync(path, 'utf-8')
    expect(raw).not.toContain(prompt)
    expect(raw).not.toContain(temporaryKey)
    expect(raw).toContain('[REDACTED]')
  })

  test('refuses a diagnostic path equal to config.json, including a symlink alias', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismstudio-diagnostics-conflict-test-'))
    tempDirs.push(dir)
    const configPath = join(dir, 'config.json')
    process.env.PRISMSTUDIO_CONFIG = configPath
    writeFileSync(configPath, '{"safe":true}\n')
    const direct = { diagnostics: { enabled: true, logFile: configPath } }
    writeGenerationDiagnostic(direct, {
      requestId: 'req-conflict', source: 'mcp', outcome: 'success', modality: 'image', elapsedMs: 1,
    })
    expect(readFileSync(configPath, 'utf-8')).toBe('{"safe":true}\n')

    const alias = join(dir, 'diagnostics.jsonl')
    symlinkSync(configPath, alias)
    writeGenerationDiagnostic({ diagnostics: { enabled: true, logFile: alias } }, {
      requestId: 'req-conflict-link', source: 'mcp', outcome: 'success', modality: 'image', elapsedMs: 1,
    })
    expect(readFileSync(configPath, 'utf-8')).toBe('{"safe":true}\n')

    if (process.platform !== 'win32') {
      const hardlink = join(dir, 'diagnostics-hardlink.jsonl')
      linkSync(configPath, hardlink)
      writeGenerationDiagnostic({ diagnostics: { enabled: true, logFile: hardlink } }, {
        requestId: 'req-conflict-hardlink', source: 'mcp', outcome: 'success', modality: 'image', elapsedMs: 1,
      })
      expect(readFileSync(configPath, 'utf-8')).toBe('{"safe":true}\n')
    }
  })
})
