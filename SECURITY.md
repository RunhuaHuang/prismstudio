# 安全策略

Prismstudio 是一个本地优先的多模态生成 MCP Server。本文说明它的安全设计，以及如何报告漏洞。

## 凭证存储

- 直接填写的 API Key / 服务账号 JSON 以**明文**存放在本地配置文件 `~/.prismstudio/config.json`；也可以只配置 `apiKeyEnv`，让真实密钥保留在环境变量中。
- 这是与 MCP 生态（如 Claude Desktop、Cursor 等）一致的惯例——它们同样以明文存放 MCP server 的配置与密钥。
- Prismstudio **不会**把凭证上传到自有遥测或中转服务。所有 provider 调用都是从你的机器直接发往你配置的对应厂商 API；prompt、参考图片/音频/视频和生成请求会按任务需要发送给该 provider。
- macOS / Linux 上配置文件会自动使用 `0600` 权限，并通过同目录临时文件、`fsync` 和原子替换写入，降低配置截断和宽权限暴露风险。
- 你可以设置环境变量 `PRISMSTUDIO_CONFIG` 指定任意路径的配置文件，便于放在加密目录或权限更严的位置。

> 建议：优先使用 `apiKeyEnv`，确保启动 Prismstudio 的 agent 进程继承对应环境变量；同时避免把配置文件或 shell 环境文件提交到版本库。

## WebUI 的网络暴露面

- WebUI 的 HTTP server **仅绑定 `127.0.0.1`**，不监听局域网/公网地址，外部机器无法访问。
- WebUI 不从第三方 CDN 加载 JavaScript 或字体；前端运行所需的 Alpine.js 来自本地 npm 依赖，避免配置页处理 API Key 时引入远端脚本供应链风险。
- WebUI **不设置 `Access-Control-Allow-Origin` 响应头**，并对 API 请求做本地来源校验：
  - `Host` 必须是 `127.0.0.1` 或 `localhost`。
  - 有 `Origin` 时必须同为 loopback 且端口一致。
  - 有 `Sec-Fetch-Site` 时必须是 `same-origin` 或 `none`。
  - `POST` / `PUT` / `PATCH` / `DELETE` 必须使用 `application/json`。
- WebUI 首页设置 CSP 等安全响应头，阻止外部资源加载、禁止被其它页面 frame 嵌入，并关闭 referrer 泄露。
- WebUI 收到的请求体有 5MB 上限，防滥用。
- `/api/config` 返回的 API Key 已脱敏（中间用 `****` 替换），避免完整 Key 回传到浏览器。

## 生成产物

- 正式生成物默认落到 `~/prismstudio/generated-media/`；试用台产物默认落到 `~/prismstudio/playground/`。配置与密钥仍位于隐藏目录 `~/.prismstudio/`。
- 图片/音频默认仅在解码后不超过 8 MiB 时以 base64 内联；超过阈值仍会安全落盘并只返回本地路径。视频始终只返回本地路径。阈值可通过运行策略调整，设为 `0` 可完全关闭内联。
- 生成文件使用排他写入，不覆盖已有文件或符号链接目标；同名文件会自动追加序号。

## 本地素材读取边界

- 参考图片、音频和视频默认只能从当前输出根目录读取；需要读取其它位置时，必须在 `policy.allowedInputDirs` 或 WebUI「额外素材目录」中显式允许。
- 路径校验使用真实路径（realpath），防止通过输出目录内的符号链接逃逸到未授权目录。
- 单次请求读取的全部参考素材共享 `policy.maxInputMiB` 预算（默认 128 MiB），超限文件会在调用 provider 前被拒绝，避免 base64 编码导致内存异常膨胀。
- 建议只允许任务确实需要的最小目录，不要把整个用户主目录或磁盘根目录加入白名单。

## 诊断日志

- 诊断日志默认关闭。启用后只写入时间、请求 ID、来源、结果、模态、协议、厂商、模型、耗时、输出数量或脱敏错误。
- 日志尽量不记录 prompt、API Key、参考素材路径或输出路径；已配置的明文和本次请求上下文会在错误落盘前再次脱敏，错误中的 data URI、本地绝对路径和签名 URL 查询参数也会被清理。
- 日志默认位于 `~/.prismstudio/diagnostics.jsonl`，使用 `0600` 权限，并在 5 MiB 时滚动保留一份 `.1` 备份。

## 数据流出

Prismstudio 不发送遥测。你的 prompt 与生成请求只会发往你配置的模型 provider；可选诊断信息仅写入本机日志。

## 报告漏洞

如果你发现了安全漏洞：

1. **请不要在公开 issue 里直接披露细节。**
2. 通过 [GitHub Security Advisory](https://github.com/RunhuaHuang/prismstudio/security/advisories/new) 提交（推荐），或邮件联系维护者。
3. 请附上：问题描述、复现步骤、影响范围、（如有）修复建议。

我会在收到报告后尽快确认并跟进。

## 已知权衡

- **明文配置**：直接填写密钥时仍以可读 JSON 保存，以兼容现有 MCP 工作流；不希望落盘真实密钥时请使用 `apiKeyEnv`。
- **WebUI 自动开浏览器**：`--webui` 会尝试用系统命令打开默认浏览器；这是便利性权衡，失败时静默忽略，不阻塞 server。
