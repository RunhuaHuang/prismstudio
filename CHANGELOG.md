# 变更日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- 双语 README（`README.md` 中文 + `README.en.md` 英文），顶部可一键切换。
- 社区与治理文件：`CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`、issue 模板。
- GitHub Actions：`ci.yml` 补 `bun test` 步骤；新增 `release.yml`（打 `v*` tag 自动发布到 npm）。

### Changed
- 修正 `README` 中的数字为真实值：60 个预置模型 / 14 种协议 / 13 家厂商（原先误写为「40+ 模型 / 13 协议族」）。
- 新增「能力总览」表格，按模态 × 厂商列出全部支持矩阵。
- `package.json` 补全 `author` / `repository` / `homepage` / `bugs`，扩充实 `keywords`。
- `LICENSE` 署名更新为 Jacky Huang。

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

[Unreleased]: https://github.com/RunhuaHuang/prismstudio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/RunhuaHuang/prismstudio/releases/tag/v0.1.0
