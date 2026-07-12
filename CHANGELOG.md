# 变更日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

## [0.1.4] — 2026-07-04

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

[Unreleased]: https://github.com/RunhuaHuang/prismstudio/compare/v0.1.8...HEAD
[0.1.8]: https://github.com/RunhuaHuang/prismstudio/compare/v0.1.4...v0.1.8
[0.1.4]: https://github.com/RunhuaHuang/prismstudio/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/RunhuaHuang/prismstudio/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/RunhuaHuang/prismstudio/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/RunhuaHuang/prismstudio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/RunhuaHuang/prismstudio/releases/tag/v0.1.0
