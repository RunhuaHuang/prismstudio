# 安全策略

Duo-MCP 是一个本地优先的多模态生成 MCP Server。本文说明它的安全设计，以及如何报告漏洞。

## 凭证存储

- API Key / 服务账号 JSON 以**明文**存放在本地配置文件 `~/.duo-mcp/config.json`。
- 这是与 MCP 生态（如 Claude Desktop、Cursor 等）一致的惯例——它们同样以明文存放 MCP server 的配置与密钥。
- Duo-MCP **不会**上传你的凭证到任何远端服务。所有 provider 调用都是从你的机器直接发往对应厂商 API。
- 你可以设置环境变量 `DUO_MCP_CONFIG` 指定任意路径的配置文件，便于放在加密目录或权限更严的位置。

> 建议：在生产或多用户机器上，对 `~/.duo-mcp/config.json` 设置严格的文件权限（如 `chmod 600`），并避免提交到版本库（`.gitignore` 已忽略）。

## WebUI 的网络暴露面

- WebUI 的 HTTP server **仅绑定 `127.0.0.1`**，不监听局域网/公网地址，外部机器无法访问。
- WebUI **不设置 `Access-Control-Allow-Origin` 响应头**，防止你浏览器里打开的其它网页跨域调用 `http://127.0.0.1:17899/api/test`（该接口会用你的真实 Key 发起生成请求）。
- WebUI 收到的请求体有 5MB 上限，防滥用。
- `/api/config` 返回的 API Key 已脱敏（中间用 `****` 替换），避免完整 Key 回传到浏览器。

## 生成产物

- 生成物默认落到配置目录下的 `generated-media/`；试用台的产物落到 `playground/`。
- 图片/音频在回传给 agent 时会以 base64 内联；视频体积大，只返回本地文件路径。

## 数据流出

Duo-MCP 本身不收集任何遥测。你的 prompt 与生成请求只会发往你在配置里选定的那家模型 provider。

## 报告漏洞

如果你发现了安全漏洞：

1. **请不要在公开 issue 里直接披露细节。**
2. 通过 [GitHub Security Advisory](https://github.com/RunhuaHuang/duo-mcp/security/advisories/new) 提交（推荐），或邮件联系维护者。
3. 请附上：问题描述、复现步骤、影响范围、（如有）修复建议。

我会在收到报告后尽快确认并跟进。

## 已知权衡

- **明文配置**：可用性优先（用户可读、可手动编辑、可被 agent 直接消费）。如果未来需要加密存储，会以可选功能形式提供，不破坏现有行为。
- **WebUI 自动开浏览器**：`--webui` 会尝试用系统命令打开默认浏览器；这是便利性权衡，失败时静默忽略，不阻塞 server。
