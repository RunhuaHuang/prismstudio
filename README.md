<div align="center">

# Prismstudio

**独立多模态生成 MCP Server** —— 一条命令，让任意 AI agent 生成图像 / 视频 / 音频

`图像 · 视频 · 音频` · `82 个预置模型` · `18 种协议` · `16 家厂商` · `内嵌 WebUI`

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node Version](https://img.shields.io/badge/node-%E2%89%A520-green.svg)](package.json)
[![npm version](https://img.shields.io/npm/v/prismstudio.svg)](https://www.npmjs.com/package/prismstudio)
[![CI](https://github.com/RunhuaHuang/prismstudio/actions/workflows/ci.yml/badge.svg)](https://github.com/RunhuaHuang/prismstudio/actions/workflows/ci.yml)

**简体中文** ｜ [English](README.en.md)

</div>

<p align="center">
  <img src="figures/webui-overview.png" alt="Prismstudio WebUI 控制台总览" width="100%">
</p>

---

Prismstudio 是一个遵循 [Model Context Protocol](https://modelcontextprotocol.io) 的独立服务，让任意支持 MCP 的 AI agent（Claude Desktop、Cursor、Cline、Windsurf、VS Code 等）都能直接调用**几十个主流多模态模型**生成图像、视频、音频，而无需自己对接各家 API。

它把"配置麻烦"这件事用**内嵌 WebUI** 解决了：一条命令打开浏览器，选模型、填 Key、试用、一键复制接入配置，体验和桌面应用一样简单。

## 核心卖点

<table>
<tr>
<td width="50%" valign="top">

### 市面上主流模型，几乎全覆盖

**82 个预置模型 · 16 家厂商**，国内外一次接齐：

**🖼️ 图像** · OpenAI gpt-image · Google Gemini(nano-banana)/Vertex · 豆包 Seedream · 智谱 GLM-Image/CogView · 通义 Qwen-Image · 万相 · Stability · 腾讯混元 · MiniMax · Midjourney

**🎬 视频** · Google Veo 3.1 · 智谱 CogVideoX · 豆包 Seedance · 可灵 Kling · MiniMax · 万相 wan2.7 · Qwen HappyHorse · 腾讯混元

**🔊 音频** · CosyVoice · Qwen3-TTS · 智谱 GLM-TTS · MiniMax speech/music · 声音克隆

新模型？加一条预设即可，引擎自动分派 18 种协议族。

</td>
<td width="50%" valign="top">

### 一个 MCP，适配任意 agent

遵循开放 MCP 标准，**凡是支持 MCP 的本地 agent 都能直接接入**：

- **Claude Desktop**
- **Cursor**
- **Cline**
- **Windsurf**
- **VS Code (Copilot Chat)**
- … 以及任何 stdio MCP 客户端

接入零代码：WebUI 向导一键复制 `mcpServers` JSON，粘进 agent 配置即可。**写一次配置，所有 agent 共用。**

</td>
</tr>
</table>

### 还有这些

- **多模态全覆盖**：文生图、图生图/编辑、文生视频、图生视频、TTS 语音合成、音乐生成、声音克隆
- **内嵌 WebUI**：配置台、试用台、接入向导三合一，零配置门槛，不用手写 JSON；API Key 眼睛切换、完整请求地址与接口协议一目了然
- **动态工具暴露**：只有配置好的模态才会暴露给 agent，不产生空壳工具
- **本地运行策略**：可限制单次数量、视频时长、4K 与内联体积，在付费请求发出前拦截
- **安全素材白名单**：输出目录默认可读，额外参考素材目录需显式加入允许列表
- **可选环境变量密钥**：配置文件只保存变量名，不必保存真实 API Key
- **本地优先**：凭证明文存在本地 `~/.prismstudio/config.json`，WebUI 仅绑定 `127.0.0.1`；软件不发送遥测，但 prompt、参考素材和生成请求会按用户配置直接发送给对应 provider

---

## 能力总览

Prismstudio 把「模态 × 厂商」封装成 18 种协议族，引擎内核按配置自动分派到对应 provider。当前共 **82 个预置模型**：

### 图像生成（41 个模型 / 文生图 · 图生图 · 编辑）

| 厂商 | 模型 | 能力 |
|---|---|---|
| OpenAI | gpt-image-1 / 2 | 文生图、参考图编辑、透明背景 |
| Google Gemini | flash / flash-lite / pro（nano-banana） | 文生图、多轮编辑、宽高比与分辨率 |
| Google Vertex | flash / flash-lite / pro | Gemini 同款，走 Vertex AI 配额 |
| 豆包 | Seedream（含 3.0 / 4 / 4.5 / 5 / 5-Lite / 5-Pro） | 高质量国产图像；另有 Agent Plan 接入（独立鉴权） |
| 智谱 | GLM-Image、CogView-4 | 国产开源生态 |
| MiniMax | image-01 | 单图生成 |
| 通义万相 | Qwen-Image、Plus / Max / 2-Pro | 阿里云图像 |
| 万相 | wanx2.1-turbo / plus、wan2.7-image / image-pro | 2.7-Pro 支持 4K、多图参考、文字渲染 |
| Stability | SDXL / SD3 / Ultra | 经典 Stable Diffusion |
| 腾讯 | 混元 image v3 / lite | 腾讯云图像 |
| Midjourney | midjourney | 风格化生成 |

### 视频生成（25 个模型 / 文生视频 · 图生视频 · 异步）

| 厂商 | 模型 | 能力 |
|---|---|---|
| 智谱 | CogVideoX 2 / 3 / Flash | 国产开源视频 |
| 豆包 | Seedance（含 1.0-pro / 1.5-pro / 2 / 2-fast / 2-mini） | 字节视频；另有 Agent Plan 接入（独立鉴权） |
| 可灵 | Kling v2 | 高质量国产视频 |
| MiniMax | video-01、Hailuo-2.3 / 2.3-Fast、**H3**（旗舰） | H3 支持 2K / 15s / 原生立体声 |
| 万相 | wan2.7-t2v、wan2.7-videoedit | 文生视频、视频编辑 |
| 通义 | Qwen HappyHorse | 文/图/参考生视频 |
| 腾讯 | 混元 video v1.5 | 腾讯云视频 |
| Google Gemini | Veo 3.1 / 3.1-fast / 3.1-lite、Omni-flash | 国际顶级视频，支持音频 |
| Google Vertex | Omni-flash | Vertex 配额 |

### 音频生成（16 个模型 / TTS · 音乐 · 声音克隆）

| 厂商 | 模型 | 能力 |
|---|---|---|
| 智谱 | GLM-TTS、GLM-TTS-Clone | 语音合成、声音克隆 |
| 阿里 | CosyVoice | 通义语音合成 |
| 通义 | Qwen3-TTS（Flash / Instruct / 多方言） | 30+ 内置音色、方言 |
| MiniMax | speech-02 / async、music-2.6 / **3.0**（含免费档/翻唱）、voice-clone | TTS、音乐生成、声音克隆 |
| 豆包 | Seed Audio 1.0、Seed TTS 2.0（Agent Plan） | 火山语音合成 |

> 完整的预设 ID 与对应 `protocol`/`baseUrl`/`vendor` 见 [预设清单](#-配置文件说明) 或 `--webui` 配置台下拉。

---

## 系统要求

Prismstudio 是一个 Node.js MCP Server。macOS 和 Windows **默认不自带** Node.js / npm / npx；请先安装 **Node.js 20 或更高版本**。Node.js 官方安装包通常会同时安装 npm 与 npx。

### 检查是否已安装

```bash
node -v
npm -v
npx -v
```

如果 `node -v` 显示 `v20.x`、`v22.x` 或更高版本，就可以继续。

### 安装 Node.js

**macOS**

推荐任选一种：

```bash
# 官方安装包：下载并安装 LTS 版本
# https://nodejs.org/

# 或 Homebrew
brew install node

# 或 nvm
nvm install --lts
```

**Windows**

推荐任选一种：

```powershell
# 官方安装包：下载并安装 LTS 版本
# https://nodejs.org/

# 或 winget
winget install OpenJS.NodeJS.LTS
```

安装完成后，重新打开终端 / PowerShell，再运行上面的 `node -v`、`npm -v`、`npx -v` 检查。

---

## 快速开始

### 第 1 步：按需打开 WebUI 完成配置（推荐首次使用）

```bash
npx -y prismstudio@latest webui
```

浏览器会自动打开 `http://127.0.0.1:17899`。WebUI 是**按需配置面板，不是常驻服务**：

- 只有这条命令运行时才会占用 `17899` 端口
- 关掉终端或按 `Ctrl+C` 后，WebUI 会停止，不再占用电脑内存 / CPU
- 配置会保存到本地 `~/.prismstudio/config.json`，不会因为 WebUI 关闭而丢失
- 已运行的 MCP Server 会监听配置变化；支持 MCP `tools/list_changed` 的 agent 可自动刷新工具清单，旧客户端可能仍需重启
- 以后需要换模型、改 API Key、测试生成时，再运行同一条命令打开即可
- 设置好一次后，日常在 agent 里生成图片 / 视频 / 音频**不需要 WebUI 常驻**

在页面里：

1. **配置台**：为想用的模态（图片/视频/音频）选择预设模型、填写 API Key，点保存
2. **试用台**：直接生成一张图 / 一段 TTS 验证配置是否生效
3. **接入向导**：选择你的 agent，一键复制 `mcpServers` 配置 JSON

<p align="center">
  <strong>配置台</strong> · 选模型、填 Key、保存<br/>
  <img src="figures/webui-config.png" alt="配置台" width="90%">
</p>

<p align="center">
  <strong>试用台</strong> · 配好就试，所见即所得<br/>
  <img src="figures/webui-playground.png" alt="试用台" width="90%">
</p>

<p align="center">
  <strong>接入向导</strong> · 选 agent，一键复制配置<br/>
  <img src="figures/webui-wizard.png" alt="接入向导" width="90%">
</p>

### 第 2 步：接入到你的 agent

以 Claude Desktop 为例，编辑配置文件（macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "prismstudio": {
      "command": "npx",
      "args": ["-y", "prismstudio@latest"],
      "timeoutMs": 1800000
    }
  }
}
```

如果你的 agent 不支持直接粘贴 JSON，而是逐字段填写表单（如部分 GUI 客户端），按下面的对照填即可：

| 字段 | 填写内容 |
| --- | --- |
| 名称 / Name | `prismstudio` |
| 传输方式 / Type | `stdio` |
| 命令 / Command | `npx -y prismstudio@latest` |
| 环境变量 / Env | （留空） |

> ⚠️ **关于超时（timeout）**：上面 JSON 里的 `timeoutMs: 1800000`（30 分钟）属于 **MCP 客户端**的配置项，不是环境变量，**无法写进 Env 字段**。表单模式下能否设置取决于你的 agent：
> - 表单里有独立的 **Timeout** 字段 → 填 `1800000`。
> - 没有 timeout 字段 → 该客户端只能用默认超时（常见 30 秒 / 60 秒），视频 / 音乐等长任务可能被提前切断。建议改用 **JSON 粘贴模式**（见上方代码块）来带上 `timeoutMs`。

保存 MCP 配置后，**请重启 Claude Desktop / Cursor / Cline / Windsurf 等 agent**，让它重新加载 MCP server。重启后，就能在对话中让 agent 生成图片、视频、音频了。

> `timeoutMs: 1800000` 表示让 agent 最多等待 30 分钟，推荐保留，避免视频 / 音乐等长任务被客户端 30 秒默认超时提前切断。如果你的 agent 不支持这个字段并报错，删除这一行即可。
>
> 如果你的 agent 提供“表单 / JSON”切换，请选择 **JSON** 格式，把 WebUI 接入向导复制出的 JSON 粘贴进去；如果表单里要求填写类型（type），请选择 `stdio`。

<p align="center">
  <strong>MCP 配置填写提示</strong> · 选择 JSON 格式后粘贴配置<br/>
  <img src="figures/mcp-json-format-guide.png" alt="MCP 配置选择 JSON 格式指引" width="90%">
</p>

<details>
<summary><b>其他 agent 配置</b></summary>

**Cursor**（`~/.cursor/mcp.json`）：
```json
{
  "mcpServers": {
    "prismstudio": { "command": "npx", "args": ["-y", "prismstudio@latest"], "timeoutMs": 1800000 }
  }
}
```

**Cline / Windsurf / VS Code**：同上结构，写入对应 MCP 配置位置即可。

**通用 stdio**：直接运行 `npx -y prismstudio@latest`，通过标准输入输出交互。

</details>

---

## 命令参考

```bash
prismstudio                       # 以 stdio MCP 模式运行（默认，供 agent 调用）
prismstudio webui                 # 启动本地 WebUI 配置台（等价于 --webui）
prismstudio --webui               # 启动本地 WebUI 配置台（浏览器打开 127.0.0.1:<port>）
prismstudio --webui --port 8080   # 指定 WebUI 端口（默认 17899）
prismstudio --output-dir <path>   # 覆盖生成物输出根目录（实际写入其 generated-media 子目录）
prismstudio diagnostics           # 输出脱敏诊断、就绪模态、策略与适配器信息
prismstudio --version             # 显示版本号
prismstudio --help                # 显示帮助
```

**环境变量：**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PRISMSTUDIO_CONFIG` | `~/.prismstudio/config.json` | 指定配置文件路径（便于多套配置切换） |

---

## 提供的 MCP 工具

只有已配置好的模态才会暴露对应工具（动态工具暴露，避免给 agent 留下一堆用不了的空壳）：

| 工具 | 模态 | 能力 |
|---|---|---|
| `generate_image` | 图片 | 文生图、参考图编辑、多轮迭代优化 |
| `generate_video` | 视频 | 文生视频（异步，1-5 分钟）、图生视频 |
| `generate_audio` | 音频 | TTS 语音、音乐生成、声音克隆 |

每个工具支持丰富的厂商专属参数（如 OpenAI 的 `quality`/`background`、Gemini 的 `aspectRatio`/`imageSize`、Stability 的 `stylePreset`、视频的 `withAudio`/`frames` 等），详见各工具的 `inputSchema`。

**安全使用多轮编辑：** 对同一段图片/视频连续迭代时，在每次 `generate_image` 或 `generate_video` 调用中复用同一个 `sessionId`，例如 `"sessionId": "image-edit-20260811-a"`。它必须是 1–128 位的无语义标识，以字母或数字开头，后续只可使用字母、数字、点、下划线或连字符；不要在其中放入提示词、文件路径、姓名或 API Key。不同对话必须使用不同 ID。stdio MCP 客户端没有稳定的传输会话标识，因此需要显式传这个字段；省略它时不会自动复用上一轮生成物或会话历史。兼容旧客户端的 `session_id` 仍可使用，但建议新调用统一使用 `sessionId`。

**生成产物**会保存到 `<输出目录>/generated-media/`：
- 如果没有手动设置 `outputDir`，默认输出目录是 `~/prismstudio/generated-media/`
- WebUI 试用台的临时试用产物默认保存在 `~/prismstudio/playground/`
- 图片 / 音频同时以 base64 内联回传给 agent，便于直接预览
- 图片 / 音频默认只在解码后不超过 8 MiB 时内联；超过阈值仅返回本地路径
- 视频体积大，仅返回本地路径
- 若本地输出目录临时不可写，图片 / 音频会作为紧急回退以内联数据返回，避免已计费结果丢失；视频无法安全返回时会明确报错，而不会伪装为成功

> `~/.prismstudio` 是用户主目录下的隐藏配置文件夹（文件夹名前有一个点），只保存配置与密钥；生成物默认放在非隐藏的 `~/prismstudio/`，方便直接查看。

**如何查看隐藏文件夹：**

- **macOS Finder**：按 `Command + Shift + .` 显示/隐藏隐藏文件；或按 `Command + Shift + G`，输入 `~/.prismstudio` 后回车直接打开。
- **Windows 文件资源管理器**：点击“查看 / View” → “显示 / Show” → 勾选“隐藏的项目 / Hidden items”；也可以按 `Win + R`，输入 `%USERPROFILE%\.prismstudio` 后回车打开。

你也可以直接让 agent 帮你处理文件，例如：

> “请把刚才生成的视频复制到我的桌面。”
> “请把最新生成的图片移动到 `/Users/你的用户名/Downloads/作品/`。”

---

## 配置文件说明

配置文件位于 `~/.prismstudio/config.json`（可用 `PRISMSTUDIO_CONFIG` 覆盖）：

```jsonc
{
  "image": {
    "enabled": true,
    "presetId": "openai-gpt-image-2",  // 预设 ID，或 "custom" 手动指定
    "apiKey": "sk-...",                  // 明文存储
    "apiKeyEnv": "OPENAI_API_KEY",       // 可选；apiKey 为空时从环境变量读取
    "model": "...",                      // 可选，覆盖预设模型（仅 custom 必填）
    "protocol": "openai-images",         // 可选，仅 custom 时有意义
    "baseUrl": "..."                     // 可选，覆盖预设 endpoint
  },
  "video": { /* ... */ },
  "audio": { /* ... */ },
  "outputDir": "/path/to/out",          // 可选，生成物输出根目录
  "policy": {
    "maxOutputs": 4,
    "maxVideoDurationSec": 15,
    "allow4k": true,
    "maxInlineMiB": 8,
    "maxInputMiB": 128,
    "allowedInputDirs": ["/path/to/assets"]
  },
  "diagnostics": {
    "enabled": false,
    "logFile": "/path/to/diagnostics.jsonl"
  }
}
```

明文 `apiKey` 优先于 `apiKeyEnv`。使用环境变量时，需要确保启动 MCP Server 的 agent 进程能够继承该变量。`maxInputMiB` 限制一次请求中所有本地参考图片、音频和视频的累计读取量。诊断日志尽量不记录提示词、凭据、参考路径或输出路径，并在 5 MiB 时滚动；已知请求上下文会在错误落盘前再次脱敏。

> **同厂商 Key 记忆**：每个模态按厂商（vendor）单独记忆 API Key（存在 `apiKeyByVendor`，并兼容旧的 `apiKeyByPreset`）。同一模态内切换同厂商模型无需重填；图片 / 视频 / 音频三类工具之间不强制共用。
>
> **火山引擎接入分组**：因鉴权方式不同，火山引擎在配置台里拆成三个独立 vendor：**火山 API**（普通方舟 Ark key）、**火山 Agent Plan**（Agent Plan 独立 key）、**火山语音**（语音服务独立 key）。三组各自记忆 Key，互不覆盖。

> **安全说明**：直接填写的凭证以明文存储（与 MCP 生态惯例一致），也可用 `apiKeyEnv` 避免真实密钥写入配置。WebUI 仅绑定 `127.0.0.1`，不加载第三方 CDN 脚本/字体，并通过安全响应头、Origin / Sec-Fetch-Site 校验与 JSON Content-Type 校验降低本机跨站请求风险。详见 [SECURITY.md](SECURITY.md)。

---

## 本地开发

```bash
# 依赖
bun install

# 开发（直接跑 TS）
bun run dev              # stdio 模式
bun run dev:webui        # WebUI 模式

# 质量检查
bun run typecheck        # 类型检查
bun test                 # 测试套件
bun run build            # 构建到 dist/
bun run check            # 类型检查 + 全量测试 + 构建

# 可选：真实 provider 契约冒烟测试；可能产生费用，默认拒绝执行
PRISMSTUDIO_RUN_PAID_CONTRACT_TESTS=1 bun run contract:smoke -- image

# 测试 stdio 握手
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | bun run dev
```

更多见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 架构

```
┌──────────────────────────────────────────────────┐
│  prismstudio（一个进程、一条命令）                     │
│                                                   │
│  ┌────────────────────────────────────────────┐  │
│  │  引擎内核（18 协议族，82 预置模型）           │  │
│  │  generateMedia() 统一入口                    │  │
│  └────────────────────────────────────────────┘  │
│            ▲                       ▲              │
│            │                       │              │
│   ┌────────┴───────┐      ┌────────┴─────────┐    │
│   │ stdio MCP 传输  │      │ 内嵌 HTTP WebUI  │    │
│   │ (给 agent 用)   │      │ (给人配置/试用)  │    │
│   └────────┬───────┘      └────────┬─────────┘    │
│            └───────┬────────────────┘             │
│         共享 ~/.prismstudio/config.json               │
└───────────────────────────────────────────────────┘
```

| 模块 | 职责 |
|---|---|
| `src/engine/media-generation-engine.ts` | 生成内核与协议适配器注册表，裸 `fetch` 调用各 provider |
| `src/engine/google-auth.ts` | Google Vertex / Gemini 服务账号鉴权 |
| `src/config.ts` | 配置读写，把结构化配置转成引擎所需的 flat credentials |
| `src/policy.ts` | 生成前成本与资源策略校验 |
| `src/diagnostics.ts` | 脱敏 JSONL 诊断与日志滚动 |
| `src/persist.ts` | 生成产物落盘 + 构造 MCP content 块（纯 `node:fs`） |
| `src/mcp-server.ts` | 底层 Server + JSON Schema 注册工具，串联引擎/配置/落盘 |
| `src/index.ts` | CLI 入口，分流 stdio / `--webui` 两种模式 |
| `src/webui/server.ts` | HTTP server + REST API（仅 `127.0.0.1`） |
| `src/webui/index-html.ts` | Alpine.js 单文件页面（配置/试用台/接入向导） |

---

## License

[MIT](LICENSE) © Jacky Huang
