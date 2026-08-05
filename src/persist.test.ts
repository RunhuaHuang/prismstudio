import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeFilename, persistGenerated, extForMediaType } from './persist'

describe('persist · extForMediaType', () => {
  test('image MIME → 正确扩展名', () => {
    expect(extForMediaType('image/png')).toBe('.png')
    expect(extForMediaType('image/jpeg')).toBe('.jpg')
    expect(extForMediaType('image/webp')).toBe('.webp')
    expect(extForMediaType('image/gif')).toBe('.gif')
  })

  test('video MIME → 正确扩展名', () => {
    expect(extForMediaType('video/mp4')).toBe('.mp4')
    expect(extForMediaType('video/webm')).toBe('.webm')
    expect(extForMediaType('video/quicktime')).toBe('.mov')
    // 回归：matroska 不再落到默认 .mp4
    expect(extForMediaType('video/x-matroska')).toBe('.mkv')
  })

  test('audio MIME → 正确扩展名', () => {
    expect(extForMediaType('audio/mpeg')).toBe('.mp3')
    expect(extForMediaType('audio/wav')).toBe('.wav')
    expect(extForMediaType('audio/flac')).toBe('.flac')
    expect(extForMediaType('audio/ogg')).toBe('.ogg')
    expect(extForMediaType('audio/aac')).toBe('.aac')
    expect(extForMediaType('audio/mp4')).toBe('.m4a')
    // 回归：opus 不再落到默认 .wav
    expect(extForMediaType('audio/opus')).toBe('.opus')
  })

  test('未知类型落到 .bin', () => {
    expect(extForMediaType('application/octet-stream')).toBe('.bin')
  })
})

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

  test('never overwrites an existing filename or symlink target', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'duo-persist-collision-test-'))
    const outside = join(tmpdir(), `duo-persist-outside-${Date.now()}.png`)
    try {
      writeFileSync(outside, 'must-stay-unchanged')
      symlinkSync(outside, join(cwd, 'custom-name.png'))

      const res = persistGenerated(
        [{ mediaType: 'image/png', data: Buffer.from('new-image').toString('base64') }],
        '图片',
        { outputDir: cwd },
        'custom-name',
      )

      expect(res.savedPaths[0]).toBe(join(cwd, 'custom-name-2.png'))
      expect(readFileSync(res.savedPaths[0]!, 'utf-8')).toBe('new-image')
      expect(readFileSync(outside, 'utf-8')).toBe('must-stay-unchanged')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(outside, { force: true })
    }
  })
})
