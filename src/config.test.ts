import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from './config'

const originalConfigPath = process.env.PRISMSTUDIO_CONFIG
const tempDirs: string[] = []

afterEach(() => {
  if (originalConfigPath === undefined) delete process.env.PRISMSTUDIO_CONFIG
  else process.env.PRISMSTUDIO_CONFIG = originalConfigPath
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
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
})
