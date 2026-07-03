# 贡献指南

感谢你对 Duo-MCP 的兴趣！🎉 无论是提 issue、修 bug、加新模型预设，还是改进文档，都非常欢迎。

## 开发环境

需要：

- [Bun](https://bun.sh) ≥ 1.0（用于依赖管理与跑测试）
- Node.js ≥ 20（运行时；发布的产物是纯 Node，不依赖 Bun 运行时）

```bash
git clone https://github.com/RunhuaHuang/duo-mcp.git
cd duo-mcp
bun install
```

## 常用命令

```bash
bun run dev          # 以 stdio MCP 模式开发（直接跑 TS）
bun run dev:webui    # 以 WebUI 模式开发（浏览器打开 127.0.0.1:17899）
bun run typecheck    # 类型检查（tsc --noEmit）
bun test             # 跑测试套件
bun run build        # 构建到 dist/
```

测试 stdio 握手：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | bun run dev
```

## 项目结构

| 目录 / 文件 | 说明 |
|---|---|
| `src/engine/` | 生成引擎内核：协议分派、各家 provider 适配、模型预设表 |
| `src/config.ts` | 配置读写，结构化配置 ↔ 引擎 flat credentials 转换 |
| `src/persist.ts` | 生成产物落盘 + MCP content 块构造 |
| `src/mcp-server.ts` | 底层 MCP Server + 工具注册 |
| `src/index.ts` | CLI 入口 |
| `src/webui/` | 内嵌 WebUI（HTTP server + 单文件 Alpine.js 页面） |

详见 [README 架构段](README.md#-架构)。

## 加一个新的模型预设

1. 在 `src/engine/media-generation-engine.ts` 的 `MEDIA_MODEL_PRESETS` 里加一条：`{ id, modality, protocol, vendor, name, model, baseUrl, ... }`
2. 如果是新协议族（`protocol`），在引擎里实现对应的 `dispatch` 分支（请求构造 + 响应解析 + 轮询/同步逻辑）
3. 加测试到 `src/engine/media-generation-engine.test.ts`，跑 `bun test` 确认通过
4. 如果有厂商专属参数，记得在 `src/mcp-server.ts` 对应的 `*_SCHEMA` 里加上，并在 `runGeneration` 里透传

## Commit 规范

沿用 Conventional Commits（中文描述也可以）：

```
feat: 生图加入 Gemini (nano-banana) 支持
fix(gemini): 补全 aspectRatio 参数链路
chore: 升级依赖
docs: 完善 README
```

## 提交 PR

1. 从 `main` 拉分支：`feat/xxx`、`fix/xxx`、`docs/xxx`
2. 保证 `bun run typecheck` 与 `bun test` 都通过
3. 如果加了功能/修了 bug，补测试
4. PR 描述说清楚动机、改动点、是否有破坏性变更

## 行为准则

请保持友善、尊重。对技术问题就事论事，不对人。让我们共同维护一个让所有人都能舒适参与的环境。
