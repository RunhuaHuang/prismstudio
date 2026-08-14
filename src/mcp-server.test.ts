import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from './config'
import { MEDIA_MODEL_PRESETS, buildAvailableTools, createMcpServer, resolveGenerationSessionId, validateMcpToolArguments, watchConfigForToolChanges } from './mcp-server'

const originalConfigPath = process.env.PRISMSTUDIO_CONFIG
const tempDirs: string[] = []

afterEach(() => {
  if (originalConfigPath === undefined) delete process.env.PRISMSTUDIO_CONFIG
  else process.env.PRISMSTUDIO_CONFIG = originalConfigPath
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('mcp server · dynamic tool list', () => {
  test('reflects config enable/disable changes without recreating the server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismstudio-mcp-test-'))
    tempDirs.push(dir)
    process.env.PRISMSTUDIO_CONFIG = join(dir, 'config.json')

    const server = createMcpServer()
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      expect((await client.listTools()).tools).toHaveLength(0)

      const preset = MEDIA_MODEL_PRESETS.find((item) => item.modality === 'image')
      if (!preset) throw new Error('missing image preset fixture')
      saveConfig({ image: { enabled: true, presetId: preset.id, apiKey: 'test-key' }, policy: { maxOutputs: 2, allow4k: false } })

      const enabled = (await client.listTools()).tools
      expect(enabled.map((tool) => tool.name)).toEqual(['generate_image'])
      expect(enabled[0]?.inputSchema.properties?.numberOfImages).toMatchObject({
        type: 'integer',
        minimum: 1,
        maximum: 2,
      })
      expect(enabled[0]?.inputSchema.properties?.imageSize.enum).not.toContain('4K')

      saveConfig({ image: { enabled: false, presetId: preset.id, apiKey: 'test-key' } })
      expect((await client.listTools()).tools).toHaveLength(0)
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('builds image/video schemas from the current runtime policy', () => {
    const image = MEDIA_MODEL_PRESETS.find((item) => item.modality === 'image')
    const video = MEDIA_MODEL_PRESETS.find((item) => item.modality === 'video')
    if (!image || !video) throw new Error('missing presets')
    const tools = buildAvailableTools({
      image: { enabled: true, presetId: image.id, apiKey: 'k' },
      video: { enabled: true, presetId: video.id, apiKey: 'k' },
      policy: { maxOutputs: 3, maxVideoDurationSec: 12, allow4k: true },
    })
    const imageTool = tools.find((tool) => tool.name === 'generate_image')!
    const videoTool = tools.find((tool) => tool.name === 'generate_video')!
    expect(imageTool.inputSchema.properties?.numberOfImages.maximum).toBe(3)
    expect(videoTool.inputSchema.properties?.numberOfVideos.maximum).toBe(3)
    expect(videoTool.inputSchema.properties?.duration.maximum).toBe(12)
    expect(imageTool.inputSchema.additionalProperties).toBe(false)
    expect(videoTool.inputSchema.additionalProperties).toBe(false)
  })

  test('validates runtime tool arguments and rejects cross-modality count bypasses', () => {
    expect(validateMcpToolArguments('image', { prompt: 'cat', number_of_images: 2 })).toEqual({ prompt: 'cat', numberOfImages: 2 })
    expect(() => validateMcpToolArguments('image', { prompt: 'cat', numberOfVideos: 4 })).toThrow(/只接受 numberOfImages/)
    expect(() => validateMcpToolArguments('video', { prompt: 'clip', numberOfImages: 4 })).toThrow(/只接受 numberOfVideos/)
    expect(() => validateMcpToolArguments('image', { prompt: 'cat', unknownField: true })).toThrow(/未知工具参数/)
    expect(() => validateMcpToolArguments('image', { prompt: 'cat', numberOfImages: '2' })).toThrow(/整数/)
    expect(() => validateMcpToolArguments('video', { prompt: 'clip', numberOfVideos: 0 })).toThrow(/不能小于/)
    expect(validateMcpToolArguments('audio', { prompt: 'say hello', task: 'tts' })).toMatchObject({ text: 'say hello', task: 'tts' })
  })

  test('accepts the documented session_id compatibility alias and gives transport metadata precedence', () => {
    const args = validateMcpToolArguments('image', { prompt: 'edit it', session_id: 'conversation-42' })
    expect(args).toEqual({ prompt: 'edit it', sessionId: 'conversation-42' })
    expect(resolveGenerationSessionId(args)).toBe('conversation-42')
    expect(resolveGenerationSessionId(args, 'transport-session')).toBe('transport-session')
  })

  test('rejects unsafe session IDs and the removed shot_type pseudo-parameter', () => {
    expect(() => validateMcpToolArguments('image', { prompt: 'edit it', sessionId: 'contains a space' })).toThrow(/sessionId 格式无效/)
    expect(() => validateMcpToolArguments('image', { prompt: 'edit it', sessionId: '_starts-with-a-symbol' })).toThrow(/sessionId 格式无效/)
    expect(() => resolveGenerationSessionId({ sessionId: 'contains a space' })).toThrow(/sessionId 必须是/)
    expect(() => validateMcpToolArguments('video', { prompt: 'clip', shot_type: 'multi' })).toThrow(/未知工具参数: shot_type/)
  })

  test('notifies connected clients when the atomically replaced config changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prismstudio-mcp-test-'))
    tempDirs.push(dir)
    process.env.PRISMSTUDIO_CONFIG = join(dir, 'config.json')
    saveConfig({})

    const server = createMcpServer()
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const stopWatching = watchConfigForToolChanges(server, { intervalMs: 50, debounceMs: 0 })

    try {
      const notification = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timed out waiting for tools/list_changed')), 2_000)
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          clearTimeout(timeout)
          resolve()
        })
      })
      await new Promise((resolve) => setTimeout(resolve, 80))
      const preset = MEDIA_MODEL_PRESETS.find((item) => item.modality === 'image')
      if (!preset) throw new Error('missing image preset fixture')
      saveConfig({ image: { enabled: true, presetId: preset.id, apiKey: 'test-key' } })
      await notification
    } finally {
      stopWatching()
      await client.close()
      await server.close()
    }
  })
})
