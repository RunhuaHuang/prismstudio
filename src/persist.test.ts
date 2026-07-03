import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeFilename, persistGenerated } from './persist'

describe('persist · sanitizeFilename', () => {
  test('removes extension and unsafe path characters', () => {
    expect(sanitizeFilename('test-image.png')).toBe('test-image')
    expect(sanitizeFilename('sub/dir/image.jpg')).toBe('sub-dir-image')
    expect(sanitizeFilename('unsafe<>:"|?*name')).toBe('unsafe-name')
    expect(sanitizeFilename('  spaces  to  dashes  ')).toBe('spaces-to-dashes')
    expect(sanitizeFilename('...')).toBe('output') // fallback when everything is stripped
  })

  test('collapses consecutive dashes and removes leading/trailing dashes/dots', () => {
    expect(sanitizeFilename('---test---')).toBe('test')
    expect(sanitizeFilename('.test.')).toBe('test')
    expect(sanitizeFilename('-test.name-')).toBe('test.name')
  })
})

describe('persist · persistGenerated', () => {
  test('saves generated media and creates mcp content with custom name', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'duo-persist-test-'))
    const generated = [
      { mediaType: 'image/png', data: 'ZmFrZS1pbWFnZTE=' }, // 'fake-image1'
      { mediaType: 'image/png', data: 'ZmFrZS1pbWFnZTI=' }, // 'fake-image2'
    ]
    try {
      const res = persistGenerated(generated, '图片', { outputDir: cwd }, 'custom-name', 'VendorTag')
      expect(res.savedPaths).toHaveLength(2)
      expect(res.savedPaths[0]).toContain('custom-name-1.png')
      expect(res.savedPaths[1]).toContain('custom-name-2.png')

      expect(existsSync(res.savedPaths[0]!)).toBe(true)
      expect(existsSync(res.savedPaths[1]!)).toBe(true)

      expect(readFileSync(res.savedPaths[0]!, 'utf-8')).toBe('fake-image1')
      expect(readFileSync(res.savedPaths[1]!, 'utf-8')).toBe('fake-image2')

      // Check text block summary content
      const textBlock = res.content.find((c) => c.type === 'text')
      expect(textBlock?.text).toContain('图片已生成（2 个） · VendorTag')
      expect(textBlock?.text).toContain('custom-name-1.png')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
