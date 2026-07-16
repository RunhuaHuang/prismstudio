# 变更日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.3.2] — 2026-07-17

### Fixed
- 修复 `generateMedia` 入口 TTS 协议覆写缺少模态守卫，导致视频/图像任务被误改写成 `minimax-tts-async` 报「视频不支持协议族」。
- 修复音频任务（audioTask）不跟随模型的问题：music/clone 模型残留 `audioTask='tts'` 时会互相错路由，现按 model 反查预设自动纠正。
- 修复 MiniMax 音乐生成（music-2.6）缺 lyrics 时报 `lyrics is required`：agent 常把歌词误塞进 prompt，引擎现自动用 prompt 兜底并开启 `lyrics_optimizer`，无论 agent 如何传参都不崩。

### Added
- 新增 `MiniMax-Hailuo-2.3` 视频预设，自定义配置可按 model 自动命中。
- `callMinimaxVideoApi` 透传 `aigc_watermark` 水印参数。
- MiniMax 视频分辨率大小写归一化：agent 传小写 `1080p` 自动转为 `1080P`，避免无谓重试。
- 强化 `generate_audio` 工具提示词：music 任务 lyrics 标注 REQUIRED，明确歌词须放 lyrics 不能塞 text；music 模型动态追加必填提示。

### Changed
- 回归测试扩展至 161 项，覆盖视频路由、audioTask 自动判定、music 歌词兜底、分辨率归一化。

## [0.3.1] — 2026-07-13

### Added
- WebUI 的预设模型也可覆盖 Base URL 与接口协议，并实时预览最终请求地址；支持一键恢复预设 Base URL。
- 试用台支持单独指定生成物输出目录。

### Fixed
- 修复预设协议覆盖只在配置解析层生效、实际生成仍被预设协议强制覆盖的问题。
- 修复模型切换后在自动保存完成前立即试用时，可能错用旧模型、旧协议、旧 Base URL 或旧厂商 API Key 的竞态。
- MCP 请求取消信号贯通到全部生成网络请求与轮询，MiniMax 音乐也会在用户取消后立即停止。
- 修复 WebUI 状态栏在输出根目录名为 `generated-media` 时显示的路径与实际落盘路径不一致。
- 修复 Base URL 没有覆盖值时仍显示「恢复默认」按钮。

### Security
- 明文 API Key 配置文件在 macOS / Linux 上强制使用 `0600` 权限，并自动收紧旧文件的宽松权限。
- 生成物改为原子排他写入，重名自动追加序号，避免覆盖已有文件或通过符号链接改写其它文件。

### Changed
- 回归测试扩展至 172 项 / 519 次断言，覆盖协议实际分派、取消传播、配置权限、路径一致性和试用台竞态。

## [0.3.0] — 2026-07-13

### Added
- WebUI API Key 输入框新增眼睛图标切换明文 / 隐藏（主配置与试用台临时密钥），SVG 图标、与输入框等高对齐。
- WebUI 选中模型后只读展示完整请求地址（含协议路径后缀，如 `/images/generations`），以及接口协议可读名，供自定义时参考。
- WebUI 自定义模式「协议」由纯文本框改为人类可读下拉（如「OpenAI 兼容」「火山方舟（异步）」），后台映射到内部协议名。
- 火山引擎（豆包）接入按鉴权方式拆分为三个独立 vendor：火山 API（普通方舟 Ark）、火山 Agent Plan（Agent Plan 独立 key）、火山语音（语音服务 key），下拉分组清晰、API Key 互不覆盖。

### Fixed
- 修复 `PROTOCOL_ENDPOINT_PATH` 对 `dashscope-async` 等多模态协议显示错误路径（video 误显 image 路径）；改为协议 × 模态二维映射。
- 修复自定义模式 BaseURL 输入框在端点改只读后丢失的回归。
- 修复 `displayEndpoint` 内正则反斜杠在模板字符串中转义丢失导致 WebUI 整页白屏（SyntaxError）。

### Changed
- WebUI 容器宽度由 1080px 拓宽到 1400px，下拉项模型名优先占满、协议标签可省略，大幅减少长模型名被截断。
- 清理失效的 BaseURL 可编辑输入框相关死代码（i18n / CSS / helper）。

## [0.2.0] — 2026-07-12

### Added
- WebUI 左上角品牌名正下方显示当前版本号，打开页面即可见（运行时从 `package.json` 读取，自动跟随发版）。
- README 接入向导补充表单模式逐字段填写对照表（名称 / 传输方式 / 命令 / 环境变量），覆盖不支持粘贴 JSON 的 GUI 客户端；并说明 `timeoutMs` 无法写入环境变量、表单模式下的超时处理建议。

## [0.1.8] — 2026-07-12

### Added
- WebUI 为配置载入失败和辅助数据载入失败提供分级提示与就地重试。
- 多轮会话缓存增加 256 条 LRU 上限，避免长驻 MCP Server 内存持续增长。

### Fixed
- DashScope 异步任务对取消、失败、缺失及未知状态立即给出明确错误，不再错误轮询到硬超时。
- CosyVoice 与 Qwen3-TTS 分别使用官方 `rate` / `speed` 参数，避免未知参数导致请求失败。
- Qwen Image 非法比例兜底使用正确的 `x` 尺寸分隔符。
- WebUI 的状态和接入导出接口失败不再禁用配置保存，配置载入失败时则继续保持 fail-closed。
- MiniMax 音乐生成继续使用独立内部超时，避免调用方短超时错误中断长任务。

### Security
- 参考文件路径校验改用真实路径，阻止符号链接逃逸；恢复 Windows 跨盘符绝对路径检查，避免绕过工作目录边界。
- WebUI 拒绝把错误体、数组或其他非对象响应当作配置写回磁盘。

## [0.1.5] - 2026-07-04

### Added
- 火山语音 TTS（豆包 Seed Audio 1.0）与 Agent Plan Seed TTS 2.0 协议支持，新增 `volcengine-tts` / `volcengine-plan-tts` 两个协议族。

### Changed
- 文档补充 MCP 客户端超时建议（三十分钟）与生成物落盘位置说明。

## [0.1.4] - 2026-07-04

### Fixed
- MiniMax 音乐 `audio_url` 结果下载改用独立 2 分钟下载超时，避免 5 分钟生成等待预算被下载阶段继续消耗。

## [0.1.3] — 2026-07-04

### Fixed
- MiniMax 音乐生成使用独立 5 分钟内部超时，不再复用调用方短超时 signal，避免 `music-2.6` / `music-cover` 等 30–120 秒长耗时任务在 30 秒左右被中断导致文件无法保存。

### Changed
- 三个生成工具的内部等待窗口统一放宽：图片轮询 5 分钟、视频轮询 10 分钟、音频长任务 5 分钟。

## [0.1.2] — 2026-07-04

### Fixed
- WebUI API Key 记忆改为同一模态内按 vendor 共享：同一厂商下切换不同图片 / 视频 / 音频模型不再要求重复输入 API Key。
- 保留并自动迁移旧的 `apiKeyByPreset` 记忆，避免已有用户配置丢失。

## [0.1.1] — 2026-07-04

### Added
- 双语 README（`README.md` 中文 + `README.en.md` 英文），顶部可一键切换。
- 社区与治理文件：`CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`、issue 模板。
- GitHub Actions：`ci.yml` 补 `bun test` 步骤；新增 `release.yml`（打 `v*` tag 自动发布到 npm）。

### Changed
- 修正 `README` 中的数字为真实值：60 个预置模型 / 14 种协议 / 13 家厂商（原先误写为「40+ 模型 / 13 协议族」）。
- 新增「能力总览」表格，按模态 × 厂商列出全部支持矩阵。
- `package.json` 补全 `author` / `repository` / `homepage` / `bugs`，扩充实 `keywords`。
- `LICENSE` 署名更新为 Jacky Huang。
- WebUI 去除第三方 CDN 脚本/字体加载，改为本地 Alpine.js 依赖与系统字体。
- Release/CI 固定 Bun 版本，补 `bun audit`、tag/package 版本一致性检查、npm 已发布版本检查、pack dry-run 与 CLI smoke test。
- npm 包内容补齐 `figures/`、英文 README、CHANGELOG 与 SECURITY，保证 README 图片和安全文档在包内可访问。
- CLI 增加 `--version` / `-v`，issue 模板可引导用户准确填写版本。

### Security
- WebUI 增加 CSP、`X-Content-Type-Options`、`Referrer-Policy`、`Cross-Origin-Resource-Policy`、`Permissions-Policy` 等安全响应头。
- WebUI API 增加 loopback Host、Origin、Sec-Fetch-Site 与写入类 JSON Content-Type 校验，降低本机跨站请求触发真实 Key 调用的风险。

### Removed
- 移除未直接使用的 `zod` 直接依赖（仍由 MCP SDK 按需传递依赖）。

---

## [0.1.0] — 2026-06-30

首个独立版本：从 RunAI 多模态生成能力去耦合独立化，作为 stdio MCP Server + 内嵌 WebUI。

### Added
- **多模态生成引擎**：14 种协议族、60 个预置模型，覆盖图像（28）/ 视频（19）/ 音频（13），统一 `generateMedia()` 入口，裸 `fetch` 调用各 provider。
  - 图像：OpenAI gpt-image、Google Gemini（nano-banana）/ Vertex、豆包 Seedream、智谱 GLM-Image/CogView、MiniMax、通义 Qwen-Image、万相、Stability、腾讯混元、Midjourney
  - 视频：智谱 CogVideoX、豆包 Seedance、可灵 Kling、MiniMax、万相 wan2.7、Qwen HappyHorse、腾讯混元、Google Veo 3.1 / Omni
  - 音频：CosyVoice、Qwen3-TTS、GLM-TTS、MiniMax speech/music、声音克隆
- **三个 MCP 工具**：`generate_image` / `generate_video` / `generate_audio`，按已配置模态**动态暴露**。
- **内嵌 WebUI**（`--webui`）：配置台 / 试用台 / 接入向导三合一，Industrial Studio Console 美学，日间/夜间主题 + 中英文切换，仅绑定 `127.0.0.1`。
- **多渠道 Key 记忆**：每个模态按 preset（厂商）单独保存 API Key，切换无需重填、切回自动恢复。
- **Google 鉴权**：Vertex / Gemini 服务账号 JSON 支持（`src/engine/google-auth.ts`）。
- **本地配置**：`~/.prismstudio/config.json`，可用 `PRISMSTUDIO_CONFIG` 环境变量覆盖路径。
- **测试套件**：引擎分派/缓存/各 provider 适配、persist 落盘等，131 测试 / 434 断言。
- **CI**：GitHub Actions 跑 typecheck + build（后续补 test）。

[Unreleased]: https://github.com/RunhuaHuang/prismstudio/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/RunhuaHuang/prismstudio/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/RunhuaHuang/prismstudio/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/RunhuaHuang/prismstudio/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/RunhuaHuang/prismstudio/compare/v0.1.5...v0.1.8
[0.1.5]: https://github.com/RunhuaHuang/prismstudio/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/RunhuaHuang/prismstudio/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/RunhuaHuang/prismstudio/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/RunhuaHuang/prismstudio/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/RunhuaHuang/prismstudio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/RunhuaHuang/prismstudio/releases/tag/v0.1.0
