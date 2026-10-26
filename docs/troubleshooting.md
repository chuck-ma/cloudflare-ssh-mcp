# 实践中的故障与定位

## 公网 SSH WebSocket 返回 403 / Just a moment

早期验证通过公网 SSH 子域名建立 HTTP WebSocket。实际响应含 `cf-mitigated: challenge`，意味着 HTTP 层要求浏览器挑战，SSH 尚未建立。服务端 MCP 调用不能把这类 HTML 页面当作 SSH 字节流。

最终实现改为 Worker 的 VPC Network 原始 TCP，直接进入目标主机的 Tunnel，再访问 `127.0.0.1:22`。已验证无需关闭站点 Bot Fight Mode。OAuth 仍保护公网 MCP 入口，SSH 仍使用专用密钥和主机指纹校验。不要为了这条链路直接关闭整个站点防护。

## 发布报权限不足 / 10196

检查发布时使用的账户和授权 profile。VPC Tunnel binding 需要 `Connectivity Directory Admin`，只具备 Worker 发布权限时会被拒绝。

本次实践中，仅授予 `workers:write` 又遇到 deployments API 的 `No access to the specified resource`；补齐 `workers_scripts:write` 后发布成功。复现用的完整 Wrangler OAuth scope 命令见 [搭建指南](setup.md#5-wrangler-授权与首次部署)。

用 `--profile ssh-mcp-vpc` 显式指定独立配置；不要以为新建 profile 后所有已有命令都会自动使用它。

## connect(...).then is not a function

本次实际 Workers 运行时的 `SSH_VPC.connect()` 直接返回 Socket，而非 Promise。直接调用 `.then()` 会在进入 SSH 握手前失败。

源码用 `Promise.resolve(env.SSH_VPC.connect(...))` 统一处理同步/异步返回。TypeScript 与打包都不能证明运行时 binding 的行为；修复后通过实际插件调用和 ChatGPT 网页端验证。

## 私网连接超时或关闭

依次检查目标 Tunnel 在线、connector 所在机器正确、cloudflared 版本和 QUIC、出站 UDP 7844，以及目标 SSH 服务正在监听 `127.0.0.1:22`。目标地址是 connector 自身的回环地址；如果 connector 跑在另一台机器上，就无法访问目标主机的回环 SSH。

本项目将 TCP 建连与 SSH 握手超时分别设为 15 秒；工具的 `timeout_seconds` 控制命令执行阶段，因此整次工具调用可能比该参数更久。

## SSH 公钥认证失败或主机指纹不匹配

检查 `SSH_USER`、Worker Secret 的完整私钥，以及公钥是否进入该用户实际生效的 authorized-keys 文件。OpenSSH 的 `AuthorizedKeysFile` 与适用的 `Match` 规则可能改变文件位置，应检查有效配置。

主机指纹不匹配时，先通过可信管理入口检查服务端的 Ed25519 主机公钥是否更换，再决定是否更新配置。不要关闭主机校验。

## OAuth 登录循环、401 或重定向失败

检查 Access 应用是否覆盖 MCP 主机名、Managed OAuth 是否开启、redirect URI 是否与 ChatGPT 实际地址匹配，以及邮箱策略、`OWNER_EMAIL`、`ACCESS_AUD`、团队域名是否一致。

Worker 仅提供 `/mcp`，OAuth discovery/注册/换 token 由边缘 Managed OAuth 提供。直接绕过 Access 调用 Worker，或者缺少合法 `Cf-Access-Jwt-Assertion`，会被拒绝。

短 access token 过期一般由 refresh token 续期；grant session 到期或撤销后需要重新登录。它不意味着 SSH 密钥过期。

## 命令没有结果或返回非零状态

先用 `whoami` 等只读命令验证。SSH 使用远程用户的默认 shell，命令语法须与之匹配；需要特定解释器时显式调用。工作目录不跨调用保留，需要在同一命令中切换目录再执行。

不要看到 stderr 就判定失败，应读取 exitStatus。截断时查看 `truncated`。超时、断线或错误并不保证命令未执行，修改类操作应先通过只读查询确认状态，不要自动重试。
