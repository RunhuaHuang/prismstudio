/**
 * WebUI 单文件页面（Alpine.js + Tailwind CDN，零构建）
 *
 * 三大区块：
 * 1. 配置：image / video / audio 三模态，各选 preset + 填 apiKey（可临时测试连通）
 * 2. 试用台（Playground）：选模态 + prompt + 参数 → 生成 → 内联预览图片/音频、路径展示视频
 * 3. 接入向导：选目标 agent → 一键复制 mcpServers JSON
 *
 * 所有交互通过 fetch 调用 /api/* REST 端点。
 */

export const WEBUI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Duo-MCP · 多模态生成配置台</title>
<script src="https://cdn.tailwindcss.com"></script>
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
  .tab-active { background: #4f46e5; color: white; }
</style>
</head>
<body class="bg-slate-50 text-slate-800 min-h-screen">
<div x-data="duoApp()" x-init="init()" class="max-w-5xl mx-auto px-4 py-8">

  <!-- 标题 -->
  <header class="mb-8">
    <h1 class="text-3xl font-bold text-slate-900">🎨 Duo-MCP</h1>
    <p class="text-slate-500 mt-1">独立多模态生成 MCP · 图像 / 视频 / 音频一键生成 · <a href="https://github.com" target="_blank" class="text-indigo-600 hover:underline">GitHub</a></p>
    <div class="mt-3 text-sm text-slate-400">
      配置文件：<code x-text="status.configPath || '~/.duo-mcp/config.json'" class="bg-slate-200 px-1.5 py-0.5 rounded"></code>
      <span x-show="status.outputDir"> · 输出目录：<code x-text="status.outputDir" class="bg-slate-200 px-1.5 py-0.5 rounded"></code></span>
    </div>
  </header>

  <!-- Tab 切换 -->
  <nav class="flex gap-2 mb-6">
    <button @click="tab='config'" :class="tab==='config' ? 'tab-active' : 'bg-white border'" class="px-4 py-2 rounded-lg text-sm font-medium transition">⚙️ 配置</button>
    <button @click="tab='playground'" :class="tab==='playground' ? 'tab-active' : 'bg-white border'" class="px-4 py-2 rounded-lg text-sm font-medium transition">🧪 试用台</button>
    <button @click="tab='connect'" :class="tab==='connect' ? 'tab-active' : 'bg-white border'" class="px-4 py-2 rounded-lg text-sm font-medium transition">🔌 接入向导</button>
  </nav>

  <!-- ============ 配置页 ============ -->
  <section x-show="tab==='config'" class="space-y-6">
    <template x-for="m in modalities" :key="m.key">
      <div class="bg-white rounded-xl shadow-sm border p-5">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-semibold flex items-center gap-2">
            <span x-text="m.icon"></span> <span x-text="m.label"></span>生成
            <span x-show="config[m.key]?.enabled && config[m.key]?.apiKey" class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">已就绪</span>
          </h2>
          <label class="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" x-model="config[m.key].enabled" class="w-4 h-4" />
            启用
          </label>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">预设模型</label>
            <select x-model="config[m.key].presetId" @change="onPresetChange(m.key)" class="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="custom">自定义（手动填 model/protocol/baseUrl）</option>
              <template x-for="p in (presets[m.key] || [])" :key="p.id">
                <option :value="p.id" x-text="p.label + ' · ' + p.vendor + ' · ' + p.model"></option>
              </template>
            </select>
            <p class="text-xs text-slate-400 mt-1" x-show="presetHelp(m.key)" x-text="presetHelp(m.key)"></p>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">API Key</label>
            <input type="password" x-model="config[m.key].apiKey" :placeholder="config[m.key]?.apiKey?.includes('****') ? '已保存（重新输入可覆盖）' : '输入 API Key'" class="w-full border rounded-lg px-3 py-2 text-sm font-mono" />
          </div>
          <div x-show="config[m.key].presetId === 'custom'">
            <label class="block text-xs font-medium text-slate-500 mb-1">模型名 (model)</label>
            <input type="text" x-model="config[m.key].model" class="w-full border rounded-lg px-3 py-2 text-sm font-mono" />
          </div>
          <div x-show="config[m.key].presetId === 'custom'">
            <label class="block text-xs font-medium text-slate-500 mb-1">协议 (protocol)</label>
            <input type="text" x-model="config[m.key].protocol" placeholder="如 openai-images / dashscope-sync" class="w-full border rounded-lg px-3 py-2 text-sm font-mono" />
          </div>
          <div x-show="config[m.key].presetId === 'custom'" class="md:col-span-2">
            <label class="block text-xs font-medium text-slate-500 mb-1">Base URL（可选，预设自带则留空）</label>
            <input type="text" x-model="config[m.key].baseUrl" class="w-full border rounded-lg px-3 py-2 text-sm font-mono" />
          </div>
        </div>
      </div>
    </template>

    <!-- 输出目录 -->
    <div class="bg-white rounded-xl shadow-sm border p-5">
      <label class="block text-xs font-medium text-slate-500 mb-1">生成物输出目录（可选，留空则用默认 ~/.duo-mcp/generated-media）</label>
      <input type="text" x-model="config.outputDir" placeholder="如 /Users/you/media-out" class="w-full border rounded-lg px-3 py-2 text-sm font-mono" />
    </div>

    <div class="flex items-center gap-3">
      <button @click="saveConfig()" :disabled="saving" class="bg-indigo-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
        <span x-show="!saving">💾 保存配置</span>
        <span x-show="saving">保存中…</span>
      </button>
      <span x-show="saveMsg" :class="saveErr ? 'text-red-600' : 'text-green-600'" class="text-sm" x-text="saveMsg"></span>
    </div>
  </section>

  <!-- ============ 试用台 ============ -->
  <section x-show="tab==='playground'" class="bg-white rounded-xl shadow-sm border p-5">
    <h2 class="text-lg font-semibold mb-4">🧪 试用台</h2>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div class="space-y-3">
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">模态</label>
          <select x-model="test.modality" class="w-full border rounded-lg px-3 py-2 text-sm">
            <option value="image">🖼️ 图片</option>
            <option value="video">🎬 视频</option>
            <option value="audio">🔊 音频</option>
          </select>
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Prompt <span x-show="test.modality==='audio'">/ 文本</span></label>
          <textarea x-model="test.prompt" rows="4" placeholder="描述你要生成的内容…" class="w-full border rounded-lg px-3 py-2 text-sm"></textarea>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div x-show="test.modality==='image'">
            <label class="block text-xs font-medium text-slate-500 mb-1">数量</label>
            <input type="number" min="1" max="4" x-model.number="test.numberOfImages" class="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div x-show="test.modality==='image'">
            <label class="block text-xs font-medium text-slate-500 mb-1">尺寸</label>
            <input type="text" x-model="test.size" placeholder="1024x1024" class="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div x-show="test.modality==='video'">
            <label class="block text-xs font-medium text-slate-500 mb-1">时长(秒)</label>
            <input type="number" min="1" max="60" x-model.number="test.duration" class="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div x-show="test.modality==='audio'">
            <label class="block text-xs font-medium text-slate-500 mb-1">任务</label>
            <select x-model="test.task" class="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="tts">语音合成 (tts)</option>
              <option value="music">音乐 (music)</option>
              <option value="clone">声音克隆 (clone)</option>
            </select>
          </div>
          <div x-show="test.modality==='audio' && test.task==='tts'">
            <label class="block text-xs font-medium text-slate-500 mb-1">音色 voice</label>
            <input type="text" x-model="test.voice" placeholder="如 Cherry / male-qn-qingse" class="w-full border rounded-lg px-3 py-2 text-sm font-mono" />
          </div>
        </div>
        <div class="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800" x-show="test.modality && !isReady(test.modality)">
          ⚠️ 该模态尚未在配置页启用/填 Key，生成会失败。请先到「配置」页设置，或在下方临时填 Key 试用。
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">临时 API Key（可选，不保存到配置）</label>
          <input type="password" x-model="test.tempKey" placeholder="留空则用配置页保存的 Key" class="w-full border rounded-lg px-3 py-2 text-sm font-mono" />
        </div>
        <button @click="runTest()" :disabled="testing" class="bg-indigo-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
          <span x-show="!testing">✨ 生成</span>
          <span x-show="testing">生成中…（视频可能需 1-5 分钟）</span>
        </button>
        <p x-show="testError" class="text-red-600 text-sm" x-text="testError"></p>
      </div>

      <!-- 结果区 -->
      <div class="bg-slate-50 rounded-lg p-4 min-h-[200px]">
        <template x-if="!testResult && !testing">
          <div class="text-slate-400 text-sm text-center pt-8">生成结果会显示在这里</div>
        </template>
        <template x-if="testResult">
          <div class="space-y-3">
            <template x-for="(item, i) in testResult.items" :key="i">
              <div class="border rounded-lg p-2 bg-white">
                <template x-if="item.mediaType.startsWith('image/')">
                  <img :src="item.dataUri" class="max-w-full rounded mx-auto" />
                </template>
                <template x-if="item.mediaType.startsWith('audio/')">
                  <audio :src="item.dataUri" controls class="w-full"></audio>
                </template>
                <template x-if="item.mediaType.startsWith('video/')">
                  <div class="text-sm text-slate-600 break-all">📹 视频已保存：<code x-text="item.localPath"></code></div>
                </template>
                <p class="text-xs text-slate-400 mt-1" x-text="item.mediaType"></p>
              </div>
            </template>
            <p class="text-sm text-slate-600 whitespace-pre-line" x-text="testResult.text"></p>
          </div>
        </template>
      </div>
    </div>
  </section>

  <!-- ============ 接入向导 ============ -->
  <section x-show="tab==='connect'" class="bg-white rounded-xl shadow-sm border p-5">
    <h2 class="text-lg font-semibold mb-4">🔌 接入向导</h2>
    <p class="text-sm text-slate-500 mb-4">先在「配置」页完成 API Key 设置并保存，然后选择你的 agent，复制下方 JSON 粘贴到对应配置文件。</p>
    <div class="space-y-4">
      <div>
        <label class="block text-xs font-medium text-slate-500 mb-1">选择 Agent</label>
        <select x-model="exportAgent" @change="loadExport()" class="border rounded-lg px-3 py-2 text-sm">
          <option value="claude">Claude Desktop</option>
          <option value="cursor">Cursor</option>
          <option value="cline">Cline (VS Code)</option>
          <option value="windsurf">Windsurf</option>
          <option value="generic">通用 stdio</option>
        </select>
      </div>
      <p x-show="exportData?.note" class="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3" x-text="exportData?.note"></p>
      <div>
        <div class="flex items-center justify-between mb-1">
          <label class="text-xs font-medium text-slate-500">配置内容</label>
          <button @click="copyExport()" class="text-xs text-indigo-600 hover:underline" x-text="copied ? '✓ 已复制' : '📋 复制'"></button>
        </div>
        <pre class="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs overflow-x-auto" x-text="exportText"></pre>
      </div>
    </div>
  </section>

  <footer class="mt-12 text-center text-xs text-slate-400">
    Duo-MCP · MIT License · 基于多协议多模态生成引擎
  </footer>
</div>

<script>
function duoApp() {
  return {
    tab: 'config',
    modalities: [
      { key: 'image', label: '图片', icon: '🖼️' },
      { key: 'video', label: '视频', icon: '🎬' },
      { key: 'audio', label: '音频', icon: '🔊' },
    ],
    config: { image: {enabled:false,presetId:'custom',apiKey:''}, video: {enabled:false,presetId:'custom',apiKey:''}, audio: {enabled:false,presetId:'custom',apiKey:''}, outputDir: '' },
    presets: { image: [], video: [], audio: [] },
    status: {},
    saving: false, saveMsg: '', saveErr: false,

    test: { modality: 'image', prompt: '', size: '', numberOfImages: 1, duration: 5, task: 'tts', voice: '', tempKey: '' },
    testing: false, testResult: null, testError: '',

    exportAgent: 'claude', exportData: null, exportText: '', copied: false,

    async init() {
      await Promise.all([this.loadConfig(), this.loadPresets(), this.loadStatus()]);
      this.loadExport();
    },
    async loadConfig() {
      const r = await fetch('/api/config'); this.config = await r.json();
      for (const k of ['image','video','audio']) {
        if (!this.config[k]) this.config[k] = {enabled:false, presetId:'custom', apiKey:''};
      }
    },
    async loadPresets() {
      const r = await fetch('/api/presets'); this.presets = await r.json();
    },
    async loadStatus() {
      const r = await fetch('/api/status'); this.status = await r.json();
    },
    async saveConfig() {
      this.saving = true; this.saveMsg = ''; this.saveErr = false;
      try {
        const r = await fetch('/api/config', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(this.config) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || '保存失败');
        this.config = data.config; this.saveMsg = '✓ 已保存';
        await this.loadStatus();
      } catch (e) { this.saveErr = true; this.saveMsg = '✗ ' + e.message; }
      finally { this.saving = false; setTimeout(() => this.saveMsg = '', 3000); }
    },
    onPresetChange(key) {
      const presetId = this.config[key].presetId;
      if (presetId === 'custom') return;
      const p = (this.presets[key] || []).find(x => x.id === presetId);
      if (p) { this.config[key].model = p.model; this.config[key].protocol = p.protocol; }
    },
    presetHelp(key) {
      const p = (this.presets[key] || []).find(x => x.id === this.config[key]?.presetId);
      return p ? (p.vendor + ' · ' + p.protocol + (p.helpUrl ? ' · ' + p.helpUrl : '')) : '';
    },
    isReady(modality) { return this.status.modalities && this.status.modalities[modality]; },
    async runTest() {
      this.testing = true; this.testResult = null; this.testError = '';
      try {
        const body = { modality: this.test.modality, prompt: this.test.prompt, apiKey: this.test.tempKey || undefined, size: this.test.size || undefined, numberOfImages: this.test.numberOfImages, duration: this.test.duration, task: this.test.task, voice: this.test.voice || undefined };
        const r = await fetch('/api/test', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || '生成失败');
        this.testResult = data;
      } catch (e) { this.testError = e.message; }
      finally { this.testing = false; }
    },
    async loadExport() {
      const r = await fetch('/api/export?agent=' + this.exportAgent);
      this.exportData = await r.json();
      this.exportText = JSON.stringify(this.exportData.config, null, 2);
    },
    async copyExport() {
      try { await navigator.clipboard.writeText(this.exportText); this.copied = true; setTimeout(() => this.copied = false, 2000); }
      catch (e) { /* fallback */ const ta = document.createElement('textarea'); ta.value = this.exportText; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); this.copied = true; setTimeout(() => this.copied = false, 2000); }
    },
  };
}
</script>
</body>
</html>`
