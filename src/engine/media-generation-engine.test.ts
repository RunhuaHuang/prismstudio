import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateMedia,
  resolveMediaConfig,
  resolveEffectiveMediaCredentials,
  findPresetByModel,
  MEDIA_MODEL_PRESETS,
  setLastGenerated,
  getLastGenerated,
  clearMediaGenerationSessionHistory,
  resolveDashscopeVideoVariant,
} from './media-generation-engine'
import type { ResolvedMediaConfig } from './media-generation-engine'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

/** 按调用顺序返回不同 Response 的 fetch mock */
function makeSequencedFetch(responses: Array<{ ok: boolean; status?: number; json?: unknown; text?: string; headers?: Record<string, string>; arrayBuffer?: ArrayBuffer }>): {
  fetchFn: typeof fetch
  calls: Array<{ url: string; method: string; body?: string; rawBody?: BodyInit | null; headers: Headers }>
} {
  let idx = 0
  const calls: Array<{ url: string; method: string; body?: string; rawBody?: BodyInit | null; headers: Headers }> = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({ url, method, body, rawBody: init?.body ?? null, headers: new Headers(init?.headers) })
    const res = responses[Math.min(idx, responses.length - 1)]!
    idx++
    const textContent = res.text !== undefined ? res.text : (res.json !== undefined ? JSON.stringify(res.json) : '')
    return {
      ok: res.ok,
      status: res.status ?? (res.ok ? 200 : 400),
      headers: new Headers(res.headers ?? { 'content-type': 'application/json' }),
      json: async () => res.json ?? {},
      text: async () => textContent,
      arrayBuffer: async () => res.arrayBuffer ?? new ArrayBuffer(1),
    } as Response
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

function arrayBufferFromBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

function makeTarBuffer(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(entry.data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii')
    header.fill(' ', 148, 156)
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let checksum = 0
    for (const byte of header) checksum += byte
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
    chunks.push(header, entry.data)
    const padding = (512 - (entry.data.length % 512)) % 512
    if (padding > 0) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

function makeImageConfig(overrides: Partial<ResolvedMediaConfig> = {}): ResolvedMediaConfig {
  return {
    preset: null, modality: 'image', protocol: 'openai-images',
    baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2', supportsEdit: true, ...overrides,
  }
}

function makeVertexAuthorizedUserCredential(projectId = 'runai-project', suffix = 'test'): string {
  return JSON.stringify({
    type: 'authorized_user',
    client_id: `client-${suffix}`,
    client_secret: 'secret',
    refresh_token: `refresh-${suffix}`,
    quota_project_id: projectId,
  })
}

function mockGoogleTokenExchange(accessToken = 'vertex-token'): void {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: accessToken, expires_in: 3600 }),
    text: async () => JSON.stringify({ access_token: accessToken, expires_in: 3600 }),
    headers: new Headers({ 'content-type': 'application/json' }),
  })) as unknown as typeof fetch
}

// ===== 预设解析 =====

describe('media-generation-engine · 预设', () => {
  test('MEDIA_MODEL_PRESETS 覆盖三模态主流厂商', () => {
    const byModality = { image: 0, video: 0, audio: 0 }
    for (const p of MEDIA_MODEL_PRESETS) byModality[p.modality]++
    expect(byModality.image).toBeGreaterThan(5)
    expect(byModality.video).toBeGreaterThan(4)
    expect(byModality.audio).toBeGreaterThan(4)
    // 关键厂商
    const models = MEDIA_MODEL_PRESETS.map((p) => p.model)
    expect(models).toContain('gpt-image-2')
    expect(models).toContain('qwen-image-2.0-pro')
    expect(models).toContain('cogvideox-3')
    expect(models).toContain('kling-v2')
    expect(models).toContain('glm-tts')
    expect(models).toContain('music-2.6')
    expect(models).toContain('cosyvoice-v3.5-plus')
    expect(models).toContain('qwen3-tts-instruct-flash')
    expect(models).toContain('hy-image-v3.0')
    expect(models).toContain('hy-image-lite')
    expect(models).toContain('hy-video-1.5')
    expect(models).toContain('happyhorse-1.1-t2v')
    expect(models).toContain('gemini-3.1-flash-lite-image')
    expect(models).toContain('veo-3.1-generate-preview')
    expect(models).toContain('veo-3.1-fast-generate-preview')
    expect(models).toContain('veo-3.1-lite-generate-preview')
    expect(models).toContain('gemini-omni-flash-preview')
  })

  test('resolveMediaConfig 按 model + modality 命中预设', () => {
    const cfg = resolveMediaConfig({ model: 'gpt-image-2', apiKey: 'k' }, 'image')
    expect(cfg!.modality).toBe('image')
    expect(cfg!.protocol).toBe('openai-images')
    expect(cfg!.preset?.model).toBe('gpt-image-2')
  })

  test('resolveMediaConfig 视频 Seedance 命中 volcengine-async', () => {
    const cfg = resolveMediaConfig({ model: 'doubao-Seedance-1-0-pro-t2v-250428', apiKey: 'k' }, 'video')
    expect(cfg!.protocol).toBe('volcengine-async')
  })

  test('resolveMediaConfig 跨模态同名不串扰（cosyvoice-v2 在 image 下查不到）', () => {
    const cfg = resolveMediaConfig({ model: 'cosyvoice-v2', apiKey: 'k' }, 'image')
    // cosyvoice-v2 是音频模型，image 模态下应走自定义分支
    expect(cfg!.preset).toBeNull()
  })

  test('resolveMediaConfig 缺 model 返回 null', () => {
    expect(resolveMediaConfig({ apiKey: 'k' }, 'image')).toBeNull()
  })

  test('自定义模型按模态选择默认协议，且视频不自动开启上一轮编辑续接', () => {
    const video = resolveMediaConfig({ presetId: 'custom', model: 'my-video', apiKey: 'k' }, 'video')
    expect(video!.protocol).toBe('kling-async')
    expect(video!.supportsEdit).toBe(false)

    const audio = resolveMediaConfig({ presetId: 'custom', model: 'my-tts', apiKey: 'k' }, 'audio')
    expect(audio!.protocol).toBe('dashscope-sync')

    const image = resolveMediaConfig({ presetId: 'custom', model: 'my-image', apiKey: 'k' }, 'image')
    expect(image!.protocol).toBe('openai-images')
    expect(image!.supportsEdit).toBe(true)
  })

  test('findPresetByModel 带 modality 过滤', () => {
    expect(findPresetByModel('glm-tts', 'audio')?.vendor).toBe('智谱')
    expect(findPresetByModel('glm-tts', 'image')).toBeUndefined()
  })

  test('音频旧脏配置顶层为空时，按面板缓存的有效渠道回退', () => {
    const credentials = resolveEffectiveMediaCredentials({
      apiKey: '',
      baseUrl: 'https://api.minimaxi.com/v1',
      model: 'speech-02-hd-clone',
      protocol: 'minimax-voice-clone',
      presetId: 'minimax-clone',
      audioTask: 'clone',
      apiKeyByPreset: JSON.stringify({ 'qwen-tts': 'dashscope-key' }),
      baseUrlByPreset: JSON.stringify({ 'qwen-tts': 'https://dashscope.aliyuncs.com/api/v1' }),
      modelByPreset: JSON.stringify({ 'qwen-tts': 'qwen3-tts-flash' }),
    }, 'audio')
    expect(credentials).toMatchObject({
      apiKey: 'dashscope-key',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      model: 'qwen3-tts-flash',
      protocol: 'dashscope-sync',
      presetId: 'qwen-tts',
      audioTask: 'tts',
    })
    expect(resolveMediaConfig(credentials, 'audio')?.model).toBe('qwen3-tts-flash')
  })

  test('音频合法渠道未填 key 时不偷切到其它渠道', () => {
    const credentials = resolveEffectiveMediaCredentials({
      apiKey: '',
      model: 'speech-2.8-hd',
      protocol: 'minimax',
      presetId: 'minimax-tts',
      audioTask: 'tts',
      apiKeyByPreset: JSON.stringify({ 'qwen-tts': 'dashscope-key' }),
      modelByPreset: JSON.stringify({ 'qwen-tts': 'qwen3-tts-flash' }),
    }, 'audio')
    expect(credentials.presetId).toBe('minimax-tts')
    expect(credentials.apiKey).toBe('')
    expect(credentials.model).toBe('speech-2.8-hd')
  })

})

// ===== 图像 openai-images =====

describe('media-generation-engine · 图像 openai-images', () => {
  test('文生图走 /images/generations 并解析 b64_json', async () => {
    const { fetchFn, calls } = makeSequencedFetch([{ ok: true, json: { data: [{ b64_json: 'AAAA' }] } }])
    const r = await generateMedia({ modality: 'image', prompt: 'cat', config: makeImageConfig(), apiKey: 'sk', fetchFn })
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/images/generations')
    expect(r.images[0]!.data).toBe('AAAA')
  })

  test('OpenAI Images 可从 prompt 识别横版/比例并映射为支持尺寸', async () => {
    const { fetchFn, calls } = makeSequencedFetch([{ ok: true, json: { data: [{ b64_json: 'AAAA' }] } }])
    await generateMedia({
      modality: 'image', prompt: '生成一张 16:9 横版产品海报', config: makeImageConfig({ model: 'gpt-image-2' }), apiKey: 'sk', fetchFn,
    })
    expect(JSON.parse(calls[0]!.body!).size).toBe('1536x1024')
  })

  test('Seedream 5.0 小尺寸自动提升到高分辨率有效尺寸', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { data: [{ url: 'https://ark/i.png' }] } },
      { ok: true, headers: { 'content-type': 'image/png' } },
    ])
    await generateMedia({
      modality: 'image',
      prompt: '小猪在天上飞',
      size: '1024x1024',
      watermark: true,
      config: makeImageConfig({
        model: 'doubao-seedream-5-0-260128',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      }),
      apiKey: 'ark',
      fetchFn,
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(calls[0]!.url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations')
    expect(body.size).toBe('2048x2048')
    expect(body.response_format).toBe('url')
    expect(body.stream).toBe(false)
    expect(body.watermark).toBe(true)
    expect(body.sequential_image_generation).toBe('disabled')
    expect(body.n).toBeUndefined()
  })

  test('Seedream 5.0 比例尺寸映射到满足最小像素要求的推荐尺寸', async () => {
    const { fetchFn, calls } = makeSequencedFetch([{ ok: true, json: { data: [{ b64_json: 'AAAA' }] } }])
    await generateMedia({
      modality: 'image',
      prompt: '生成一张 16:9 横版产品海报',
      config: makeImageConfig({
        model: 'doubao-seedream-5-0-260128',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      }),
      apiKey: 'ark',
      fetchFn,
    })
    expect(JSON.parse(calls[0]!.body!).size).toBe('2560x1440')
  })

  test('Seedream 5.0 Pro 小尺寸自动提升到 Pro 有效尺寸（像素范围 [1280x720, 2048x2048]）', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { data: [{ url: 'https://ark/i.png' }] } },
      { ok: true, headers: { 'content-type': 'image/png' } },
    ])
    await generateMedia({
      modality: 'image',
      prompt: '小猪在天上飞',
      size: '640x360', // 16:9 比例，640x360=230400 < 921600
      config: makeImageConfig({
        model: 'doubao-seedream-5-0-pro-251220',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      }),
      apiKey: 'ark',
      fetchFn,
    })
    const body = JSON.parse(calls[0]!.body!)
    // 640x360 (16:9) < 921600，应提升到 16:9 的 1K 档 1312x736
    expect(body.size).toBe('1312x736')
  })

  test('Seedream 5.0 Pro 比例尺寸正确映射到 1K 档位', async () => {
    const { fetchFn, calls } = makeSequencedFetch([{ ok: true, json: { data: [{ b64_json: 'AAAA' }] } }])
    await generateMedia({
      modality: 'image',
      prompt: '生成一张 16:9 横版图',
      size: '16:9',
      config: makeImageConfig({
        model: 'doubao-seedream-5-0-pro-251220',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      }),
      apiKey: 'ark',
      fetchFn,
    })
    // Pro 16:9 比例档位应为 1312x736（1K 档像素值）
    expect(JSON.parse(calls[0]!.body!).size).toBe('1312x736')
  })

  test('Seedream 5.0 Pro 大尺寸自动裁剪到最大像素限制', async () => {
    const { fetchFn, calls } = makeSequencedFetch([{ ok: true, json: { data: [{ b64_json: 'AAAA' }] } }])
    await generateMedia({
      modality: 'image',
      prompt: '超高分辨率图片',
      size: '4096x4096', // 4096x4096=16777216 > 2048x2048=4194304
      config: makeImageConfig({
        model: 'doubao-seedream-5-0-pro-251220',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      }),
      apiKey: 'ark',
      fetchFn,
    })
    const body = JSON.parse(calls[0]!.body!)
    // 应缩放到 2048x2048 或保持 1:1 比例在最大像素范围内
    const pixels = body.size.split('x').map(Number).reduce((a, b) => a * b, 1)
    expect(pixels).toBeLessThanOrEqual(2048 * 2048)
  })

  test('Seedream 5.0 Pro 尺寸超出宽高比限制抛错', async () => {
    // 使用一个能被 parseSize 解析但宽高比超出 [1/16, 16] 限制的尺寸
    // 5000x100 = 50:1，超过 16:1 限制
    const { fetchFn } = makeSequencedFetch([])
    await expect(generateMedia({
      modality: 'image',
      prompt: '超宽图',
      size: '5000x100', // 宽高比 50:1，超过 16:1 限制
      config: makeImageConfig({
        model: 'doubao-seedream-5-0-pro-251220',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      }),
      apiKey: 'ark',
      fetchFn,
    })).rejects.toThrow(/宽高比必须在.*范围内/)
  })

  test('Seedream 参考图编辑仍走 /images/generations JSON image 数组，不走 /images/edits multipart', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-seedream-ref-'))
    const ref = join(cwd, 'ref.png')
    writeFileSync(ref, Buffer.from('fake-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { data: [{ url: 'https://ark/i.png' }] } },
        { ok: true, headers: { 'content-type': 'image/png' } },
      ])
      await generateMedia({
        modality: 'image', prompt: '把图里的猫换成狗', apiKey: 'ark',
        referencePaths: [ref], isEdit: true, cwd,
        config: makeImageConfig({ model: 'doubao-seedream-5-0-260128', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }),
        fetchFn,
      })
      expect(calls[0]!.url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations')
      const body = JSON.parse(calls[0]!.body!)
      expect(body.image[0]).toMatch(/^data:image\/png;base64,/)
      expect(calls[0]!.rawBody).not.toBeInstanceOf(FormData)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('OpenAI Images 文生图透传高级参数', async () => {
    const { fetchFn, calls } = makeSequencedFetch([{ ok: true, json: { data: [{ b64_json: 'AAAA' }] } }])
    const r = await generateMedia({
      modality: 'image', prompt: 'cat', config: makeImageConfig(), apiKey: 'sk', fetchFn,
      quality: 'high', outputFormat: 'webp', outputCompression: 80, background: 'auto', moderation: 'low',
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.quality).toBe('high')
    expect(body.output_format).toBe('webp')
    expect(body.output_compression).toBe(80)
    expect(body.background).toBe('auto')
    expect(body.moderation).toBe('low')
    expect(r.images[0]!.mediaType).toBe('image/webp')
  })

  test('OpenAI Images 编辑也通过 multipart 透传高级参数', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-media-openai-edit-'))
    const ref = join(cwd, 'ref.png')
    writeFileSync(ref, Buffer.from('fake-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([{ ok: true, json: { data: [{ b64_json: 'EDITED' }] } }])
      await generateMedia({
        modality: 'image', prompt: 'edit', config: makeImageConfig({ model: 'gpt-image-1' }), apiKey: 'sk', fetchFn,
        isEdit: true, referencePaths: [ref], cwd, quality: 'medium', outputFormat: 'jpeg', outputCompression: 70, background: 'opaque',
      })
      expect(calls[0]!.url).toBe('https://api.openai.com/v1/images/edits')
      const form = calls[0]!.rawBody as FormData
      expect(form.get('quality')).toBe('medium')
      expect(form.get('output_format')).toBe('jpeg')
      expect(form.get('output_compression')).toBe('70')
      expect(form.get('background')).toBe('opaque')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('gpt-image-2 阻止不支持的透明背景参数', async () => {
    const { fetchFn } = makeSequencedFetch([{ ok: true, json: { data: [{ b64_json: 'AAAA' }] } }])
    await expect(generateMedia({
      modality: 'image', prompt: 'cat', config: makeImageConfig({ model: 'gpt-image-2' }), apiKey: 'sk', fetchFn, background: 'transparent',
    })).rejects.toThrow(/gpt-image-2 不支持透明背景/)
  })

  test('outputCompression 要求 jpeg/webp 输出格式', async () => {
    const { fetchFn } = makeSequencedFetch([{ ok: true, json: { data: [{ b64_json: 'AAAA' }] } }])
    await expect(generateMedia({
      modality: 'image', prompt: 'cat', config: makeImageConfig(), apiKey: 'sk', fetchFn, outputFormat: 'png', outputCompression: 80,
    })).rejects.toThrow(/outputCompression 仅适用于/)
  })

  test('M6 修复：MiniMax 透传 n', async () => {
    const { fetchFn, calls } = makeSequencedFetch([{ ok: true, json: { data: { image_urls: ['https://x/p.png'] } } }, { ok: true }])
    await generateMedia({
      modality: 'image', prompt: 'x', numberOfImages: 3, apiKey: 'mm',
      config: makeImageConfig({ protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'image-01' }),
      fetchFn,
    })
    expect(calls[0]!.url).toBe('https://api.minimax.chat/v1/image_generation')
    const body = JSON.parse(calls[0]!.body!)
    expect(body.n).toBe(3)
    expect(body.response_format).toBe('url')
  })

  test('minimax 图生图支持 subject_reference', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-minimax-i2i-'))
    const ref = join(cwd, 'ref.png')
    writeFileSync(ref, Buffer.from('fake-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([{ ok: true, json: { data: { image_urls: ['https://x/p.png'] } } }, { ok: true }])
      await generateMedia({
        modality: 'image', prompt: '一只可爱的猫', apiKey: 'mm', referencePaths: [ref], cwd,
        config: makeImageConfig({ protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'image-01' }),
        fetchFn,
      })
      expect(calls[0]!.url).toBe('https://api.minimax.chat/v1/image_generation')
      const body = JSON.parse(calls[0]!.body!)
      expect(body.subject_reference).toEqual([
        {
          type: 'character',
          image_file: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
        }
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('url 返回自动下载（智谱 cogview）', async () => {
    const { fetchFn } = makeSequencedFetch([
      { ok: true, json: { data: [{ url: 'https://e/img.png' }] } },
      { ok: true, headers: { 'content-type': 'image/png' } },
    ])
    const r = await generateMedia({ modality: 'image', prompt: 'x', config: makeImageConfig(), apiKey: 'sk', fetchFn })
    expect(r.images[0]!.mediaType).toBe('image/png')
  })

  test('智谱 GLM-Image 使用官方 /images/generations 字段，不透传 OpenAI 专有参数', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { data: [{ url: 'https://z/i.png' }] } },
      { ok: true, headers: { 'content-type': 'image/png' } },
    ])
    await generateMedia({
      modality: 'image', prompt: '手机竖屏海报', apiKey: 'k', size: '9:16', quality: 'high', watermark: false,
      config: makeImageConfig({ modality: 'image', protocol: 'openai-images', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-image' }),
      fetchFn,
    })
    expect(calls[0]!.url).toBe('https://open.bigmodel.cn/api/paas/v4/images/generations')
    const body = JSON.parse(calls[0]!.body!)
    expect(body).toEqual({
      model: 'glm-image',
      prompt: '手机竖屏海报',
      size: '960x1728',
      quality: 'hd',
      watermark_enabled: false,
    })
  })

  test('M5 修复：非 JSON 200 给出 HTTP 上下文而非 SyntaxError', async () => {
    const { fetchFn } = makeSequencedFetch([{ ok: true, text: '<html>bad gateway</html>' }])
    await expect(generateMedia({ modality: 'image', prompt: 'x', config: makeImageConfig(), apiKey: 'sk', fetchFn }))
      .rejects.toThrow(/非 JSON 响应/)
  })

  test('图片 API 成功但空结果时抛明确错误', async () => {
    const { fetchFn } = makeSequencedFetch([{ ok: true, json: { data: [] } }])
    await expect(generateMedia({ modality: 'image', prompt: 'x', config: makeImageConfig(), apiKey: 'sk', fetchFn }))
      .rejects.toThrow(/未返回图片/)
  })

  test('M2 修复：MiniMax 空结果给出明确错误而非静默返回空', async () => {
    const { fetchFn } = makeSequencedFetch([{ ok: true, json: { data: { image_urls: [] } } }])
    await expect(generateMedia({
      modality: 'image', prompt: 'x', apiKey: 'mm',
      config: makeImageConfig({ protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'image-01' }),
      fetchFn,
    })).rejects.toThrow(/未返回图片/)
  })

  test('参考文件在 cwd 之外时拒绝读取，避免意外外传本地文件', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-media-cwd-'))
    const outside = join(tmpdir(), `run-media-outside-${Date.now()}.png`)
    writeFileSync(outside, Buffer.from('fake-image'))
    try {
      const { fetchFn } = makeSequencedFetch([{ ok: true, json: { data: [{ b64_json: 'AAAA' }] } }])
      await expect(generateMedia({
        modality: 'image',
        prompt: 'edit',
        config: makeImageConfig(),
        apiKey: 'sk',
        isEdit: true,
        referencePaths: [outside],
        cwd,
        fetchFn,
      })).rejects.toThrow(/没有可用文件/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(outside, { force: true })
    }
  })
})

// ===== 图像 stability（SDXL/SD3/Ultra 同步 multipart） =====

describe('media-generation-engine · 图像 stability', () => {
  test('SDXL 同步：multipart + Accept json，返回 image base64', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { image: 'STABILITYBASE64', finish_reason: 'SUCCESS', seed: 42 } },
    ])
    const r = await generateMedia({
      modality: 'image', prompt: 'a cat', apiKey: 'sk-stab',
      config: makeImageConfig({ modality: 'image', protocol: 'stability', baseUrl: 'https://api.stability.ai/v2beta/stable-image/generate', model: 'sdxl' }),
      fetchFn,
    })
    expect(calls[0]!.url).toBe('https://api.stability.ai/v2beta/stable-image/generate/sdxl')
    expect(calls[0]!.method).toBe('POST')
    expect(r.images[0]!.data).toBe('STABILITYBASE64')
    expect(r.images[0]!.mediaType).toBe('image/png')
  })

  test('未返回 image 字段时抛错', async () => {
    const { fetchFn } = makeSequencedFetch([{ ok: true, json: { finish_reason: 'CONTENT_FILTERED' } }])
    await expect(generateMedia({
      modality: 'image', prompt: 'x', apiKey: 'sk',
      config: makeImageConfig({ modality: 'image', protocol: 'stability', baseUrl: 'https://api.stability.ai/v2beta/stable-image/generate', model: 'sd3' }),
      fetchFn,
    })).rejects.toThrow(/未返回图片数据/)
  })
})

// ===== 图像 midjourney（第三方 MJ 网关） =====

describe('media-generation-engine · 图像 midjourney', () => {
  test('提交 /mj/submit/imagine + 轮询 /mj/task/{id}/fetch → SUCCESS 取图', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { code: 1, description: 'success', result: 'mj-task-1' } },
      { ok: true, json: { status: 'IN_PROGRESS', progress: '32%' } },
      { ok: true, json: { status: 'SUCCESS', imageUrl: 'https://mj/i.png' } },
      { ok: true, headers: { 'content-type': 'image/png' } },
    ])
    const r = await generateMedia({
      modality: 'image', prompt: 'a cat --ar 16:9', apiKey: 'mj-secret', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'image', protocol: 'midjourney', baseUrl: 'https://mj-gw.example.com', model: 'midjourney' }),
      fetchFn,
    })
    expect(calls[0]!.url).toBe('https://mj-gw.example.com/mj/submit/imagine')
    expect(calls[1]!.url).toBe('https://mj-gw.example.com/mj/task/mj-task-1/fetch')
    expect(r.images[0]!.mediaType).toBe('image/png')
  })

  test('size 比例串自动拼成 --ar 参数', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { code: 1, result: 't' } },
      { ok: true, json: { status: 'SUCCESS', imageUrl: 'https://mj/i.png' } },
      { ok: true },
    ])
    await generateMedia({
      modality: 'image', prompt: 'a dog', size: '16:9', apiKey: 'k', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'image', protocol: 'midjourney', baseUrl: 'https://gw.com', model: 'midjourney' }),
      fetchFn,
    })
    const submitBody = JSON.parse(calls[0]!.body!)
    expect(submitBody.prompt).toBe('a dog --ar 16:9')
  })

  test('code 24（内容违规）抛错', async () => {
    const { fetchFn } = makeSequencedFetch([
      { ok: true, json: { code: 24, description: 'banned word' } },
    ])
    await expect(generateMedia({
      modality: 'image', prompt: 'x', apiKey: 'k',
      config: makeImageConfig({ modality: 'image', protocol: 'midjourney', baseUrl: 'https://gw.com', model: 'midjourney' }),
      fetchFn,
    })).rejects.toThrow(/拒绝生成|内容违规/)
  })

  test('status FAILURE 抛错带 failReason', async () => {
    const { fetchFn } = makeSequencedFetch([
      { ok: true, json: { code: 1, result: 't2' } },
      { ok: true, json: { status: 'FAILURE', failReason: 'quota exceeded' } },
    ])
    await expect(generateMedia({
      modality: 'image', prompt: 'x', apiKey: 'k', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'image', protocol: 'midjourney', baseUrl: 'https://gw.com', model: 'midjourney' }),
      fetchFn,
    })).rejects.toThrow('quota exceeded')
  })

  test('缺 baseUrl 抛错', async () => {
    await expect(generateMedia({
      modality: 'image', prompt: 'x', apiKey: 'k',
      config: makeImageConfig({ modality: 'image', protocol: 'midjourney', baseUrl: '', model: 'midjourney' }),
    })).rejects.toThrow(/缺少 baseUrl/)
  })
})

// ===== 图像 tencent-hunyuan-async (混元生图 3.0) =====

describe('media-generation-engine · 图像 tencent-hunyuan-async', () => {
  test('提交 /api/image/submit + 轮询 /api/image/query → SUCCESS 取图', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { code: 0, message: 'success', data: { id: 'hy-task-123' } } },
      { ok: true, json: { code: 0, message: 'success', data: { status: 'PROCESSING' } } },
      { ok: true, json: { code: 0, message: 'success', data: { status: 'SUCCEEDED', images: [{ url: 'https://tokenhub/i.png' }] } } },
      { ok: true, headers: { 'content-type': 'image/png' } },
    ])
    const r = await generateMedia({
      modality: 'image', prompt: '雨中, 竹林, 小路', apiKey: 'tokenhub-secret', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'image', protocol: 'tencent-hunyuan-async', baseUrl: 'https://tokenhub.tencentmaas.com/v1', model: 'hy-image-v3.0' }),
      fetchFn,
    })
    expect(calls[0]!.url).toBe('https://tokenhub.tencentmaas.com/v1/api/image/submit')
    const submitBody = JSON.parse(calls[0]!.body!)
    expect(submitBody.model).toBe('hy-image-v3.0')
    expect(submitBody.prompt).toBe('雨中, 竹林, 小路')
    expect(calls[1]!.url).toBe('https://tokenhub.tencentmaas.com/v1/api/image/query')
    const queryBody = JSON.parse(calls[1]!.body!)
    expect(queryBody.model).toBe('hy-image-v3.0')
    expect(queryBody.id).toBe('hy-task-123')
    expect(r.images[0]!.mediaType).toBe('image/png')
  })

  test('参考图使用 Data URI 传给 TokenHub 图生图', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-tokenhub-i2i-'))
    const ref = join(cwd, 'ref.png')
    writeFileSync(ref, Buffer.from('fake-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { code: 0, message: 'success', data: { id: 'hy-task-ref' } } },
        { ok: true, json: { code: 0, message: 'success', data: { status: 'SUCCEEDED', images: [{ url: 'https://tokenhub/i.png' }] } } },
        { ok: true, headers: { 'content-type': 'image/png' } },
      ])
      await generateMedia({
        modality: 'image', prompt: '改成赛博朋克风', apiKey: 'tokenhub-secret', pollIntervalMs: 0,
        referencePaths: [ref], cwd,
        config: makeImageConfig({ modality: 'image', protocol: 'tencent-hunyuan-async', baseUrl: 'https://tokenhub.tencentmaas.com/v1', model: 'hy-image-v3.0' }),
        fetchFn,
      })
      const submitBody = JSON.parse(calls[0]!.body!)
      expect(submitBody.image).toBe('data:image/png;base64,ZmFrZS1pbWFnZQ==')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// ===== 图像 dashscope-async（M1 size 格式） =====

describe('media-generation-engine · 图像 dashscope-async', () => {
  test('万相图像可从自然语言识别竖屏 1080p 分辨率', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { task_id: 't' } } },
      { ok: true, json: { output: { task_status: 'SUCCEEDED', results: [{ b64_image: 'IMG' }] } } },
    ])
    await generateMedia({
      modality: 'image', prompt: '生成手机竖屏 1080p 海报', apiKey: 'k', pollIntervalMs: 0,
      config: makeImageConfig({ protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wanx2.1-t2i-turbo' }),
      fetchFn,
    })
    expect(JSON.parse(calls[0]!.body!).parameters.size).toBe('1080*1920')
  })

  test('DashScope 图像透传 negativePrompt/seed/promptEnhance/watermark', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { choices: [{ message: { content: [{ image: 'data:image/png;base64,IMG' }] } }] } } },
    ])
    await generateMedia({
      modality: 'image', prompt: 'x', apiKey: 'k', pollIntervalMs: 0,
      negativePrompt: 'low quality', seed: 123, promptEnhance: false, watermark: false,
      config: makeImageConfig({ protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen-image' }),
      fetchFn,
    })
    const parameters = JSON.parse(calls[0]!.body!).parameters
    expect(parameters.negative_prompt).toBe('low quality')
    expect(parameters.seed).toBe(123)
    expect(parameters.prompt_extend).toBe(false)
    expect(parameters.watermark).toBe(false)
  })

  test('M1 修复：万相 size 用 * 分隔（1024*1024）', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { task_id: 't1', task_status: 'PENDING' } } },
      { ok: true, json: { output: { task_status: 'SUCCEEDED', results: [{ url: 'https://d/i.png' }] } } },
      { ok: true, headers: { 'content-type': 'image/png' } },
    ])
    await generateMedia({
      modality: 'image', prompt: '猫', apiKey: 'k', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'image', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wanx2.1-t2i-plus' }),
      fetchFn,
    })
    const submitBody = JSON.parse(calls[0]!.body!)
    expect(submitBody.parameters.size).toBe('1024*1024')
  })

  test('Qwen Image 新链路：qwen-image-2.0-pro 走 multimodal-generation 同步接口且 size 用 * 分隔', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { choices: [{ message: { content: [{ image: 'data:image/png;base64,IMG' }] } }] } } },
    ])
    await generateMedia({
      modality: 'image', prompt: '猫', apiKey: 'k', size: '1440x2560', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'image', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen-image-2.0-pro' }),
      fetchFn,
    })
    const submitBody = JSON.parse(calls[0]!.body!)
    expect(calls[0]!.url).toBe('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
    expect(submitBody.input.messages[0].content).toEqual([{ text: '猫' }])
    expect(submitBody.parameters.size).toBe('1440*2560')
    expect(submitBody.parameters.n).toBe(1)
    expect(calls).toHaveLength(1)
  })

  test('Qwen Image 新链路：可从提示词识别 2K 9:16 并映射到官方推荐尺寸', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { choices: [{ message: { content: [{ image: 'data:image/png;base64,IMG' }] } }] } } },
    ])
    await generateMedia({
      modality: 'image', prompt: '写实照片 2K 9:16', apiKey: 'k', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'image', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen-image-2.0-pro' }),
      fetchFn,
    })
    expect(JSON.parse(calls[0]!.body!).parameters.size).toBe('1536*2688')
  })

  test('Qwen Image 编辑旧链路仍走 image-generation/generation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runai-qwen-edit-'))
    try {
      const refPath = join(dir, 'ref.png')
      writeFileSync(refPath, Buffer.from('ref'))
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { output: { task_id: 't1' } } },
        { ok: true, json: { output: { task_status: 'SUCCEEDED', results: [{ b64_image: 'IMG' }] } } },
      ])
      await generateMedia({
        modality: 'image', prompt: '改成夜景', apiKey: 'k', pollIntervalMs: 0,
        referencePaths: [refPath], isEdit: true,
        config: makeImageConfig({ modality: 'image', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen-image', editModel: 'qwen-image-edit' }),
        fetchFn,
      })
      const submitBody = JSON.parse(calls[0]!.body!)
      expect(calls[0]!.url).toBe('https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation')
      expect(submitBody.model).toBe('qwen-image-edit')
      expect(submitBody.input.image_url).toMatch(/^data:image\/png;base64,/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('任务 FAILED 时抛错', async () => {
    const { fetchFn } = makeSequencedFetch([
      { ok: true, json: { output: { task_id: 't1' } } },
      { ok: true, json: { output: { task_status: 'FAILED', message: '内容违规' } } },
    ])
    await expect(generateMedia({
      modality: 'image', prompt: 'x', apiKey: 'k', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'image', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wanx2.1-t2i-turbo' }),
      fetchFn,
    })).rejects.toThrow('内容违规')
  })

  test('M1 修复：比例串 16:9 归一化为像素（万相 → 1280*720）', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { task_id: 't1' } } },
      { ok: true, json: { output: { task_status: 'SUCCEEDED', results: [{ url: 'https://d/i.png' }] } } },
      { ok: true },
    ])
    await generateMedia({
      modality: 'image', prompt: 'x', apiKey: 'k', size: '16:9', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'image', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wanx2.1-t2i-plus' }),
      fetchFn,
    })
    expect(JSON.parse(calls[0]!.body!).parameters.size).toBe('1280*720')
  })
})

// ===== 视频 =====

describe('media-generation-engine · 视频', () => {
  test('volcengine-async（Seedance）：按火山 body 参数提交 + 轮询 succeeded', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { id: 'task-1', status: 'running' } },
      { ok: true, json: { id: 'task-1', status: 'queued' } },
      { ok: true, json: { id: 'task-1', status: 'succeeded', content: { file_url: 'https://v/m.mp4' } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    const r = await generateMedia({
      modality: 'video', prompt: '奔跑', apiKey: 'k', pollIntervalMs: 0, size: '9:16',
      duration: 5, fps: 24, frames: 120, resolution: '720p', seed: 7, withAudio: true, returnLastFrame: true, cameraFixed: true, watermark: false,
      config: makeImageConfig({ modality: 'video', protocol: 'volcengine-async', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedance-2-0-260128' }),
      fetchFn,
    })
    expect(calls[0]!.url).toContain('/contents/generations/tasks')
    const body = JSON.parse(calls[0]!.body!)
    expect(body.model).toBe('doubao-seedance-2-0-260128')
    expect(body.content).toEqual([{ type: 'text', text: '奔跑' }])
    expect(body.ratio).toBe('9:16')
    expect(body.duration).toBe(5)
    expect(body.framespersecond).toBe(24)
    expect(body.frames).toBe(120)
    expect(body.resolution).toBe('720p')
    expect(body.generate_audio).toBe(true)
    expect(body.return_last_frame).toBe(true)
    expect(body.camera_fixed).toBe(true)
    expect(body.watermark).toBe(false)
    expect(body.seed).toBe(7)
    expect(r.images[0]!.mediaType).toBe('video/mp4')
  })

  test('kling-async（可灵）：提交 + 轮询 succeed', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { data: { task_id: 'kt' } } },
      { ok: true, json: { data: { task_status: 'processing' } } },
      { ok: true, json: { data: { task_status: 'succeed', task_result: { videos: [{ url: 'https://k/v.mp4' }] } } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video', prompt: 'x', apiKey: 'k', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'video', protocol: 'kling-async', baseUrl: 'https://api.klingai.com', model: 'kling-v2' }),
      fetchFn,
    })
    expect(calls[0]!.url).toBe('https://api.klingai.com/v1/videos/text2video')
    expect(calls[1]!.url).toBe('https://api.klingai.com/v1/videos/text2video/kt')
  })

  test('kling-async（可灵）：当 apiKey 为 AccessKey:SecretKey 格式时，自动生成 JWT 签名', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { data: { task_id: 'kt' } } },
      { ok: true, json: { data: { task_status: 'succeed', task_result: { videos: [{ url: 'https://k/v.mp4' }] } } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video', prompt: 'x', apiKey: 'my_access_key:my_secret_key', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'video', protocol: 'kling-async', baseUrl: 'https://api.klingai.com', model: 'kling-v2' }),
      fetchFn,
    })
    
    // Auth header structure check
    const auth0 = calls[0]!.headers.get('Authorization')!
    expect(auth0).toContain('Bearer ')
    const token0 = auth0.substring(7)
    const parts0 = token0.split('.')
    expect(parts0.length).toBe(3)
    
    const header = JSON.parse(Buffer.from(parts0[0]!, 'base64').toString())
    expect(header.alg).toBe('HS256')
    expect(header.typ).toBe('JWT')
    
    const payload = JSON.parse(Buffer.from(parts0[1]!, 'base64').toString())
    expect(payload.iss).toBe('my_access_key')
    expect(typeof payload.exp).toBe('number')
  })

  test('kling-async 透传 mode/guidanceScale/negativePrompt/cameraFixed', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { data: { task_id: 'kt' } } },
      { ok: true, json: { data: { task_status: 'succeed', task_result: { videos: [{ url: 'https://k/v.mp4' }] } } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video', prompt: 'x', apiKey: 'k', pollIntervalMs: 0,
      negativePrompt: 'blur', mode: 'pro', guidanceScale: 0.7, cameraFixed: true,
      config: makeImageConfig({ modality: 'video', protocol: 'kling-async', baseUrl: 'https://api.klingai.com', model: 'kling-v2' }),
      fetchFn,
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.negative_prompt).toBe('blur')
    expect(body.mode).toBe('pro')
    expect(body.cfg_scale).toBe(0.7)
    expect(body.camera_control.type).toBe('fixed')
  })

  test('kling-async 可从 prompt 识别竖屏比例', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { data: { task_id: 'kt' } } },
      { ok: true, json: { data: { task_status: 'succeed', task_result: { videos: [{ url: 'https://k/v.mp4' }] } } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video', prompt: '生成一个手机竖屏短视频', apiKey: 'k', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'video', protocol: 'kling-async', baseUrl: 'https://api.klingai.com', model: 'kling-v2' }),
      fetchFn,
    })
    expect(JSON.parse(calls[0]!.body!).aspect_ratio).toBe('9:16')
  })

  test('kling-async 支持直接传 9:16 等比例字符串', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { data: { task_id: 'kt' } } },
      { ok: true, json: { data: { task_status: 'succeed', task_result: { videos: [{ url: 'https://k/v.mp4' }] } } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video', prompt: 'x', apiKey: 'k', pollIntervalMs: 0, size: '9:16',
      config: makeImageConfig({ modality: 'video', protocol: 'kling-async', baseUrl: 'https://api.klingai.com', model: 'kling-v2' }),
      fetchFn,
    })
    expect(JSON.parse(calls[0]!.body!).aspect_ratio).toBe('9:16')
  })

  test('zhipu-async（CogVideoX-3）：按官方字段提交 + /async-result 轮询', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { id: 'zt', task_status: 'PROCESSING' } },
      { ok: true, json: { task_status: 'SUCCESS', video_result: [{ url: 'https://z/v.mp4' }] } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video', prompt: 'x', apiKey: 'k', pollIntervalMs: 0, size: '9:16',
      fps: 60, duration: 10, mode: 'quality', withAudio: true, watermark: false,
      config: makeImageConfig({ modality: 'video', protocol: 'zhipu-async', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'CogVideoX-3' }),
      fetchFn,
    })
    expect(calls[0]!.url).toBe('https://open.bigmodel.cn/api/paas/v4/videos/generations')
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      model: 'cogvideox-3',
      prompt: 'x',
      size: '1080x1920',
      fps: 60,
      duration: 10,
      quality: 'quality',
      with_audio: true,
      watermark_enabled: false,
    })
    expect(calls[1]!.url).toBe('https://open.bigmodel.cn/api/paas/v4/async-result/zt')
  })

  test('dashscope-async（万相视频）：video-generation/video-synthesis + tasks 轮询（C3 修复：认 video_url）', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { task_id: 'wt' } } },
      // C3 修复：视频成功返回 output.video_url（单字符串），而非 results 数组
      { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    const r = await generateMedia({
      modality: 'video', prompt: 'x', apiKey: 'k', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.7-t2v' }),
      fetchFn,
    })
    expect(calls[0]!.url).toContain('/services/aigc/video-generation/video-synthesis')
    expect(calls[1]!.url).toBe('https://dashscope.aliyuncs.com/api/v1/tasks/wt')
    expect(r.images[0]!.mediaType).toBe('video/mp4')
  })

  test('dashscope-async 非路由 i2v 模型缺少参考图时提前提示', async () => {
    // 用非 happyhorse/wan2.7 的自定义 i2v 模型测试变体强制逻辑（智能路由不影响）
    await expect(generateMedia({
      modality: 'video', prompt: 'x', apiKey: 'k', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'custom-model-i2v' }),
      fetchFn: (async () => { throw new Error('不应发起请求') }) as unknown as typeof fetch,
    })).rejects.toThrow('需要参考图')
  })

  test('dashscope-async 图生视频：有参考图时走 video-synthesis 并传 media[first_frame]（弃用旧 img_url）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-media-video-cwd-'))
    const ref = join(cwd, 'ref.png')
    writeFileSync(ref, Buffer.from('fake-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { output: { task_id: 'ivt' } } },
        { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
        { ok: true, headers: { 'content-type': 'video/mp4' } },
      ])
      await generateMedia({
        modality: 'video', prompt: '让图中的猫眨眼', apiKey: 'k', pollIntervalMs: 0,
        referencePaths: [ref],
        cwd,
        config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.7-i2v' }),
        fetchFn,
      })
      expect(calls[0]!.url).toContain('/services/aigc/video-generation/video-synthesis')
      const body = JSON.parse(calls[0]!.body!)
      // 新接口统一使用 media 数组，不再传旧版 img_url
      expect(body.input.img_url).toBeUndefined()
      expect(body.input.media[0].type).toBe('first_frame')
      expect(body.input.media[0].url).toMatch(/^data:image\/png;base64,/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('HappyHorse 文生视频（t2v）走新接口 resolution+ratio，不传 size/prompt_extend', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { task_id: 'hh-t2v' } } },
      { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video', prompt: '海浪拍岸', apiKey: 'k', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'happyhorse-1.1-t2v' }),
      fetchFn,
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.model).toBe('happyhorse-1.1-t2v')
    // 文档参数：resolution + ratio + duration，无 size
    // 未显式指定 resolution 时不传，交给 DashScope 使用官方默认值（当前文档为 1080P）
    expect(body.parameters.resolution).toBeUndefined()
    expect(body.parameters.ratio).toBe('16:9')
    expect(body.parameters.duration).toBeUndefined()
    expect(body.parameters.size).toBeUndefined()
    // HappyHorse 文档无 prompt_extend 字段，不应发送
    expect(body.parameters.prompt_extend).toBeUndefined()
    // t2v 无 media
    expect(body.input.media).toBeUndefined()
    expect(body.input.prompt).toBe('海浪拍岸')
  })

  test('HappyHorse 文生视频：用户指定 720P 和 12 秒时透传 resolution/duration', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { task_id: 'hh-t2v-params' } } },
      { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video', prompt: '生成一个 720P、12秒 的海边视频', apiKey: 'k', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'happyhorse-1.1-t2v' }),
      fetchFn,
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.parameters.resolution).toBe('720P')
    expect(body.parameters.duration).toBe(12)
  })

  test('HappyHorse 图生视频（i2v）media type=first_frame，不传 ratio（跟随首帧）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-happyhorse-i2v-'))
    const ref = join(cwd, 'start.png')
    writeFileSync(ref, Buffer.from('fake-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { output: { task_id: 'hh-i2v' } } },
        { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
        { ok: true, headers: { 'content-type': 'video/mp4' } },
      ])
      await generateMedia({
        modality: 'video', prompt: '让画面动起来', apiKey: 'k', pollIntervalMs: 0,
        referencePaths: [ref], cwd,
        config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'happyhorse-1.1-i2v' }),
        fetchFn,
      })
      const body = JSON.parse(calls[0]!.body!)
      expect(body.model).toBe('happyhorse-1.1-i2v')
      expect(body.input.media[0].type).toBe('first_frame')
      expect(body.input.media[0].url).toMatch(/^data:image\/png;base64,/)
      // i2v 跟随首帧比例，文档无 ratio
      expect(body.parameters.ratio).toBeUndefined()
      expect(body.parameters.resolution).toBeUndefined()
      expect(body.parameters.prompt_extend).toBeUndefined()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('HappyHorse 参考生视频（r2v）支持多张参考图 media type=reference_image（最多 9 张）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-happyhorse-r2v-'))
    const refs = [join(cwd, 'a.png'), join(cwd, 'b.png'), join(cwd, 'c.png')]
    for (const f of refs) writeFileSync(f, Buffer.from('fake-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { output: { task_id: 'hh-r2v' } } },
        { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
        { ok: true, headers: { 'content-type': 'video/mp4' } },
      ])
      await generateMedia({
        modality: 'video', prompt: '角色走进咖啡馆', apiKey: 'k', pollIntervalMs: 0,
        referencePaths: refs, cwd,
        config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'happyhorse-1.1-r2v' }),
        fetchFn,
      })
      const body = JSON.parse(calls[0]!.body!)
      expect(body.model).toBe('happyhorse-1.1-r2v')
      // 3 张参考图全部透传，type 均为 reference_image
      expect(body.input.media).toHaveLength(3)
      for (const item of body.input.media) expect(item.type).toBe('reference_image')
      expect(body.input.media[0].url).toMatch(/^data:image\/png;base64,/)
      // r2v 文档支持 ratio
      expect(body.parameters.ratio).toBe('16:9')
      expect(body.parameters.prompt_extend).toBeUndefined()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('HappyHorse r2v 缺少参考图时智能路由到 t2v（不报错）', async () => {
    // 智能路由：happyhorse-1.1-r2v + 0 张图 → 自动路由到 happyhorse-1.1-t2v，不报错
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { task_id: 'hh-route-t2v' } } },
      { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video', prompt: 'x', apiKey: 'k', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'happyhorse-1.1-r2v' }),
      fetchFn,
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.model).toBe('happyhorse-1.1-t2v')
  })

  // ===== 智能路由单元测试 =====
  test('resolveDashscopeVideoVariant：HappyHorse 0图→t2v', () => {
    expect(resolveDashscopeVideoVariant('happyhorse-1.1-t2v', 0)).toBe('happyhorse-1.1-t2v')
    expect(resolveDashscopeVideoVariant('happyhorse-1.1-i2v', 0)).toBe('happyhorse-1.1-t2v')
  })

  test('resolveDashscopeVideoVariant：HappyHorse 1图 referenceMode=first_frame(默认)→i2v', () => {
    expect(resolveDashscopeVideoVariant('happyhorse-1.1-t2v', 1)).toBe('happyhorse-1.1-i2v')
    expect(resolveDashscopeVideoVariant('happyhorse-1.1-t2v', 1, 'first_frame')).toBe('happyhorse-1.1-i2v')
  })

  test('resolveDashscopeVideoVariant：HappyHorse 1图 referenceMode=reference→r2v', () => {
    expect(resolveDashscopeVideoVariant('happyhorse-1.1-t2v', 1, 'reference')).toBe('happyhorse-1.1-r2v')
  })

  test('resolveDashscopeVideoVariant：≥2张图强制 r2v（无视 referenceMode）', () => {
    expect(resolveDashscopeVideoVariant('happyhorse-1.1-t2v', 2)).toBe('happyhorse-1.1-r2v')
    expect(resolveDashscopeVideoVariant('happyhorse-1.1-t2v', 3, 'first_frame')).toBe('happyhorse-1.1-r2v')
    expect(resolveDashscopeVideoVariant('happyhorse-1.1-t2v', 9)).toBe('happyhorse-1.1-r2v')
  })

  test('resolveDashscopeVideoVariant：wan2.7 系列（含日期快照）同样路由', () => {
    expect(resolveDashscopeVideoVariant('wan2.7-t2v', 0)).toBe('wan2.7-t2v')
    expect(resolveDashscopeVideoVariant('wan2.7-t2v', 1)).toBe('wan2.7-i2v')
    expect(resolveDashscopeVideoVariant('wan2.7-i2v', 2)).toBe('wan2.7-r2v')
    expect(resolveDashscopeVideoVariant('wan2.7-t2v-2026-04-25', 1, 'reference')).toBe('wan2.7-r2v-2026-04-25')
  })

  test('resolveDashscopeVideoVariant：videoedit 与非路由系列返回 null', () => {
    expect(resolveDashscopeVideoVariant('wan2.7-videoedit', 1)).toBeNull()
    expect(resolveDashscopeVideoVariant('kling-v3', 1)).toBeNull()
    expect(resolveDashscopeVideoVariant('doubao-seedance-2-0-260128', 0)).toBeNull()
    expect(resolveDashscopeVideoVariant('happyhorse-1.1-t2v', 0)).not.toBeNull()
  })

  test('智能路由端到端：wan2.7-t2v + 1图默认走 i2v 并传 first_frame', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-route-wan27-i2v-'))
    const ref = join(cwd, 'start.png')
    writeFileSync(ref, Buffer.from('fake-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { output: { task_id: 'rt-i2v' } } },
        { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
        { ok: true, headers: { 'content-type': 'video/mp4' } },
      ])
      await generateMedia({
        modality: 'video', prompt: '让画面动起来', apiKey: 'k', pollIntervalMs: 0,
        referencePaths: [ref], cwd,
        config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.7-t2v' }),
        fetchFn,
      })
      const body = JSON.parse(calls[0]!.body!)
      // 存储的是 t2v，但路由后实际请求 i2v
      expect(body.model).toBe('wan2.7-i2v')
      expect(body.input.media[0].type).toBe('first_frame')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('wan2.7 文生视频：negative_prompt/audio_url 放在 input，prompt_extend 放在 parameters', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { task_id: 'wan-t2v-audio' } } },
      { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video', prompt: '猫咪将军念诗', apiKey: 'k', pollIntervalMs: 0,
      negativePrompt: 'low quality',
      promptEnhance: true,
      audioUrl: 'https://example.com/voice.mp3',
      config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.7-t2v' }),
      fetchFn,
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.input.negative_prompt).toBe('low quality')
    expect(body.input.audio_url).toBe('https://example.com/voice.mp3')
    expect(body.parameters.prompt_extend).toBe(true)
    expect(body.parameters.negative_prompt).toBeUndefined()
  })

  test('wan2.7 文生视频：用户指定 1080P 和 15 秒时透传 resolution/duration', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { task_id: 'wan-t2v-params' } } },
      { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video', prompt: '生成 1920x1080、15秒 的写实视频', apiKey: 'k', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.7-t2v' }),
      fetchFn,
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.parameters.resolution).toBe('1080P')
    expect(body.parameters.duration).toBe(15)
  })

  test('wan2.7 图生视频：支持首尾帧和 driving_audio', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-wan27-i2v-full-'))
    const first = join(cwd, 'first.png')
    const last = join(cwd, 'last.png')
    writeFileSync(first, Buffer.from('first-image'))
    writeFileSync(last, Buffer.from('last-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { output: { task_id: 'wan-i2v-full' } } },
        { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
        { ok: true, headers: { 'content-type': 'video/mp4' } },
      ])
      await generateMedia({
        modality: 'video', prompt: '从首帧移动到尾帧', apiKey: 'k', pollIntervalMs: 0,
        referencePaths: [first], lastFramePath: last, audioUrl: 'https://example.com/drive.mp3', cwd,
        config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.7-i2v-2026-04-25' }),
        fetchFn,
      })
      const body = JSON.parse(calls[0]!.body!)
      expect(body.model).toBe('wan2.7-i2v-2026-04-25')
      expect(body.input.media.map((m: { type: string }) => m.type)).toEqual(['first_frame', 'last_frame', 'driving_audio'])
      expect(body.input.media[1].url).toMatch(/^data:image\/png;base64,/)
      expect(body.input.media[2].url).toBe('https://example.com/drive.mp3')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('wan2.7 视频续写：videoUrl 路由到 i2v 并传 first_clip', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { task_id: 'wan-first-clip' } } },
      { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video', prompt: '继续向前走', apiKey: 'k', pollIntervalMs: 0,
      videoUrl: 'https://example.com/start.mp4',
      config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.7-t2v' }),
      fetchFn,
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.model).toBe('wan2.7-i2v')
    expect(body.input.media).toEqual([{ type: 'first_clip', url: 'https://example.com/start.mp4' }])
  })

  test('wan2.7 参考生视频：referenceMode=reference 时 videoUrl/audioUrl 作为 reference_video/reference_voice', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-wan27-r2v-media-'))
    const ref = join(cwd, 'role.png')
    writeFileSync(ref, Buffer.from('role-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { output: { task_id: 'wan-r2v-media' } } },
        { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
        { ok: true, headers: { 'content-type': 'video/mp4' } },
      ])
      await generateMedia({
        modality: 'video', prompt: '参考角色和声音生成视频', apiKey: 'k', pollIntervalMs: 0,
        referencePaths: [ref], referenceMode: 'reference',
        videoUrl: 'https://example.com/ref.mp4',
        audioUrl: 'https://example.com/voice.mp3',
        cwd,
        config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.7-t2v' }),
        fetchFn,
      })
      const body = JSON.parse(calls[0]!.body!)
      expect(body.model).toBe('wan2.7-r2v')
      expect(body.input.media[0].type).toBe('reference_image')
      expect(body.input.media[1]).toEqual({ type: 'reference_video', url: 'https://example.com/ref.mp4' })
      expect(body.input.reference_voice).toBe('https://example.com/voice.mp3')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('wan2.7 参考生视频：含 reference_video 时 duration 限制为 2~10 秒', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-wan27-r2v-duration-'))
    const ref = join(cwd, 'role.png')
    writeFileSync(ref, Buffer.from('role-image'))
    try {
      await expect(generateMedia({
        modality: 'video', prompt: '参考角色和视频生成', apiKey: 'k',
        referencePaths: [ref], referenceMode: 'reference',
        videoUrl: 'https://example.com/ref.mp4',
        duration: 11,
        cwd,
        config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.7-t2v' }),
        fetchFn: (async () => { throw new Error('不应发起请求') }) as unknown as typeof fetch,
      })).rejects.toThrow('2~10 秒整数')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('wan2.7 视频编辑：videoUrl + 参考图构造 video/reference_image，并支持 audio_setting', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-wan27-videoedit-'))
    const ref = join(cwd, 'ref.png')
    writeFileSync(ref, Buffer.from('ref-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { output: { task_id: 'wan-edit' } } },
        { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
        { ok: true, headers: { 'content-type': 'video/mp4' } },
      ])
      await generateMedia({
        modality: 'video', prompt: '替换衣服', apiKey: 'k', pollIntervalMs: 0,
        videoUrl: 'https://example.com/input.mp4', referencePaths: [ref], cwd,
        negativePrompt: 'blur', promptEnhance: true, audioSetting: 'origin',
        config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.7-videoedit' }),
        fetchFn,
      })
      const body = JSON.parse(calls[0]!.body!)
      expect(body.input.media[0]).toEqual({ type: 'video', url: 'https://example.com/input.mp4' })
      expect(body.input.media[1].type).toBe('reference_image')
      expect(body.input.negative_prompt).toBe('blur')
      expect(body.parameters.prompt_extend).toBe(true)
      expect(body.parameters.audio_setting).toBe('origin')
      expect(body.parameters.duration).toBeUndefined()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('wan2.7 视频编辑：duration=0 和 1080P 分辨率可透传', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { task_id: 'wan-edit-duration-zero' } } },
      { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video', prompt: '将整个画面转成黏土风格', apiKey: 'k', pollIntervalMs: 0,
      videoUrl: 'https://example.com/input.mp4',
      duration: 0,
      resolution: '1080p',
      config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.7-videoedit' }),
      fetchFn,
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.parameters.duration).toBe(0)
    expect(body.parameters.resolution).toBe('1080P')
  })

  test('wan2.7 视频编辑：duration 非 0 时限制为 2~10 秒', async () => {
    await expect(generateMedia({
      modality: 'video',
      prompt: '将整个画面转成黏土风格',
      apiKey: 'k',
      videoUrl: 'https://example.com/input.mp4',
      duration: 11,
      config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'wan2.7-videoedit' }),
      fetchFn: (async () => { throw new Error('不应发起请求') }) as unknown as typeof fetch,
    })).rejects.toThrow('2~10 秒整数')
  })

  test('HappyHorse 过滤未支持字段：不传 negative_prompt/prompt_extend/fps', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { task_id: 'hh-filter' } } },
      { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video', prompt: '海浪', apiKey: 'k', pollIntervalMs: 0,
      negativePrompt: 'bad', promptEnhance: false, fps: 24,
      config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'happyhorse-1.1-t2v' }),
      fetchFn,
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.input.negative_prompt).toBeUndefined()
    expect(body.parameters.negative_prompt).toBeUndefined()
    expect(body.parameters.prompt_extend).toBeUndefined()
    expect(body.parameters.fps).toBeUndefined()
  })

  test('HappyHorse 文生/图生/参考生视频拒绝 videoUrl，避免误走 wan2.7 视频续写', async () => {
    await expect(generateMedia({
      modality: 'video',
      prompt: '继续这个视频',
      apiKey: 'k',
      videoUrl: 'https://example.com/start.mp4',
      config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'happyhorse-1.1-t2v' }),
      fetchFn: (async () => { throw new Error('不应发起请求') }) as unknown as typeof fetch,
    })).rejects.toThrow('HappyHorse 仅视频编辑模型支持 videoUrl')
  })

  test('HappyHorse 视频编辑：videoUrl + 参考图构造 video/reference_image，并支持 audio_setting', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-happyhorse-videoedit-'))
    const ref = join(cwd, 'ref.png')
    writeFileSync(ref, Buffer.from('ref-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { output: { task_id: 'hh-edit' } } },
        { ok: true, json: { output: { task_status: 'SUCCEEDED', video_url: 'https://d/v.mp4' } } },
        { ok: true, headers: { 'content-type': 'video/mp4' } },
      ])
      await generateMedia({
        modality: 'video', prompt: '换成参考图里的衣服', apiKey: 'k', pollIntervalMs: 0,
        videoUrl: 'https://example.com/input.mp4', referencePaths: [ref], cwd,
        audioSetting: 'origin',
        config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'happyhorse-1.0-video-edit' }),
        fetchFn,
      })
      const body = JSON.parse(calls[0]!.body!)
      expect(body.model).toBe('happyhorse-1.0-video-edit')
      expect(body.input.media[0]).toEqual({ type: 'video', url: 'https://example.com/input.mp4' })
      expect(body.input.media[1].type).toBe('reference_image')
      expect(body.input.media[1].url).toMatch(/^data:image\/png;base64,/)
      expect(body.parameters.audio_setting).toBe('origin')
      expect(body.parameters.ratio).toBeUndefined()
      expect(body.input.negative_prompt).toBeUndefined()
      expect(body.parameters.prompt_extend).toBeUndefined()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('HappyHorse 视频编辑：支持 resolution，但拒绝 duration（官方不支持）', async () => {
    await expect(generateMedia({
      modality: 'video',
      prompt: '换衣服',
      apiKey: 'k',
      videoUrl: 'https://example.com/input.mp4',
      resolution: '1080p',
      duration: 5,
      config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'happyhorse-1.0-video-edit' }),
      fetchFn: (async () => { throw new Error('不应发起请求') }) as unknown as typeof fetch,
    })).rejects.toThrow('不支持通过 duration 指定输出时长')
  })

  test('DashScope 视频：非法分辨率提前拒绝，不静默降级', async () => {
    await expect(generateMedia({
      modality: 'video',
      prompt: '4k 海浪',
      apiKey: 'k',
      resolution: '4k',
      config: makeImageConfig({ modality: 'video', protocol: 'dashscope-async', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'happyhorse-1.1-t2v' }),
      fetchFn: (async () => { throw new Error('不应发起请求') }) as unknown as typeof fetch,
    })).rejects.toThrow('仅支持 720P 或 1080P')
  })


  test('tencent-hunyuan-async（混元生视频 1.5）：提交 + 轮询 SUCCESS 取视频', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { code: 0, message: 'success', data: { id: 'hy-v-task-999' } } },
      { ok: true, json: { code: 0, message: 'success', data: { status: 'PROCESSING' } } },
      { ok: true, json: { code: 0, message: 'success', data: { status: 'SUCCEEDED', videos: [{ url: 'https://tokenhub/v.mp4' }] } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    const r = await generateMedia({
      modality: 'video', prompt: '一只小狗', apiKey: 'tokenhub-secret', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'video', protocol: 'tencent-hunyuan-async', baseUrl: 'https://tokenhub.tencentmaas.com/v1', model: 'hy-video-1.5' }),
      fetchFn,
    })
    expect(calls[0]!.url).toBe('https://tokenhub.tencentmaas.com/v1/api/video/submit')
    const submitBody = JSON.parse(calls[0]!.body!)
    expect(submitBody.model).toBe('hy-video-1.5')
    expect(submitBody.prompt).toBe('一只小狗')
    expect(calls[1]!.url).toBe('https://tokenhub.tencentmaas.com/v1/api/video/query')
    const queryBody = JSON.parse(calls[1]!.body!)
    expect(queryBody.model).toBe('hy-video-1.5')
    expect(queryBody.id).toBe('hy-v-task-999')
    expect(r.images[0]!.mediaType).toBe('video/mp4')
  })

  test('TokenHub 图生视频参考图同时传 image/first_frame_image Data URI', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-tokenhub-i2v-'))
    const ref = join(cwd, 'ref.png')
    writeFileSync(ref, Buffer.from('fake-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { code: 0, message: 'success', data: { id: 'hy-v-task-ref' } } },
        { ok: true, json: { code: 0, message: 'success', data: { status: 'SUCCEEDED', videos: [{ url: 'https://tokenhub/v.mp4' }] } } },
        { ok: true, headers: { 'content-type': 'video/mp4' } },
      ])
      await generateMedia({
        modality: 'video', prompt: '让画面动起来', apiKey: 'tokenhub-secret', pollIntervalMs: 0,
        referencePaths: [ref], cwd,
        config: makeImageConfig({ modality: 'video', protocol: 'tencent-hunyuan-async', baseUrl: 'https://tokenhub.tencentmaas.com/v1', model: 'hy-video-1.5' }),
        fetchFn,
      })
      const submitBody = JSON.parse(calls[0]!.body!)
      expect(submitBody.image).toBe('data:image/png;base64,ZmFrZS1pbWFnZQ==')
      expect(submitBody.first_frame_image).toBe('data:image/png;base64,ZmFrZS1pbWFnZQ==')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('minimax 视频查询返回 file_id 时获取 download_url 后下载', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { task_id: 'mvt' } },
      { ok: true, json: { status: 'Success', file_id: 'file-1' } },
      { ok: true, json: { file: { download_url: 'https://mm/v.mp4' } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    const r = await generateMedia({
      modality: 'video', prompt: 'x', apiKey: 'k', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'video', protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'video-01' }),
      fetchFn,
    })
    expect(calls[2]!.url).toBe('https://api.minimax.chat/v1/files/retrieve?file_id=file-1')
    expect(r.images[0]!.mediaType).toBe('video/mp4')
  })

  test('minimax 图生视频传 first_frame_image 和官方视频参数', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-minimax-i2v-'))
    const ref = join(cwd, 'first.png')
    writeFileSync(ref, Buffer.from('fake-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { task_id: 'mvt' } },
        { ok: true, json: { status: 'Success', file_id: 'file-1' } },
        { ok: true, json: { file: { download_url: 'https://mm/v.mp4' } } },
        { ok: true, headers: { 'content-type': 'video/mp4' } },
      ])
      await generateMedia({
        modality: 'video', prompt: '让小猫跑向镜头', apiKey: 'k', pollIntervalMs: 0,
        referencePaths: [ref], cwd, duration: 6, resolution: '1080P', promptEnhance: false,
        config: makeImageConfig({ modality: 'video', protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'MiniMax-Hailuo-2.3' }),
        fetchFn,
      })
      const body = JSON.parse(calls[0]!.body!)
      expect(calls[0]!.url).toBe('https://api.minimax.chat/v1/video_generation')
      expect(body.model).toBe('MiniMax-Hailuo-2.3')
      expect(body.prompt).toBe('让小猫跑向镜头')
      expect(body.first_frame_image).toBe('data:image/png;base64,ZmFrZS1pbWFnZQ==')
      expect(body.duration).toBe(6)
      expect(body.resolution).toBe('1080P')
      expect(body.prompt_optimizer).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('gemini-generate-content（Vertex JSON）：走 Vertex generateContent 并使用 OAuth header', async () => {
    mockGoogleTokenExchange('vertex-image-token')
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'IMGBASE64' } }] } }] } },
    ])

    const r = await generateMedia({
      modality: 'image',
      prompt: '生成一张极简产品图',
      apiKey: makeVertexAuthorizedUserCredential('runai-project', 'gemini-image'),
      sessionId: 'vertex-gemini-image-test',
      aspectRatio: '16:9',
      config: makeImageConfig({
        modality: 'image',
        protocol: 'gemini-generate-content',
        baseUrl: 'https://aiplatform.googleapis.com',
        model: 'gemini-3.1-flash-image',
      }),
      fetchFn,
    })

    expect(calls[0]!.url).toBe('https://aiplatform.googleapis.com/v1/projects/runai-project/locations/global/publishers/google/models/gemini-3.1-flash-image:generateContent')
    expect(calls[0]!.headers.get('Authorization')).toBe('Bearer vertex-image-token')
    expect(calls[0]!.headers.get('x-goog-api-key')).toBeNull()
    const body = JSON.parse(calls[0]!.body!)
    expect(body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE'])
    expect(body.generationConfig.imageConfig.aspectRatio).toBe('16:9')
    expect(r.images[0]!.data).toBe('IMGBASE64')
  })

  test('gemini-generate-content：IMAGE_SAFETY 拦截时给出可读错误而非崩溃', async () => {
    const { fetchFn } = makeSequencedFetch([
      { ok: true, json: { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'IMAGE_SAFETY' }] } },
    ])
    await expect(generateMedia({
      modality: 'image', prompt: '可能被拦截的内容', apiKey: 'AIza-test',
      config: makeImageConfig({ modality: 'image', protocol: 'gemini-generate-content', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3.1-flash-image' }),
      fetchFn,
    })).rejects.toThrow('Gemini 未返回内容')
  })

  test('gemini-generate-content：content 完全不存在（RECITATION 等）时不崩溃', async () => {
    const { fetchFn } = makeSequencedFetch([
      { ok: true, json: { candidates: [{ finishReason: 'RECITATION' }] } },
    ])
    await expect(generateMedia({
      modality: 'image', prompt: 'x', apiKey: 'AIza-test',
      config: makeImageConfig({ modality: 'image', protocol: 'gemini-generate-content', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3.1-flash-image' }),
      fetchFn,
    })).rejects.toThrow('RECITATION')
  })

  test('gemini-generate-content：parts 有文本但无图片（NO_IMAGE）时显式报错', async () => {
    const { fetchFn } = makeSequencedFetch([
      { ok: true, json: { candidates: [{ content: { role: 'model', parts: [{ text: 'I cannot generate this image.' }] }, finishReason: 'NO_IMAGE' }] } },
    ])
    await expect(generateMedia({
      modality: 'image', prompt: 'x', apiKey: 'AIza-test',
      config: makeImageConfig({ modality: 'image', protocol: 'gemini-generate-content', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-3.1-flash-image' }),
      fetchFn,
    })).rejects.toThrow('未生成图片')
  })

  // ===== Google Veo / Gemini Omni（predictLongRunning 异步） =====

  test('google-interactions（Veo 文生视频）：predictLongRunning 提交 + 轮询 done + 下载签名 URL', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      // 提交：返回 operation name
      { ok: true, json: { name: 'publishers/google/operations/veo-op-123' } },
      // 轮询：未完成
      { ok: true, json: { name: 'publishers/google/operations/veo-op-123', done: false } },
      // 轮询：完成，返回签名 GCS URI
      { ok: true, json: { name: 'publishers/google/operations/veo-op-123', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://storage.googleapis.com/signed-veo-video.mp4' } }] } } } },
      // 下载视频二进制
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    const r = await generateMedia({
      modality: 'video', prompt: '一只猫在月光下奔跑', apiKey: 'google-key', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'veo-3.1-generate-preview' }),
      fetchFn,
    })
    // 提交：endpoint + x-goog-api-key header + instances/parameters 结构
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning')
    expect(calls[0]!.headers.get('x-goog-api-key')).toBe('google-key')
    const submitBody = JSON.parse(calls[0]!.body!)
    expect(submitBody.instances[0].prompt).toBe('一只猫在月光下奔跑')
    expect(submitBody.parameters.aspectRatio).toBe('16:9')
    expect(submitBody.parameters.numberOfVideos).toBeUndefined()
    expect(submitBody.parameters.sampleCount).toBeUndefined()
    // 提交无参考图 → instances 无 image 字段
    expect(submitBody.instances[0].image).toBeUndefined()
    // 轮询：用 operation name 作为路径
    expect(calls[1]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/publishers/google/operations/veo-op-123')
    expect(calls[2]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/publishers/google/operations/veo-op-123')
    // 下载：Google Files URI 仍需携带 API Key，否则会 403
    expect(calls[3]!.url).toBe('https://storage.googleapis.com/signed-veo-video.mp4')
    expect(calls[3]!.headers.get('x-goog-api-key')).toBe('google-key')
    expect(r.images[0]!.mediaType).toBe('video/mp4')
  })

  test('google-interactions（Veo Vertex JSON）：明确拒绝，Vertex 视频仅保留 Gemini Omni Flash', async () => {
    const { fetchFn, calls } = makeSequencedFetch([])

    await expect(generateMedia({
      modality: 'video',
      prompt: '一段干净的产品演示视频',
      apiKey: makeVertexAuthorizedUserCredential('runai-project', 'veo'),
      pollIntervalMs: 0,
      config: makeImageConfig({
        modality: 'video',
        protocol: 'google-interactions',
        baseUrl: 'https://aiplatform.googleapis.com',
        model: 'veo-3.1-generate-preview',
      }),
      fetchFn,
    })).rejects.toThrow('Vertex) 视频当前仅支持 gemini-omni-flash-preview')

    expect(calls).toHaveLength(0)
  })

  test('google-interactions 图生视频：参考图以 inlineData 内联到 instances', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-google-veo-i2v-'))
    const ref = join(cwd, 'start.png')
    writeFileSync(ref, Buffer.from('fake-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { name: 'publishers/google/operations/veo-i2v-456' } },
        { ok: true, json: { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://storage.googleapis.com/v.mp4' } }] } } } },
        { ok: true, headers: { 'content-type': 'video/mp4' } },
      ])
      await generateMedia({
        modality: 'video', prompt: '让画面动起来', apiKey: 'google-key', pollIntervalMs: 0,
        referencePaths: [ref], cwd,
        config: makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'veo-3.1-fast-generate-preview' }),
        fetchFn,
      })
      const submitBody = JSON.parse(calls[0]!.body!)
      expect(submitBody.instances[0].prompt).toBe('让画面动起来')
      // 参考图内联为 base64
      expect(submitBody.instances[0].image.inlineData.data).toMatch(/^[A-Za-z0-9+/]+=*$/)
      expect(submitBody.instances[0].image.inlineData.mimeType).toBe('image/png')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('google-interactions（Veo）：透传完整生成参数并从自然语言识别分辨率/时长', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { name: 'publishers/google/operations/veo-op-params' } },
      { ok: true, json: { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://storage.googleapis.com/v.mp4' } }] } } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video',
      prompt: 'A cinematic 4K 6 second video of a robot walking at sunset',
      apiKey: 'google-key',
      pollIntervalMs: 0,
      negativePrompt: 'low quality',
      promptEnhance: false,
      withAudio: true,
      seed: 123,
      personGeneration: 'allow_all',
      config: makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'veo-3.1-generate-preview' }),
      fetchFn,
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.parameters.aspectRatio).toBe('16:9')
    expect(body.parameters.numberOfVideos).toBeUndefined()
    // 4k 按官方限制强制 8 秒
    expect(body.parameters.durationSeconds).toBe(8)
    expect(body.parameters.resolution).toBe('4k')
    // Veo REST 文档当前没有 negativePrompt/enhancePrompt/generateAudio 字段，不透传以避免 400。
    expect(body.parameters.negativePrompt).toBeUndefined()
    expect(body.parameters.enhancePrompt).toBeUndefined()
    expect(body.parameters.generateAudio).toBeUndefined()
    expect(body.parameters.seed).toBe(123)
    expect(body.parameters.personGeneration).toBe('allow_all')
  })

  test('google-interactions（Veo）：按官方文档拒绝文生视频 personGeneration=allow_adult', async () => {
    await expect(generateMedia({
      modality: 'video',
      prompt: 'a cinematic video with people',
      apiKey: 'google-key',
      personGeneration: 'allow_adult',
      config: makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'veo-3.1-generate-preview' }),
      fetchFn: (async () => { throw new Error('不应发起请求') }) as unknown as typeof fetch,
    })).rejects.toThrow('文生视频/视频扩展 场景下 personGeneration 仅支持 allow_all')
  })

  test('google-interactions（Veo）：按官方文档拒绝图生视频 personGeneration=allow_all', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-google-veo-person-'))
    const ref = join(cwd, 'start.png')
    writeFileSync(ref, Buffer.from('fake-image'))
    try {
      await expect(generateMedia({
        modality: 'video',
        prompt: 'animate this person',
        apiKey: 'google-key',
        referencePaths: [ref],
        personGeneration: 'allow_all',
        cwd,
        config: makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'veo-3.1-fast-generate-preview' }),
        fetchFn: (async () => { throw new Error('不应发起请求') }) as unknown as typeof fetch,
      })).rejects.toThrow('图生视频/插帧/参考图 场景下 personGeneration 仅支持 allow_adult')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('google-interactions（Veo）：明确 1 条视频时使用官方 numberOfVideos 字段', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { name: 'publishers/google/operations/veo-op-count' } },
      { ok: true, json: { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://storage.googleapis.com/v.mp4' } }] } } } },
      { ok: true, headers: { 'content-type': 'video/mp4' } },
    ])
    await generateMedia({
      modality: 'video',
      prompt: 'two ocean clips',
      apiKey: 'google-key',
      pollIntervalMs: 0,
      numberOfImages: 1,
      config: makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'veo-3.1-generate-preview' }),
      fetchFn,
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.parameters.numberOfVideos).toBe(1)
    expect(body.parameters.sampleCount).toBeUndefined()
  })

  test('google-interactions（Veo）：拒绝一次生成多条视频', async () => {
    await expect(generateMedia({
      modality: 'video',
      prompt: 'two ocean clips',
      apiKey: 'google-key',
      pollIntervalMs: 0,
      numberOfImages: 2,
      config: makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'veo-3.1-generate-preview' }),
      fetchFn: (async () => { throw new Error('不应发起请求') }) as unknown as typeof fetch,
    })).rejects.toThrow('Veo 当前每次请求只支持生成 1 条视频')
  })

  test('google-interactions（Veo）：末帧插帧按官方字段发送 image + lastFrame', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-google-veo-last-frame-'))
    const first = join(cwd, 'first.png')
    const last = join(cwd, 'last.png')
    writeFileSync(first, Buffer.from('first-image'))
    writeFileSync(last, Buffer.from('last-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { name: 'publishers/google/operations/veo-op-last' } },
        { ok: true, json: { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://storage.googleapis.com/v.mp4' } }] } } } },
        { ok: true, headers: { 'content-type': 'video/mp4' } },
      ])
      await generateMedia({
        modality: 'video',
        prompt: 'transition from first frame to last frame',
        apiKey: 'google-key',
        pollIntervalMs: 0,
        referencePaths: [first],
        lastFramePath: last,
        cwd,
        config: makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'veo-3.1-fast-generate-preview' }),
        fetchFn,
      })
      const body = JSON.parse(calls[0]!.body!)
      const instance = body.instances[0]
      expect(instance.image.inlineData.data).toBe(Buffer.from('first-image').toString('base64'))
      expect(instance.lastFrame.inlineData.data).toBe(Buffer.from('last-image').toString('base64'))
      expect(instance.referenceImages).toBeUndefined()
      expect(instance.video).toBeUndefined()
      expect(body.parameters.durationSeconds).toBe(8)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('google-interactions（Veo）：参考图按官方字段发送 referenceImages', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-google-veo-reference-images-'))
    const ref = join(cwd, 'style.png')
    writeFileSync(ref, Buffer.from('style-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { name: 'publishers/google/operations/veo-op-ref' } },
        { ok: true, json: { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://storage.googleapis.com/v.mp4' } }] } } } },
        { ok: true, headers: { 'content-type': 'video/mp4' } },
      ])
      await generateMedia({
        modality: 'video', prompt: 'generate with this style reference', apiKey: 'google-key', pollIntervalMs: 0,
        referencePaths: [ref], referenceMode: 'reference', referenceType: 'style', cwd,
        config: makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'veo-3.1-fast-generate-preview' }),
        fetchFn,
      })
      const body = JSON.parse(calls[0]!.body!)
      const instance = body.instances[0]
      expect(instance.referenceImages[0].referenceType).toBe('style')
      expect(instance.referenceImages[0].image.inlineData.data).toBe(Buffer.from('style-image').toString('base64'))
      expect(instance.image).toBeUndefined()
      expect(instance.video).toBeUndefined()
      expect(body.parameters.durationSeconds).toBe(8)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('google-interactions（Veo）：视频扩展不能和参考图/末帧混用', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-google-veo-extension-mixed-'))
    const ref = join(cwd, 'style.png')
    const video = join(cwd, 'clip.mp4')
    writeFileSync(ref, Buffer.from('style-image'))
    writeFileSync(video, Buffer.from('fake-video'))
    try {
      await expect(generateMedia({
        modality: 'video', prompt: 'extend and restyle this clip', apiKey: 'google-key',
        referencePaths: [ref], videoPath: video, cwd,
        config: makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'veo-3.1-fast-generate-preview' }),
        fetchFn: (async () => { throw new Error('不应发起请求') }) as unknown as typeof fetch,
      })).rejects.toThrow('视频扩展使用 videoPath 时不能同时传 referenceImagePaths')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('google-interactions（Veo）：视频扩展拒绝 1080p/4k', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-google-veo-extension-resolution-'))
    const video = join(cwd, 'clip.mp4')
    writeFileSync(video, Buffer.from('fake-video'))
    try {
      await expect(generateMedia({
        modality: 'video',
        prompt: 'extend this clip',
        apiKey: 'google-key',
        videoPath: video,
        resolution: '1080p',
        cwd,
        config: makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'veo-3.1-fast-generate-preview' }),
        fetchFn: (async () => { throw new Error('不应发起请求') }) as unknown as typeof fetch,
      })).rejects.toThrow('Veo 视频扩展仅支持 720p')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('google-interactions（Veo Lite）：拒绝 4k 分辨率', async () => {
    await expect(generateMedia({
      modality: 'video',
      prompt: '4k ocean wave',
      apiKey: 'google-key',
      resolution: '4k',
      config: makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'veo-3.1-lite-generate-preview' }),
      fetchFn: (async () => { throw new Error('不应发起请求') }) as unknown as typeof fetch,
    })).rejects.toThrow('Veo 3.1 Lite 不支持 4k')
  })

  test('google-interactions 失败时（operation.error）抛错', async () => {
    const { fetchFn } = makeSequencedFetch([
      { ok: true, json: { name: 'publishers/google/operations/failed-op' } },
      { ok: true, json: { done: true, error: { code: 400, message: 'prompt violates safety policy' } } },
    ])
    await expect(generateMedia({
      modality: 'video', prompt: 'x', apiKey: 'google-key', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'veo-3.1-generate-preview' }),
      fetchFn,
    })).rejects.toThrow('Google 视频生成失败')
  })

  test('google-interactions（Gemini Omni）：走 /v1beta/interactions 并解析 output_video base64', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { id: 'interaction-1', output_video: { data: 'BASE64VIDEO', mime_type: 'video/mp4' } } },
    ])
    const r = await generateMedia({
      modality: 'video', prompt: 'a marble rolling on a chain reaction track', apiKey: 'google-key', sessionId: 'omni-test-1',
      config: makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-omni-flash-preview' }),
      fetchFn,
    })
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions?key=google-key')
    expect(calls[0]!.method).toBe('POST')
    const body = JSON.parse(calls[0]!.body!)
    expect(body.model).toBe('gemini-omni-flash-preview')
    expect(body.input).toBe('a marble rolling on a chain reaction track')
    expect(r.images[0]!.mediaType).toBe('video/mp4')
    expect(r.images[0]!.data).toBe('BASE64VIDEO')
  })

  test('google-interactions（Gemini Omni Vertex JSON）：走 Vertex interactions 并使用 OAuth', async () => {
    mockGoogleTokenExchange('vertex-omni-token')
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { id: 'vertex-interaction-1', output_video: { data: 'VERTEXBASE64VIDEO', mime_type: 'video/mp4' } } },
    ])

    const r = await generateMedia({
      modality: 'video',
      prompt: 'a product demo clip',
      apiKey: makeVertexAuthorizedUserCredential('runai-project', 'omni'),
      sessionId: 'vertex-omni-test-1',
      config: makeImageConfig({
        modality: 'video',
        protocol: 'google-interactions',
        baseUrl: 'https://aiplatform.googleapis.com',
        model: 'gemini-omni-flash-preview',
      }),
      fetchFn,
    })

    expect(calls[0]!.url).toBe('https://aiplatform.googleapis.com/v1beta/projects/runai-project/locations/global/interactions')
    expect(calls[0]!.headers.get('Authorization')).toBe('Bearer vertex-omni-token')
    expect(calls[0]!.headers.get('x-goog-api-key')).toBeNull()
    const body = JSON.parse(calls[0]!.body!)
    expect(body.model).toBe('gemini-omni-flash-preview')
    expect(body.input).toBe('a product demo clip')
    expect(r.images[0]!.mediaType).toBe('video/mp4')
    expect(r.images[0]!.data).toBe('VERTEXBASE64VIDEO')
  })

  test('google-interactions（Gemini Omni）：解析 steps content，并在下一轮带 previous_interaction_id 和参考图', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-google-omni-i2v-'))
    const ref = join(cwd, 'start.png')
    writeFileSync(ref, Buffer.from('fake-image'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { id: 'interaction-prev', steps: [{ content: [{ type: 'video', mime_type: 'video/mp4', data: 'FIRSTVIDEO' }] }] } },
        { ok: true, json: { id: 'interaction-next', steps: [{ content: [{ type: 'video', mime_type: 'video/mp4', data: 'NEXTVIDEO' }] }] } },
      ])
      const config = makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-omni-flash-preview' })
      await generateMedia({
        modality: 'video', prompt: 'create a playful flying pig video', apiKey: 'google-key', sessionId: 'omni-test-2',
        config,
        fetchFn,
      })
      const r = await generateMedia({
        modality: 'video', prompt: 'animate this as the first frame', apiKey: 'google-key', sessionId: 'omni-test-2',
        referencePaths: [ref], cwd,
        config,
        fetchFn,
      })
      const secondBody = JSON.parse(calls[1]!.body!)
      expect(secondBody.previous_interaction_id).toBe('interaction-prev')
      expect(secondBody.input[0].type).toBe('image')
      expect(secondBody.input[0].mime_type).toBe('image/png')
      expect(secondBody.input[0].data).toBe(Buffer.from('fake-image').toString('base64'))
      expect(secondBody.input[1]).toEqual({ type: 'text', text: 'animate this as the first frame' })
      expect(r.images[0]!.data).toBe('NEXTVIDEO')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('google-interactions（Gemini Omni）：响应 error 时抛错', async () => {
    const { fetchFn } = makeSequencedFetch([
      { ok: true, json: { error: { code: 400, message: 'bad prompt' } } },
    ])
    await expect(generateMedia({
      modality: 'video', prompt: 'x', apiKey: 'google-key', sessionId: 'omni-test-error',
      config: makeImageConfig({ modality: 'video', protocol: 'google-interactions', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-omni-flash-preview' }),
      fetchFn,
    })).rejects.toThrow('Google Omni 视频生成失败: bad prompt')
  })
})

// ===== 音频 =====

describe('media-generation-engine · 音频', () => {
  test('dashscope-sync（CosyVoice TTS）：同步返回 base64', async () => {
    const { fetchFn, calls } = makeSequencedFetch([{ ok: true, json: { output: { audio: { data: 'BASE64AUDIO' } } } }])
    const r = await generateMedia({
      modality: 'audio', prompt: '你好', apiKey: 'k', audioTask: 'tts',
      config: makeImageConfig({ modality: 'audio', protocol: 'dashscope-sync', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'cosyvoice-v2', audioTask: 'tts' }),
      fetchFn,
    })
    expect(calls[0]!.url).toContain('/services/audio/tts/text2audio')
    expect(r.images[0]!.mediaType).toBe('audio/mpeg')
    expect(r.images[0]!.data).toBe('BASE64AUDIO')
  })
  test('dashscope-sync（Qwen3-TTS）：路由至 multimodal-generation/generation 且支持 instruction', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { audio: { url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/qwen.wav' } } } },
      { ok: true, headers: { 'content-type': 'audio/wav' } },
    ])
    const r = await generateMedia({
      modality: 'audio', prompt: '你好', apiKey: 'k', audioTask: 'tts', instruction: '请用温柔且带有情感的语调表达。',
      config: makeImageConfig({ modality: 'audio', protocol: 'dashscope-sync', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen3-tts-instruct-flash', audioTask: 'tts' }),
      fetchFn,
    })
    expect(calls[0]!.url).toContain('/services/aigc/multimodal-generation/generation')
    const body = JSON.parse(calls[0]!.body!)
    expect(body.model).toBe('qwen3-tts-instruct-flash')
    expect(body.parameters.voice).toBe('Cherry')
    expect(body.parameters.instructions).toBe('请用温柔且带有情感的语调表达。')
    expect(body.parameters.optimize_instructions).toBe(true)
    expect(r.images[0]!.mediaType).toBe('audio/wav')
    expect(r.images[0]!.data).toBe('AA==')
  })

  test('dashscope-sync（Qwen3-TTS）：自然语言音色描述会映射为官方 voice id', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { output: { audio: { url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/qwen.wav' } } } },
      { ok: true, headers: { 'content-type': 'audio/wav' } },
    ])
    await generateMedia({
      modality: 'audio', prompt: '你好', apiKey: 'k', audioTask: 'tts', voice: '中文女声',
      config: makeImageConfig({ modality: 'audio', protocol: 'dashscope-sync', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen3-tts-flash', audioTask: 'tts' }),
      fetchFn,
    })
    expect(JSON.parse(calls[0]!.body!).parameters.voice).toBe('Cherry')

    const { fetchFn: fetchFn2, calls: calls2 } = makeSequencedFetch([
      { ok: true, json: { output: { audio: { url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/qwen.wav' } } } },
      { ok: true, headers: { 'content-type': 'audio/wav' } },
    ])
    await generateMedia({
      modality: 'audio', prompt: '你好', apiKey: 'k', audioTask: 'tts', voice: '浑厚男声',
      config: makeImageConfig({ modality: 'audio', protocol: 'dashscope-sync', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen3-tts-flash', audioTask: 'tts' }),
      fetchFn: fetchFn2,
    })
    expect(JSON.parse(calls2[0]!.body!).parameters.voice).toBe('Kai')

    const { fetchFn: fetchFn3, calls: calls3 } = makeSequencedFetch([
      { ok: true, json: { output: { audio: { url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/qwen.wav' } } } },
      { ok: true, headers: { 'content-type': 'audio/wav' } },
    ])
    await generateMedia({
      modality: 'audio', prompt: '你好', apiKey: 'k', audioTask: 'tts', voice: '成熟女声',
      config: makeImageConfig({ modality: 'audio', protocol: 'dashscope-sync', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen3-tts-flash', audioTask: 'tts' }),
      fetchFn: fetchFn3,
    })
    expect(JSON.parse(calls3[0]!.body!).parameters.voice).toBe('Katerina')

    const { fetchFn: fetchFn4, calls: calls4 } = makeSequencedFetch([
      { ok: true, json: { output: { audio: { url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/qwen.wav' } } } },
      { ok: true, headers: { 'content-type': 'audio/wav' } },
    ])
    await generateMedia({
      modality: 'audio', prompt: '你好', apiKey: 'k', audioTask: 'tts', voice: '温柔知性女声',
      config: makeImageConfig({ modality: 'audio', protocol: 'dashscope-sync', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen3-tts-flash', audioTask: 'tts' }),
      fetchFn: fetchFn4,
    })
    expect(JSON.parse(calls4[0]!.body!).parameters.voice).toBe('Serena')
  })

  test('zhipu-async（GLM-TTS）：/audio/speech 同步返回二进制音频', async () => {
    const { fetchFn, calls } = makeSequencedFetch([{ ok: true, headers: { 'content-type': 'audio/wav' } }])
    const r = await generateMedia({
      modality: 'audio', prompt: '你好', apiKey: 'k', audioTask: 'tts', speed: 1.2, volume: 1.1, audioFormat: 'wav',
      config: makeImageConfig({ modality: 'audio', protocol: 'zhipu-async', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-tts', audioTask: 'tts' }),
      fetchFn,
    })
    expect(calls[0]!.url).toBe('https://open.bigmodel.cn/api/paas/v4/audio/speech')
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      model: 'glm-tts',
      input: '你好',
      voice: 'tongtong',
      response_format: 'wav',
      stream: false,
      speed: 1.2,
      volume: 1.1,
    })
    expect(r.images[0]!.mediaType).toBe('audio/wav')
    expect(r.images[0]!.data).toBe('AA==')
  })

  test('zhipu-async（GLM-TTS-Clone）：先上传 voice-clone-input，再 voice/clone，再 audio/speech 合成', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-zhipu-clone-'))
    const ref = join(cwd, 'ref.wav')
    writeFileSync(ref, Buffer.from('fake-audio'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { id: 'file-in' } },
        { ok: true, json: { voice: 'voice-clone-1', file_id: 'file-preview' } },
        { ok: true, headers: { 'content-type': 'audio/wav' } },
      ])
      const r = await generateMedia({
        modality: 'audio', prompt: '克隆后读这句话', apiKey: 'k',
        referencePaths: [ref], cwd, voice: 'my_voice',
        config: makeImageConfig({ modality: 'audio', protocol: 'zhipu-async', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-tts-clone', audioTask: 'tts' }),
        fetchFn,
      })
      expect(calls[0]!.url).toBe('https://open.bigmodel.cn/api/paas/v4/files')
      expect(calls[0]!.rawBody).toBeInstanceOf(FormData)
      expect(calls[1]!.url).toBe('https://open.bigmodel.cn/api/paas/v4/voice/clone')
      expect(JSON.parse(calls[1]!.body!)).toEqual({
        model: 'glm-tts-clone',
        voice_name: 'my_voice',
        input: '克隆后读这句话',
        file_id: 'file-in',
      })
      expect(calls[2]!.url).toBe('https://open.bigmodel.cn/api/paas/v4/audio/speech')
      expect(JSON.parse(calls[2]!.body!).voice).toBe('voice-clone-1')
      expect(r.images[0]!.mediaType).toBe('audio/wav')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('minimax-voice-clone：先上传 files/upload，再 voice_clone 创建音色，再 t2a_v2 合成', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-minimax-clone-'))
    const ref = join(cwd, 'ref.wav')
    writeFileSync(ref, Buffer.from('fake-audio'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { file: { file_id: 888888 } } },
        { ok: true, json: { base_resp: { status_code: 0, status_msg: 'success' } } },
        { ok: true, json: { task_id: 123, file_id: 456, base_resp: { status_code: 0, status_msg: 'success' } } },
        { ok: true, json: { status: 'Success', file_id: 456 } },
        { ok: true, json: { base_resp: { status_code: 0 }, file: { download_url: 'https://example.com/audio.mp3' } } },
        { ok: true, headers: { 'content-type': 'audio/mpeg' } },
      ])
      const r = await generateMedia({
        modality: 'audio', prompt: '用我的声音说你好', apiKey: 'k', audioTask: 'clone', pollIntervalMs: 0,
        referencePaths: [ref], cwd,
        config: makeImageConfig({ modality: 'audio', protocol: 'minimax-voice-clone', baseUrl: 'https://api.minimax.chat/v1', model: 'speech-02-hd-clone', audioTask: 'clone' }),
        fetchFn,
      })
      expect(calls[0]!.url).toBe('https://api.minimax.chat/v1/files/upload')
      expect(calls[0]!.rawBody).toBeInstanceOf(FormData)
      expect(calls[1]!.url).toBe('https://api.minimax.chat/v1/voice_clone')
      const body1 = JSON.parse(calls[1]!.body!)
      expect(body1.file_id).toBe(888888)
      expect(body1.voice_id).toMatch(/^v[a-z0-9]+$/)
      expect(calls[2]!.url).toBe('https://api.minimax.chat/v1/t2a_async_v2')
      const body2 = JSON.parse(calls[2]!.body!)
      expect(body2.model).toBe('speech-02-hd')
      expect(body2.voice_setting.voice_id).toBe(body1.voice_id)
      expect(r.images[0]!.data).toBe('AA==')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('minimax 异步长文本 TTS：t2a_async_v2 创建 + query + files/retrieve 下载', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { task_id: 123, file_id: 456, base_resp: { status_code: 0, status_msg: 'success' } } },
      { ok: true, json: { status: 'Processing' } },
      { ok: true, json: { status: 'Success', file_id: 456 } },
      { ok: true, json: { file: { download_url: 'https://mm/audio.mp3' } } },
      { ok: true, headers: { 'content-type': 'audio/mpeg' } },
    ])
    const r = await generateMedia({
      modality: 'audio', prompt: '这是一段很长的文本', apiKey: 'k', audioTask: 'tts',
      speed: 1.1, volume: 1.2, pitch: 1, audioFormat: 'mp3', sampleRate: 32000, bitrate: 128000,
      pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax-tts-async', baseUrl: 'https://api.minimax.chat/v1', model: 'speech-2.8-hd', audioTask: 'tts' }),
      fetchFn,
    })
    expect(calls[0]!.url).toBe('https://api.minimax.chat/v1/t2a_async_v2')
    const submitBody = JSON.parse(calls[0]!.body!)
    expect(submitBody.model).toBe('speech-2.8-hd')
    expect(submitBody.text).toBe('这是一段很长的文本')
    expect(submitBody.language_boost).toBe('auto')
    expect(submitBody.voice_setting).toEqual({ voice_id: 'audiobook_male_1', speed: 1.1, vol: 1.2, pitch: 1 })
    expect(submitBody.audio_setting).toEqual({ audio_sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 2 })
    expect(calls[1]!.url).toBe('https://api.minimax.chat/v1/query/t2a_async_query_v2?task_id=123')
    expect(calls[2]!.url).toBe('https://api.minimax.chat/v1/query/t2a_async_query_v2?task_id=123')
    expect(calls[3]!.url).toBe('https://api.minimax.chat/v1/files/retrieve?file_id=456')
    expect(r.images[0]!.mediaType).toBe('audio/mpeg')
  })

  test('minimax 异步长文本 TTS：files/retrieve 返回 tar 时自动解出内部 mp3', async () => {
    const mp3 = Buffer.from('49443304000000000000fffb', 'hex')
    const tar = makeTarBuffer([
      { name: 'result/content.extra', data: Buffer.from('{}') },
      { name: 'result/content.titles', data: Buffer.from('title') },
      { name: 'result/content.mp3', data: mp3 },
    ])
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { task_id: 123, file_id: 456, base_resp: { status_code: 0, status_msg: 'success' } } },
      { ok: true, json: { status: 'Success', file_id: 456 } },
      { ok: true, json: { file: { download_url: 'https://mm/audio.tar' } } },
      { ok: true, headers: { 'content-type': 'application/x-tar' }, arrayBuffer: arrayBufferFromBuffer(tar) },
    ])
    const r = await generateMedia({
      modality: 'audio', prompt: '这是一段很长的文本', apiKey: 'k', audioTask: 'tts',
      audioFormat: 'mp3', pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax-tts-async', baseUrl: 'https://api.minimax.chat/v1', model: 'speech-2.8-hd', audioTask: 'tts' }),
      fetchFn,
    })
    expect(calls[3]!.url).toBe('https://mm/audio.tar')
    expect(r.images[0]!.mediaType).toBe('audio/mpeg')
    expect(r.images[0]!.data).toBe(mp3.toString('base64'))
  })

  test('minimax 异步 TTS：自然语言音色描述会映射为系统 voice_id', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { task_id: 123, file_id: 456, base_resp: { status_code: 0, status_msg: 'success' } } },
      { ok: true, json: { status: 'Success', file_id: 456 } },
      { ok: true, json: { file: { download_url: 'https://mm/audio.mp3' } } },
      { ok: true, headers: { 'content-type': 'audio/mpeg' } },
    ])
    await generateMedia({
      modality: 'audio', prompt: '这是一段文本', apiKey: 'k', audioTask: 'tts', voice: '中文女声',
      pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax-tts-async', baseUrl: 'https://api.minimax.chat/v1', model: 'speech-2.8-hd', audioTask: 'tts' }),
      fetchFn,
    })
    expect(JSON.parse(calls[0]!.body!).voice_setting.voice_id).toBe('female-tianmei')

    const { fetchFn: fetchFn2, calls: calls2 } = makeSequencedFetch([
      { ok: true, json: { task_id: 123, file_id: 456, base_resp: { status_code: 0, status_msg: 'success' } } },
      { ok: true, json: { status: 'Success', file_id: 456 } },
      { ok: true, json: { file: { download_url: 'https://mm/audio.mp3' } } },
      { ok: true, headers: { 'content-type': 'audio/mpeg' } },
    ])
    await generateMedia({
      modality: 'audio', prompt: '这是一段文本', apiKey: 'k', audioTask: 'tts', voice: '浑厚男声',
      pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax-tts-async', baseUrl: 'https://api.minimax.chat/v1', model: 'speech-2.8-hd', audioTask: 'tts' }),
      fetchFn: fetchFn2,
    })
    expect(JSON.parse(calls2[0]!.body!).voice_setting.voice_id).toBe('male-qn-jingying')

    const { fetchFn: fetchFn3, calls: calls3 } = makeSequencedFetch([
      { ok: true, json: { task_id: 123, file_id: 456, base_resp: { status_code: 0, status_msg: 'success' } } },
      { ok: true, json: { status: 'Success', file_id: 456 } },
      { ok: true, json: { file: { download_url: 'https://mm/audio.mp3' } } },
      { ok: true, headers: { 'content-type': 'audio/mpeg' } },
    ])
    await generateMedia({
      modality: 'audio', prompt: '这是一段文本', apiKey: 'k', audioTask: 'tts', voice: '成熟女声',
      pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax-tts-async', baseUrl: 'https://api.minimax.chat/v1', model: 'speech-2.8-hd', audioTask: 'tts' }),
      fetchFn: fetchFn3,
    })
    expect(JSON.parse(calls3[0]!.body!).voice_setting.voice_id).toBe('female-chengshu')

    const { fetchFn: fetchFn4, calls: calls4 } = makeSequencedFetch([
      { ok: true, json: { task_id: 123, file_id: 456, base_resp: { status_code: 0, status_msg: 'success' } } },
      { ok: true, json: { status: 'Success', file_id: 456 } },
      { ok: true, json: { file: { download_url: 'https://mm/audio.mp3' } } },
      { ok: true, headers: { 'content-type': 'audio/mpeg' } },
    ])
    await generateMedia({
      modality: 'audio', prompt: '这是一段文本', apiKey: 'k', audioTask: 'tts', voice: '温柔女声',
      pollIntervalMs: 0,
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax-tts-async', baseUrl: 'https://api.minimax.chat/v1', model: 'speech-2.8-hd', audioTask: 'tts' }),
      fetchFn: fetchFn4,
    })
    expect(JSON.parse(calls4[0]!.body!).voice_setting.voice_id).toBe('Chinese (Mandarin)_Soft_Girl')
  })

  test('minimax 同步 TTS：自然语言音色描述会映射且克隆 voice_id 原样保留', async () => {
    const { fetchFn, calls } = makeSequencedFetch([{ ok: true, json: { data: { audio: 'AAAA' } } }])
    await generateMedia({
      modality: 'audio', prompt: 'hello', apiKey: 'k', voice: '粤语女声',
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'speech-02-hd' }),
      fetchFn,
    })
    expect(JSON.parse(calls[0]!.body!).voice_setting.voice_id).toBe('Cantonese_GentleLady')

    const { fetchFn: fetchFn2, calls: calls2 } = makeSequencedFetch([{ ok: true, json: { data: { audio: 'AAAA' } } }])
    await generateMedia({
      modality: 'audio', prompt: 'hello', apiKey: 'k', voice: 'vabc123def',
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'speech-02-hd' }),
      fetchFn: fetchFn2,
    })
    expect(JSON.parse(calls2[0]!.body!).voice_setting.voice_id).toBe('vabc123def')

    const { fetchFn: fetchFn3, calls: calls3 } = makeSequencedFetch([{ ok: true, json: { data: { audio: 'AAAA' } } }])
    await generateMedia({
      modality: 'audio', prompt: 'hello', apiKey: 'k', voice: 'female-shaonv-jingpin',
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'speech-02-hd' }),
      fetchFn: fetchFn3,
    })
    expect(JSON.parse(calls3[0]!.body!).voice_setting.voice_id).toBe('female-shaonv-jingpin')
  })

  test('minimax 官方 TTS 预设 speech-02-hd 也走异步 t2a_async_v2', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { task_id: 123, file_id: 456, base_resp: { status_code: 0, status_msg: 'success' } } },
      { ok: true, json: { status: 'Success', file_id: 456 } },
      { ok: true, json: { file: { download_url: 'https://mm/audio.mp3' } } },
      { ok: true, headers: { 'content-type': 'audio/mpeg' } },
    ])
    const config = resolveMediaConfig({
      presetId: 'minimax-speech-02',
      model: 'speech-02-hd',
      protocol: 'minimax',
      baseUrl: 'https://api.minimax.chat/v1',
      apiKey: 'k',
    }, 'audio')
    expect(config?.preset?.id).toBe('minimax-speech-02')

    await generateMedia({
      modality: 'audio',
      prompt: 'hello',
      apiKey: 'k',
      config: config!,
      pollIntervalMs: 0,
      fetchFn,
    })

    expect(calls[0]!.url).toBe('https://api.minimax.chat/v1/t2a_async_v2')
    expect(JSON.parse(calls[0]!.body!).model).toBe('speech-02-hd')
  })

  test('minimax music：music-2.6 同步返回 hex 音频', async () => {
    const { fetchFn, calls } = makeSequencedFetch([
      { ok: true, json: { data: { audio: '49443304', status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } } },
    ])
    const r = await generateMedia({
      modality: 'audio', prompt: 'happy jazz', lyrics: '[verse]\nhello', apiKey: 'k', audioTask: 'music',
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'music-2.6', audioTask: 'music' }),
      fetchFn, sampleRate: 44100, bitrate: 256000,
    })
    expect(calls[0]!.url).toBe('https://api.minimax.chat/v1/music_generation')
    const body = JSON.parse(calls[0]!.body!)
    expect(body.model).toBe('music-2.6')
    expect(body.audio_setting).toEqual({ sample_rate: 44100, bitrate: 256000, format: 'mp3' })
    expect(body.lyrics).toBe('[verse]\nhello')
    expect(r.images[0]!.data).toBe('SUQzBA==')
    expect(r.images[0]!.mediaType).toBe('audio/mpeg')
  })

  test('minimax music：长耗时生成不复用调用方的短超时 signal', async () => {
    const callerController = new AbortController()
    callerController.abort()
    const signals: Array<AbortSignal | null | undefined> = []
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal)
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: { audio: '49443304', status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } }),
        text: async () => JSON.stringify({ data: { audio: '49443304', status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } }),
        arrayBuffer: async () => new ArrayBuffer(1),
      } as Response
    }) as unknown as typeof fetch

    const r = await generateMedia({
      modality: 'audio', prompt: 'slow music', apiKey: 'k', audioTask: 'music',
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'music-2.6', audioTask: 'music' }),
      fetchFn,
      signal: callerController.signal,
    })

    expect(signals.length).toBe(1)
    expect(signals[0]).toBeDefined()
    expect(signals[0]).not.toBe(callerController.signal)
    expect(signals[0]?.aborted).toBe(false)
    expect(r.images[0]!.data).toBe('SUQzBA==')
  })

  test('minimax music：audio_url 下载使用独立下载超时 signal', async () => {
    const callerController = new AbortController()
    callerController.abort()
    const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = []
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, signal: init?.signal })
      if (url.endsWith('/music_generation')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ data: { audio_url: 'https://cdn.example.com/song.mp3', status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } }),
          text: async () => JSON.stringify({ data: { audio_url: 'https://cdn.example.com/song.mp3', status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } }),
          arrayBuffer: async () => new ArrayBuffer(1),
        } as Response
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/mpeg' }),
        json: async () => ({}),
        text: async () => '',
        arrayBuffer: async () => arrayBufferFromBuffer(Buffer.from('mp3-data')),
      } as Response
    }) as unknown as typeof fetch

    const r = await generateMedia({
      modality: 'audio', prompt: 'slow music url', apiKey: 'k', audioTask: 'music',
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'music-2.6', audioTask: 'music' }),
      fetchFn,
      signal: callerController.signal,
    })

    expect(calls.map((c) => c.url)).toEqual(['https://api.minimax.chat/v1/music_generation', 'https://cdn.example.com/song.mp3'])
    expect(calls[0]!.signal).toBeDefined()
    expect(calls[1]!.signal).toBeDefined()
    expect(calls[0]!.signal).not.toBe(callerController.signal)
    expect(calls[1]!.signal).not.toBe(callerController.signal)
    expect(calls[1]!.signal).not.toBe(calls[0]!.signal)
    expect(r.images[0]!.mediaType).toBe('audio/mpeg')
    expect(r.images[0]!.data).toBe(Buffer.from('mp3-data').toString('base64'))
  })

  test('minimax music-cover：参考音频先做前处理再生成翻唱', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'run-media-cover-'))
    const ref = join(cwd, 'ref.mp3')
    writeFileSync(ref, Buffer.from('fake-audio'))
    try {
      const { fetchFn, calls } = makeSequencedFetch([
        { ok: true, json: { cover_feature_id: 'cover-1', formatted_lyrics: '[Verse]\nabc', base_resp: { status_code: 0, status_msg: 'success' } } },
        { ok: true, json: { data: { audio: '49443304', status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } } },
      ])
      const r = await generateMedia({
        modality: 'audio', prompt: '温暖民谣翻唱', apiKey: 'k', audioTask: 'music',
        referencePaths: [ref], cwd,
        config: makeImageConfig({ modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'music-cover', audioTask: 'music' }),
        fetchFn,
      })
      expect(calls[0]!.url).toBe('https://api.minimax.chat/v1/music_cover_preprocess')
      expect(calls[1]!.url).toBe('https://api.minimax.chat/v1/music_generation')
      const body = JSON.parse(calls[1]!.body!)
      expect(body.cover_feature_id).toBe('cover-1')
      expect(body.lyrics).toBe('[Verse]\nabc')
      expect(r.images[0]!.data).toBe('SUQzBA==')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('minimax-music 渠道下自选 music-cover 不被旧预设 id 错配回 music-2.6', () => {
    const cfg = resolveMediaConfig({
      presetId: 'minimax-music',
      model: 'music-cover',
      protocol: 'minimax',
      apiKey: 'k',
    }, 'audio')
    expect(cfg!.model).toBe('music-cover')
  })

  test('minimax TTS 透传 speed/volume/pitch/audioFormat', async () => {
    const { fetchFn, calls } = makeSequencedFetch([{ ok: true, json: { data: { audio: 'AAAA' } } }])
    const r = await generateMedia({
      modality: 'audio', prompt: 'hello', apiKey: 'k', speed: 1.2, volume: 1.1, pitch: -1, audioFormat: 'wav',
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'speech-02-hd' }),
      fetchFn,
    })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.voice_setting.speed).toBe(1.2)
    expect(body.voice_setting.vol).toBe(1.1)
    expect(body.voice_setting.pitch).toBe(-1)
    expect(body.audio_setting.format).toBe('wav')
    expect(r.images[0]!.mediaType).toBe('audio/wav')
  })

  test('minimax TTS：同步返回 audio', async () => {
    const { fetchFn } = makeSequencedFetch([{ ok: true, json: { data: { audio: 'MMAUDIO' } } }])
    const r = await generateMedia({
      modality: 'audio', prompt: '你好', apiKey: 'k',
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'speech-02-hd' }),
      fetchFn,
    })
    expect(r.images[0]!.data).toBe('MMAUDIO')
  })

  test('minimax TTS：data.audio 为十六进制音频时转为 base64', async () => {
    const { fetchFn } = makeSequencedFetch([{ ok: true, json: { data: { audio: '49443304' } } }])
    const r = await generateMedia({
      modality: 'audio', prompt: '你好', apiKey: 'k',
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'speech-02-hd' }),
      fetchFn,
    })
    expect(r.images[0]!.data).toBe('SUQzBA==')
  })

  test('minimax TTS：hex_data 转为 base64 后返回', async () => {
    const { fetchFn } = makeSequencedFetch([{ ok: true, json: { data: { hex_data: '6869' } } }])
    const r = await generateMedia({
      modality: 'audio', prompt: '你好', apiKey: 'k',
      config: makeImageConfig({ modality: 'audio', protocol: 'minimax', baseUrl: 'https://api.minimax.chat/v1', model: 'speech-02-hd' }),
      fetchFn,
    })
    expect(r.images[0]!.data).toBe('aGk=')
  })

  test('预设音频模型任务不匹配时不误调其它端点', async () => {
    const { fetchFn, calls } = makeSequencedFetch([])
    await expect(generateMedia({
      modality: 'audio', prompt: 'happy jazz', apiKey: 'k', audioTask: 'music',
      config: makeImageConfig({
        preset: MEDIA_MODEL_PRESETS.find((p) => p.id === 'minimax-speech-02') ?? null,
        modality: 'audio',
        protocol: 'minimax',
        baseUrl: 'https://api.minimax.chat/v1',
        model: 'speech-02-hd',
        audioTask: 'tts',
      }),
      fetchFn,
    })).rejects.toThrow(/不能执行 music/)
    expect(calls.length).toBe(0)
  })

  test('声音复刻需样本（无样本抛错）', async () => {
    const { fetchFn } = makeSequencedFetch([])
    await expect(generateMedia({
      modality: 'audio', prompt: '你好', apiKey: 'k', audioTask: 'clone',
      config: makeImageConfig({ modality: 'audio', protocol: 'dashscope-voice-clone', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'cosyvoice-v2', audioTask: 'clone' }),
      fetchFn,
    })).rejects.toThrow(/样本音频/)
  })
})

// ===== 火山语音 TTS 测试 =====

describe('media-generation-engine · volcengine-tts（豆包 Seed Audio / 火山语音）', () => {
  test('volcengine-tts：直接返回 base64 音频', async () => {
    const { fetchFn } = makeSequencedFetch([{ ok: true, json: { code: 3000, audio: 'SUQzBA==' } }])
    const r = await generateMedia({
      modality: 'audio', prompt: '你好世界', apiKey: 'volc-key',
      config: makeImageConfig({
        modality: 'audio', protocol: 'volcengine-tts',
        baseUrl: 'https://openspeech.bytedance.com', model: 'seed-audio-1.0',
      }),
      fetchFn,
    })
    expect(r.images[0]!.data).toBe('SUQzBA==')
    expect(r.images[0]!.mediaType).toBe('audio/mpeg')
  })

  test('volcengine-tts：通过 url 下载音频', async () => {
    // 需要提供一个有效的 arrayBuffer 响应
    const audioData = Buffer.from('fake-mp3-data').toString('base64')
    const { fetchFn } = makeSequencedFetch([
      { ok: true, json: { code: 3000, url: 'https://cdn.example.com/audio.mp3' } },
      { ok: true, headers: { 'content-type': 'audio/mpeg' }, arrayBuffer: Buffer.from('fake-mp3-data').buffer },
    ])
    const r = await generateMedia({
      modality: 'audio', prompt: '你好', apiKey: 'volc-key',
      config: makeImageConfig({
        modality: 'audio', protocol: 'volcengine-tts',
        baseUrl: 'https://openspeech.bytedance.com', model: 'seed-audio-1.0',
      }),
      fetchFn,
    })
    expect(r.images[0]!.data).toBe(audioData)
  })

  test('volcengine-tts：使用 speaker 参数', async () => {
    let lastBody: unknown = null
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/tts/create')) {
        lastBody = JSON.parse(init?.body as string)
        return { ok: true, status: 200, json: async () => ({ code: 3000, audio: 'SUQzBA==' }), text: async () => '{"code":3000,"audio":"SUQzBA=="}' } as Response
      }
      return { ok: true, json: async () => ({}), text: async () => '{}' } as Response
    }) as unknown as typeof fetch

    await generateMedia({
      modality: 'audio', prompt: '测试语音', apiKey: 'key', voice: 'zh_male_tao',
      config: makeImageConfig({
        modality: 'audio', protocol: 'volcengine-tts',
        baseUrl: 'https://openspeech.bytedance.com', model: 'seed-audio-1.0',
      }),
      fetchFn,
    })
    expect((lastBody as Record<string, unknown>).speaker).toBe('zh_male_tao')
  })

  test('volcengine-tts：错误码非 3000 抛错', async () => {
    const { fetchFn } = makeSequencedFetch([{ ok: true, json: { code: 4000, message: 'Invalid request' } }])
    await expect(generateMedia({
      modality: 'audio', prompt: '测试', apiKey: 'k',
      config: makeImageConfig({
        modality: 'audio', protocol: 'volcengine-tts',
        baseUrl: 'https://openspeech.bytedance.com', model: 'seed-audio-1.0',
      }),
      fetchFn,
    })).rejects.toThrow(/火山语音 TTS 错误.*4000/)
  })

  test('volcengine-tts：缺少 baseUrl 抛错', async () => {
    const { fetchFn } = makeSequencedFetch([])
    await expect(generateMedia({
      modality: 'audio', prompt: '测试', apiKey: 'k',
      config: makeImageConfig({
        modality: 'audio', protocol: 'volcengine-tts',
        baseUrl: '', model: 'seed-audio-1.0',
      }),
      fetchFn,
    })).rejects.toThrow(/缺少 baseUrl/)
  })
})

describe('media-generation-engine · volcengine-plan-tts（豆包 Seed TTS 2.0 Agent Plan）', () => {
  test('volcengine-plan-tts：成功解析 NDJSON 流式响应', async () => {
    // mock NDJSON 流式响应（每行一个 JSON）
    const ndjsonResponse = [
      '{"code":1000,"data":"SUQzB"}',
      '{"code":1000,"data":"AAAAAA=="}',
      '{"code":20000000,"message":"success"}',
    ].join('\n')
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain' }),
        json: async () => ({}),
        text: async () => ndjsonResponse,
      } as Response
    }) as unknown as typeof fetch

    const r = await generateMedia({
      modality: 'audio', prompt: '你好', apiKey: 'plan-key',
      config: makeImageConfig({
        modality: 'audio', protocol: 'volcengine-plan-tts',
        baseUrl: 'https://openspeech.bytedance.com', model: 'doubao-seed-tts-2.0',
      }),
      fetchFn,
    })
    expect(r.images[0]!.mediaType).toBe('audio/mpeg')
    expect(r.images[0]!.data).toBeTruthy()
  })

  test('volcengine-plan-tts：使用默认 speaker', async () => {
    let capturedBody: unknown = null
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      // volcengine-plan-tts 实际路径是 /api/v3/plan/tts/unidirectional
      if (url.includes('/plan/tts')) {
        capturedBody = JSON.parse(init?.body as string)
        return {
          ok: true, status: 200,
          json: async () => ({}),
          text: async () => '{"code":20000000,"data":"SUQzBA=="}',
        } as Response
      }
      return { ok: true, json: async () => ({}), text: async () => '{}' } as Response
    }) as unknown as typeof fetch

    await generateMedia({
      modality: 'audio', prompt: '测试', apiKey: 'k',
      config: makeImageConfig({
        modality: 'audio', protocol: 'volcengine-plan-tts',
        baseUrl: 'https://openspeech.bytedance.com', model: 'doubao-seed-tts-2.0',
      }),
      fetchFn,
    })
    // 默认 speaker 应该是 zh_female_gaolengyujie_uranus_bigtts
    expect(capturedBody).not.toBeNull()
    const reqParams = (capturedBody as Record<string, unknown>).req_params as Record<string, unknown>
    expect(reqParams.speaker).toBe('zh_female_gaolengyujie_uranus_bigtts')
  })
})

// ===== 多模态分派 =====

describe('media-generation-engine · 分派与缓存', () => {
  test('不支持的模态/协议组合抛错', async () => {
    await expect(generateMedia({
      modality: 'image', prompt: 'x', apiKey: 'k',
      config: makeImageConfig({ protocol: 'kling-async' as never }),
    })).rejects.toThrow(/图像不支持协议族/)
  })

  test('缓存按 modality + sessionId 隔离', () => {
    const sid = 'mm-test'
    try {
      expect(getLastGenerated('image', sid)).toBeUndefined()
      setLastGenerated('image', sid, '/a/1.png')
      setLastGenerated('video', sid, '/a/1.mp4')
      expect(getLastGenerated('image', sid)).toBe('/a/1.png')
      expect(getLastGenerated('video', sid)).toBe('/a/1.mp4')
      clearMediaGenerationSessionHistory(sid)
      expect(getLastGenerated('image', sid)).toBeUndefined()
      expect(getLastGenerated('video', sid)).toBeUndefined()
    } finally {
      clearMediaGenerationSessionHistory(sid)
    }
  })

  test('clearMediaGenerationSessionHistory 不影响其他 session', () => {
    try {
      setLastGenerated('image', 's1', '/x/1.png')
      setLastGenerated('image', 's2', '/y/2.png')
      clearMediaGenerationSessionHistory('s1')
      expect(getLastGenerated('image', 's1')).toBeUndefined()
      expect(getLastGenerated('image', 's2')).toBe('/y/2.png')
    } finally {
      clearMediaGenerationSessionHistory('s1')
      clearMediaGenerationSessionHistory('s2')
    }
  })
})
