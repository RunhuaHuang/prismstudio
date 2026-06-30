# 🎨 Duo-MCP

> 独立多模态生成 MCP Server —— 图像 / 视频 / 音频一键生成，兼容国内外主流模型，内嵌 WebUI 配置台。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Duo-MCP 是一个遵循 [Model Context Protocol](https://modelcontextprotocol.io) 的独立服务，让任意支持 MCP 的 AI agent（Claude Desktop、Cursor、Cline、Windsurf 等）都能直接调用**十几个主流多模态模型**生成图像、视频、音频，而无需自己对接各家 API。

它把"配置麻烦"这件事用**内嵌 WebUI** 解决了：一条命令打开浏览器，选模型、填 Key、试用、一键复制接入配置，体验和桌面应用一样简单。

---

## ✨ 特性

- **🏭 多模态全覆盖**：文生图、图生图/编辑、文生视频、图生视频、TTS 语音合成、音乐生成、声音克隆
- **🌐 国内外主流模型一站式接入**（13 个协议族，40+ 预置模型）：
  - 图像：OpenAI gpt-image、豆包 Seedream、智谱 GLM-Image/CogView、MiniMax、通义万相、Qwen-Image、Stability、腾讯混元、Midjourney
  - 视频：智谱 CogVideoX、豆包 Seedance、可灵 Kling、MiniMax、通义万相、Qwen HappyHorse、腾讯混元
  - 音频：CosyVoice、Qwen3-TTS、GLM-TTS、MiniMax speech/music、声音克隆
- **🔌 纯 stdio MCP**：兼容所有支持 MCP 的本地 agent
- **🖥️ 内嵌 WebUI**：配置、试用台、接入向导三合一，零配置门槛
- **⚙️ 动态工具暴露**：只有配置好的模态才会暴露给 agent，不产生空壳工具
- **🔒 本地优先**：凭证明文存在本地 `~/.duo-mcp/config.json`，WebUI 仅绑定 `127.0.0.1`，不上传任何数据

---

## 🚀 快速开始

### 1. 启动 WebUI 完成配置（推荐首次使用）

```bash
npx duo-mcp --webui
```

浏览器会自动打开 `http://127.0.0.1:17899`，在页面里：

1. **配置**：为想用的模态（图片/视频/音频）选择预设模型、填写 API Key，点保存
2. **试用台**：直接生成一张图 / 一段 TTS 验证配置是否生效
3. **接入向导**：选择你的 agent，一键复制 `mcpServers` 配置 JSON

### 2. 接入到你的 agent

以 Claude Desktop 为例，编辑配置文件（macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "duo-mcp": {
      "command": "npx",
      "args": ["-y", "duo-mcp"]
    }
  }
}
```

重启 Claude Desktop 后，就能在对话中让 Claude 生成图片、视频、音频了。

<details>
<summary><b>其他 agent 配置</b></summary>

**Cursor**（`~/.cursor/mcp.json`）：
```json
{
  "mcpServers": {
    "duo-mcp": { "command": "npx", "args": ["-y", "duo-mcp"] }
  }
}
```

**Cline / Windsurf / VS Code**：同上结构，写入对应 MCP 配置位置。

**通用 stdio**：直接运行 `npx -y duo-mcp`，通过标准输入输出交互。

</details>

---

## 📖 命令参考

```bash
duo-mcp                       # 以 stdio MCP 模式运行（默认，供 agent 调用）
duo-mcp --webui               # 启动本地 WebUI 配置台（浏览器打开 127.0.0.1:<port>）
duo-mcp --webui --port 8080   # 指定 WebUI 端口（默认 17899）
duo-mcp --output-dir <path>   # 覆盖生成物输出目录
duo-mcp --help                # 显示帮助
```

**环境变量：**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DUO_MCP_CONFIG` | `~/.duo-mcp/config.json` | 指定配置文件路径（便于多套配置切换） |

---

## 🛠️ 提供的 MCP 工具

只有已配置好的模态才会暴露对应工具：

| 工具 | 模态 | 能力 |
|---|---|---|
| `generate_image` | 图片 | 文生图、参考图编辑、多轮迭代优化 |
| `generate_video` | 视频 | 文生视频（异步，1-5 分钟）、图生视频 |
| `generate_audio` | 音频 | TTS 语音、音乐生成、声音克隆 |

每个工具支持丰富的厂商专属参数（如 OpenAI 的 quality/background、Stability 的 stylePreset、视频的 withAudio/frames 等），详见各工具的 `inputSchema`。

生成产物会保存到 `<输出目录>/generated-media/`，图片/音频同时以 base64 内联回传给 agent 便于直接预览，视频体积大仅返回本地路径。

---

## 🔧 配置文件说明

配置文件位于 `~/.duo-mcp/config.json`（可用 `DUO_MCP_CONFIG` 覆盖）：

```jsonc
{
  "image": {
    "enabled": true,
    "presetId": "openai-gpt-image",   // 预设 ID，或 "custom" 手动指定
    "apiKey": "sk-...",                // 明文存储
    "model": "...",                    // 可选，覆盖预设模型（仅 custom 必填）
    "protocol": "openai-images",       // 可选，仅 custom 时有意义
    "baseUrl": "..."                   // 可选，覆盖预设 endpoint
  },
  "video": { /* ... */ },
  "audio": { /* ... */ },
  "outputDir": "/path/to/out"          // 可选，生成物输出目录
}
```

> **安全说明**：凭证以明文存储（与 MCP 生态惯例一致）。WebUI 仅绑定 `127.0.0.1`，不会暴露到局域网。生产环境请自行做好文件权限管控。

---

## 💻 本地开发

```bash
# 依赖
bun install

# 开发（直接跑 TS）
bun run dev              # stdio 模式
bun run dev:webui        # WebUI 模式

# 类型检查 & 构建
bun run typecheck
bun run build            # 产物输出到 dist/

# 测试 stdio 握手
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | bun run dev
```

---

## 📐 架构

```
┌──────────────────────────────────────────────────┐
│  duo-mcp（一个进程、一条命令）                     │
│                                                   │
│  ┌────────────────────────────────────────────┐  │
│  │  引擎内核（13 协议族，40+ 模型）             │  │
│  │  generateMedia() 统一入口                    │  │
│  └────────────────────────────────────────────┘  │
│            ▲                       ▲              │
│            │                       │              │
│   ┌────────┴───────┐      ┌────────┴─────────┐    │
│   │ stdio MCP 传输  │      │ 内嵌 HTTP WebUI  │    │
│   │ (给 agent 用)   │      │ (给人配置/试用)  │    │
│   └────────┬───────┘      └────────┬─────────┘    │
│            └───────┬────────────────┘             │
│         共享 ~/.duo-mcp/config.json               │
└───────────────────────────────────────────────────┘
```

| 模块 | 职责 |
|---|---|
| `src/engine/media-generation-engine.ts` | 生成内核，按「模态 × 协议族」分派，裸 fetch 调用各 provider |
| `src/config.ts` | 配置读写，把结构化配置转成引擎所需的 flat credentials |
| `src/persist.ts` | 生成产物落盘 + 构造 MCP content 块（纯 node:fs） |
| `src/mcp-server.ts` | 底层 Server + JSON Schema 注册工具，串联引擎/配置/落盘 |
| `src/index.ts` | CLI 入口，分流 stdio / --webui 两种模式 |
| `src/webui/server.ts` | HTTP server + REST API（仅 127.0.0.1） |
| `src/webui/index-html.ts` | Alpine.js 单文件页面（配置/试用台/接入向导） |

---

## 🤝 致谢

本项目受 [RunAI](https://github.com/) 多模态生成能力的启发，引擎层在此基础上去耦合独立化。

## 📄 License

[MIT](LICENSE)
