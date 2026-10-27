# 场景：ChatGPT 网页端

通过 ChatGPT 网页端调用自己的 SSH MCP 工具，复用已有对话入口与模型额度，无需为这个执行服务另接模型 API。具体功能与额度取决于客户端账户权限。

先完成 [通用部署流程](../setup.md)。本文件仅补充该客户端的差异，不要求其他 MCP 客户端采用这些配置。

## 客户端接入

在有自定义 MCP 权限的 ChatGPT 账户中，使用自定义 MCP 应用创建入口；部分账户可能需要先开启开发者模式。复用已有匹配连接，缺失时配置：

- 名称：例如 Cloudflare SSH。
- MCP URL：`https://<自己的 Worker 主机名>/mcp`。
- 认证：OAuth，通过 Managed OAuth discovery 和客户端动态注册连接。

在 Access 的 Managed OAuth allowlist 中使用 ChatGPT 连接页面实际显示的精确回调。不同 OAuth 服务可能使用不同回调；例如页面给出带 callback ID 的地址时，替换下面的占位值，不添加通配符：

```text
https://chatgpt.com/connector/oauth/<连接页面显示的callback_id>
```

同一主机接入多个 ChatGPT 账号时，复用匹配的 Worker、Tunnel 和 Access 应用。先保留并核对已有回调；新连接生成不同回调时才追加，生成相同回调则复用。ChatGPT 账号与 Access 登录邮箱分别核对，不因新增客户端账号扩大 Access 邮箱策略。每个账号分别完成 OAuth 和网页实际调用验收。

当前 `src/index.ts` 的 `allowedOriginHostnames` 显式包含 `chatgpt.com`，用于携带该 Origin 的请求。其他客户端是否需要不同来源，应按其请求与接入方式检查，不能从本场景的成功推导所有客户端已兼容。

完成本人登录并确认发现 `ssh_exec`。界面或回调规则变化时查看 [OpenAI 身份验证文档](https://developers.openai.com/plugins/build/auth)，不要扩大整个站点的回调权限来试错。

## 验收与历史证据

在启用该工具的网页对话中要求：

> 调用 Cloudflare SSH 的 ssh_exec，仅执行 whoami，timeout_seconds=15，展示实际 stdout、stderr、exitStatus，不执行其他命令。

预期账户与 `exitStatus: 0` 同时满足才通过。另一个客户端或直连 SSH 的成功不能替代这次网页调用。

2026-10-26，项目来源的个人部署完成了 **ChatGPT 网页端 → Managed OAuth → Worker → VPC Network → SSH 主机 → `whoami`** 验证，实际返回预期远程账户、空 stderr 和退出码 `0`。这是该部署与该客户端的历史结果，不代表新环境已验收。

请求及命令输出会由 ChatGPT/OpenAI 与 Cloudflare 处理；自行部署减少额外远程执行中转服务，不意味着数据全部留在本机。
