# 变更日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.5.1] — 2026-08-14

### Fixed
- **WebUI 试用台误中止**：Node ≥16.3 中请求体被完整消费后 `req` 也会触发 `close`，旧写法会在每次正常试用时立刻中止上游付费请求；改为响应侧 `close` + `writableEnded` 判断，仅在客户端真正离开时中止。
- **轮询零容忍导致已计费任务丢失**：全部 10 处异步轮询器（DashScope/Seedance/可灵/智谱/MiniMax×3/Midjourney/混元/Google）统一接入瞬时失败容忍——429/5xx/网络抖动按递增退避重试（连续 3 次才放弃），4xx 永久错误立即抛出，失败信息保留 task_id 便于手动找回已计费结果。
- **Gemini API Key 泄漏面收敛**：`generateContent` / `interactions` 及 Omni 文件下载不再把 key 放进 URL query，统一只走 `x-goog-api-key` 请求头，避免被代理/网关访问日志持续复制泄漏。
- **Midjourney 轮询超时**由 5 分钟放宽到 10 分钟（第三方网关排队 + relax 模式常超 5 分钟）。
- **Stability 多图静默缩水**：`numberOfImages > 1` 时串行发起多次请求（每次独立随机 seed；显式 seed 按次偏移），不再只返回一张。
- **OpenAI images/edits 漏传 `n`**：编辑分支与生成分支行为对齐。
- **配置损坏保护**：`config.json` 解析失败时先备份为 `config.json.corrupt-<ts>` 再返回空配置，防止 WebUI 随后保存任意一项就用近空配置覆盖原文件导致 API Key 永久丢失。
- **WebUI 兼容 IPv6 回环**：Host 校验放行 `[::1]`（部分环境把 localhost 解析成 IPv6）。
- PUT `/api/config` 与 500 兜底中的二次 `loadConfig()` 加保护，磁盘配置损坏时不再吞掉原始保存错误。

### Changed
- Seedance / 可灵 `duration` 增加本地校验（5~12 整数秒 / 仅 5 或 10 秒），非法值本地抛可读错误而非厂商侧生硬 400。
- MiniMax TTS 音色启发式正则重排，修复"妩媚/魅惑"等分支被更宽泛分支遮蔽导致的静默音色错配。
- persist 写入失败日志补充请求文件名与输出目录；WebUI 载入失败文案不再误用"提交失败"。

## [0.5.0] — 2026-08-11

### Added
- 新增 WebUI「运行策略」面板：单次数量、视频最长时长、4K 开关、图片/音频内联阈值、参考素材累计读取预算、额外参考素材目录白名单与脱敏诊断日志均可配置。
- 各模态支持 `apiKeyEnv`，明文 key 为空时从指定环境变量读取，配置文件无需保存真实凭据。
- 新增 `prismstudio diagnostics` 脱敏诊断命令，以及显式付费 opt-in 的 `bun run contract:smoke -- <modality>` 真实 provider 契约冒烟入口。
- 新增 **MiniMax H3**（海螺）视频预设：2026-07-31 发布的当前旗舰，全模态输入（文/图/视频/音频）、原生 2K、最长 15s、立体声同步。H3 改用全新 v2 接口（`/v2/video_generation` + `/v2/query/video_generation/{id}`，请求体为 `content` 数组结构），故新增 `minimax-video-v2` 协议族。
- 新增 **MiniMax Hailuo-2.3-Fast** 视频预设（图生视频快速版，走原 v1 `video_generation` 端点）。
- 新增 **MiniMax music-3.0** 音乐生成预设（新一代音乐模型，沿用 `minimax` 协议族 + `music` 任务路由）。
- 新增 **万相 wan2.7-image-pro / wan2.7-image** 图像预设：支持文生图/图生组图/图像编辑/多图参考，Pro 档支持 4K 直出与 12 种语言文字渲染。`formatDashscopeMultimodalImageSize` 为 Pro 档放开像素上限（4096²），并放宽参考图校验让 Pro 支持多图参考。

### Changed
- `generateMedia()` 的条件分派重构为协议适配器注册表，为后续按 provider 拆文件建立稳定边界，并提供适配器清单诊断。
- MCP 工具 JSON Schema 会随运行策略动态收紧数量、视频时长和 4K 枚举；严格 TypeScript 边界检查已纳入常规构建。
- 图片/音频默认内联上限为 8 MiB，超过阈值时仍安全落盘但只向 MCP/WebUI 返回本地路径，避免大 base64 占用传输、内存和上下文。
- 参考素材读取从单一输出根目录扩展为「输出根目录 + 显式允许目录」白名单，继续使用 realpath 防止符号链接逃逸。
- MCP 工具清单改为运行时读取最新配置，并通过 `tools/list_changed` 通知兼容客户端；启用/停用模态、切换模型或修改输出目录后不再固定使用进程启动时的旧状态。
- 工具 JSON Schema 补充图片/视频数量、压缩率与时长的基础数值边界，减少 agent 生成无效参数。
- 明确 Bun 版本并在 CI / Release 中校验 npm 与 Bun 双锁文件同步，避免本地审计读取陈旧 `package-lock.json` 产生错误结论。
- 同步更新 README / README.en 能力总览：预置模型 60→82、协议族 14→18、厂商 13→16，各模态模型表补全 MiniMax H3 / music-3.0、万相 2.7-image 系列等新成员。
- WebUI 自定义模式「协议」下拉与端点路径映射（`PROTOCOL_ENDPOINT_PATH` / `PROTOCOL_OPTIONS`）补全 `minimax-video-v2` 协议（中英双语）。

### Fixed
- 修复仅使用 `apiKeyEnv` 且环境变量有效时，服务端已判定通道就绪但 WebUI 卡片仍显示“空闲”的状态偏差；通道状态现在统一以服务端就绪结果为准。
- 修复固定路径的本地 Alpine.js 被设置为一年不可变缓存、升级后浏览器可能继续使用旧脚本的问题；静态脚本现会重新验证版本。API 路由同时改为按完整 pathname 精确匹配，避免相似前缀误命中导出接口。
- 修复未提供 `sessionId` 的 stdio MCP 调用复用全局默认会话，可能把上一对话的生成物、Gemini 历史或 Omni interaction 续接到另一对话的问题；现在仅显式会话启用历史，`generate_image` / `generate_video` 均提供受格式约束的 `sessionId`（兼容 `session_id`）供 stdio 客户端安全续接，并限制 Gemini 会话数、轮数和内存预算。
- 修复非法协议或跨模态协议可被显示为 ready、适配器重复键测试在 `Map` 去重后失效的问题；协议现使用运行时白名单，注册表在初始化时拒绝重复项，全部预设均验证有真实路由。
- 修复 Google OAuth token 交换无法随 MCP 请求取消，以及显式无效 Gemini Base URL 静默回退官方域名、可能绕过代理的问题。
- 修复参考素材未限制累计读取体积、视频 provider 异常返回过多结果不受策略裁剪，以及诊断错误仍可能泄露本地路径、data URI 或签名 URL 查询参数的问题。
- 修复 WebUI 自动保存与手动保存可并发乱序，慢请求响应覆盖用户较新输入的问题；所有配置写入现串行执行，旧 revision 响应不会回填页面。
- WebUI 配置校验现在拒绝越界/小数策略值、非法环境变量名、相对素材目录、未知或跨模态协议；JSON Content-Type 改为精确 media type 检查，请求体累计改为 O(n) 计数。
- CLI 现在会明确拒绝未知参数、缺失/非法的 `--port` 与 `--output-dir`，并校验互斥模式，避免拼写错误后静默启动到错误模式。
- 修复 WebUI 运行策略新增的换行处理在模板字符串中转义不足，导致内嵌脚本语法错误、配置主体无法渲染的问题；并补齐试用台在自动保存完成前读取页面 `apiKeyEnv` 的路径。
- 运行策略现在同时检查 prompt 推断出的时长/4K、预设默认 4K 和畸形数量，避免绕过显式参数检查后发出超预算上游请求。
- 诊断日志中的 provider 错误在落盘前会使用配置内及环境变量解析出的真实密钥再次脱敏，避免非标准错误文本回显凭据。
- 配置保存改为同目录临时文件、`fsync` 后原子替换，降低异常退出导致 `config.json` 截断和密钥配置丢失的风险；读取时增加运行时类型归一化，坏字段不再触发进程崩溃。
- 修复 Windows 无法直接覆盖配置文件时的替换回退：旧配置会先移入同目录恢复备份，新文件替换失败则自动恢复，避免过去 delete-then-rename 造成配置与密钥丢失。
- 修复上游已成功生成但输出目录不可写时图片/音频结果被静默丢弃的问题：现在会紧急内联回传；无法内联的视频则明确报错，不再返回不存在的“成功”路径。
- 修复关闭某模态后，已运行的 MCP Server 仍可继续调用该模态的问题；运行时解析现在同时校验 `enabled`。
- 修正文档与 WebUI 占位文案仍把生成物写成旧目录 `~/.prismstudio/`，并把 `outputDir` 根目录误写成最终子目录的问题；真实默认根目录为 `~/prismstudio/`。
- MCP 与 WebUI 试用台返回上游错误前会脱敏已配置 API Key、拆分式 AccessKey/SecretKey 与常见认证头，降低代理错误回显凭据的风险。
- 修复 MiniMax H3（`minimax-video-v2`）`ratio` 字段按官方文档分场景处理：① 纯文生视频（t2va）必须显式指定具体比例且不能为 `adaptive`（否则 API 400，错误 2013），现按 `size`/`aspectRatio`/预设 `defaultSize` 自动推导并兜底 16:9；② 图生视频（i2va，content 含图片）官方规定 ratio 恒为 `adaptive`（由首帧图决定，传其他值会被忽略），现显式传 `adaptive` 而非强行推导。
- 修复图片生成显式 `numberOfImages` 被 prompt 里的自然语言数量词静默覆盖（如传 4 张但 prompt 写"一张"时只返回 1 张）。现显式参数优先，未显式时才从 prompt 解析。
- 修复 `extForMediaType` 对 `audio/opus` / `video/x-matroska` 标错扩展名（分别落到 `.wav` / `.mp4`），与引擎 `EXT_TO_MIME` 表不一致。现正确输出 `.opus` / `.mkv`。
- 修复 `audioTask`（`task` 参数）非法值在自定义配置下静默落到 TTS 分支的问题，现显式校验并报错（可选值 tts/music/clone）。新增 `requireEnumArg` 统一枚举校验（非法值抛错、空值放行），取代原先"手动抛错 + optionalEnumStringArg 静默丢弃"的双策略冗余写法。
- 修复 google-auth 两处 Vertex URL 构造缺陷：① 完整 `:predictLongRunning` 端点作 baseUrl 时被二次追加成双后缀；② api-key 的 Omni `interactions` 完整端点被拼出双段路径。均导致 404。另修复无法解析的自定义 Vertex baseUrl 被静默丢弃、直接请求官方域名（绕过企业代理）的问题——现改为明确报错。
- 新增 `src/engine/google-auth.test.ts`（14 项），补齐 google-auth URL 构造测试覆盖。
- 修复图片数量裁剪回归：未显式传 `numberOfImages` 时不再被 `defaultCount: 1` 兜底，Gemini 等"prompt 驱动多图"（如"生成 4 张图"）不再被静默裁成 1 张；显式参数仍优先。
- 修复 H3 轮询对未知/缺失任务状态静默空转到硬超时的问题，现立即报错（与 DashScope 轮询约定一致）。
- 修复 H3 duration 对 NaN/非有限值无防护的问题；H3 现在支持从 prompt 解析时长与竖屏比例（与其他视频协议一致）。
- 修复 H3 `resolution` 对不支持的值（如 `1080p`）静默兜底到更贵的 2K 档的问题——H3 官方仅支持 `768P`/`2K` 两档，现对无法识别的分辨率显式报错，避免按量计费时的意外成本。同时修正 `resolution` 误从 `size`（可能是比例 `9:16`）回退导致的混淆，现仅从专用 `resolution` 参数取值。
- 修复万相 wan2.7-image（非 Pro）被参考图守卫误拒的问题——官方文档确认其支持图生图/编辑；另按官方限制将 wan2.7-image-pro 的 4K 限定在文生图场景（编辑/图生图最高 2K）。
- 修复 WebUI `PUT /api/config` 缺少 body 形状校验的问题——`[]`/`"string"`/`{image:null}` 等错误体此前可清空或破坏 config.json（明文 Key 永久丢失）；现校验并拒绝。
- 修复 `maskApiKey` 对非字符串 key（坏数据）抛 TypeError 导致 WebUI `GET /api/config` 永久 500 的问题，现类型守卫返回空。
- 修复清空顶层 API Key 不清理 `apiKeyByVendor` / `apiKeyByPreset` 记忆导致"已删除密钥复活"的问题，现清空时同步删除对应记忆条目。

## [0.4.0] — 2026-07-22

### Added
- 接入 **woyaopro生图** 渠道（iiiiitoken 网关，OpenAI 兼容 + Gemini 双协议），共 9 条图像预设：
  - `gpt-image-2-x`：1K / 2K / 4K 三档分辨率（openai-images 协议）。
  - `gemini-3.1-flash-image`（Flash）：1K / 2K / 4K 三档（gemini-generate-content 协议，原生多轮编辑）。
  - `gemini-3-pro-image`（Pro）：1K / 2K / 4K 三档（gemini-generate-content 协议）。
- `MediaModelPreset` 新增 `defaultImageSize` 字段：Gemini 协议的分辨率由调用时的 `imageSize` 参数控制（`defaultSize` 对它无效），该字段把预设声明的分辨率透传到 `callGeminiImageApi`，使每条 Gemini 预设按声明的 1K/2K/4K 真实出图。
- WebUI 模型下拉切换到带 `helpUrl` 的预设后，输入框下方显示 `🔗 获取 API Key` 可点击链接（新标签打开申请页）；woyaopro 渠道指向 `https://woyao.pro/i/5MLA4`。

### Changed
- 生成物默认输出目录从隐藏的 `~/.prismstudio/` 改为非隐藏的 `~/prismstudio/`，方便用户在 Finder / 文件管理器中直接查看生成结果；配置与密钥文件仍保留在 `~/.prismstudio/`。WebUI 试用台（playground）产物目录同步调整为 `~/prismstudio/playground/`。

### Fixed
- 修复 woyaopro Gemini 预设（`gemini-3.1-flash-image` 与官方 Google Gemini 同名同协议）因数组顺序靠前，在「手动填 model、未选预设」的回退路径中劫持官方 Gemini 用户的问题。现把 woyaopro 预设排到官方之后，`findPresetByModel` 回退优先命中官方。

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

[Unreleased]: https://github.com/RunhuaHuang/prismstudio/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/RunhuaHuang/prismstudio/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/RunhuaHuang/prismstudio/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/RunhuaHuang/prismstudio/compare/v0.3.1...v0.3.2
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
