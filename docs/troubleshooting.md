# 按错误定位

先记录失败阶段与脱敏错误，再选择对应行。只读检查应针对同一账户、Worker 版本、Tunnel 与用户；不要把另一个环境的成功当作证据。关键链路失败即停止该次验收，完成相关修复后再运行只读验收。

| 实际症状 | 优先核对 | 修复范围与继续条件 |
| --- | --- | --- |
| 发布报权限不足或 10196 | 当前发布身份、账户、profile、VPC binding 权限 | 读 [发布权限](setup.md#5-wrangler-授权与首次部署)；解释具体缺项，在授权范围补齐后重试发布 |
| deployments API 返回 No access to the specified resource | Worker scripts 权限，不只看 `workers:write` | 本次补齐 `workers_scripts:write` 后成功；不要因此更换目标账户或申请全部权限 |
| `connect(...).then is not a function` | 是否为旧版源码/部署；运行时 binding 返回值 | 当前 `src/ssh.ts` 用 `Promise.resolve()` 兼容 Socket/Promise；有代码修改授权时修复旧版并发布，否则报告版本差异 |
| TCP/SSH 超时或连接关闭 | Tunnel 在线、connector 目标与网络命名空间、QUIC/版本、出站 UDP 7844、回环 22 监听 | 读 [SSH](setup.md#1-核对-ssh-服务) 与 [Tunnel](setup.md#3-核对或配置-tunnel)；恢复同一私网目标可达后重做只读验收 |
| 公钥认证失败 | `SSH_USER`、公私钥配对、实际 `AuthorizedKeysFile`/`Match`、文件权限 | 读 [专用密钥](setup.md#2-核对或配置专用密钥)；保留其他公钥，不以放开密码或目录权限替代修复 |
| 主机指纹不匹配 | 可信管理入口中的 Ed25519 主机公钥是否更换 | 先解释差异；确认真实目标并获得相应授权后才更新 pin，不能直接跳过校验 |
| OAuth 登录循环、401、回调失败或工具不可发现 | Access 主机范围、Managed OAuth、实际回调、邮箱策略、AUD/团队域名、`/mcp` URL | 读 [Access 配置](setup.md#6-配置-access-与-managed-oauth)；保留身份校验，修正同一应用配置后重新连接 |
| 请求携带 `Origin` 时被拒绝 | `src/index.ts` 的 `allowedOriginHostnames` 与实际客户端来源 | 按场景说明核对；需修改时仅增加获准的准确来源，重新部署后从同一客户端验证 |
| grant 到期后要求登录 | OAuth grant 状态及生命周期 | 在现有授权范围内重新登录；不是 SSH 密钥过期，不因此生成新 SSH 密钥 |
| 工具返回非零状态或输出不符 | 实际 exitStatus、远程默认 shell、当前命令的目录与参数 | 使用匹配语法；stderr 单独非空不判失败，截断检查 `truncated`，不自动重复修改类命令 |
| 公网 SSH WebSocket 返回 403 / `cf-mitigated: challenge` | 是否仍在使用旧的公网 HTTP/WebSocket 路径 | 核对代码与 VPC binding；当前实现用私网 TCP，不通过关闭 Bot Fight/WAF 消除挑战 |

## 区分凭据与协议层

MCP 客户端持有 Managed OAuth token；Cloudflare 向 Worker 转发 `Cf-Access-Jwt-Assertion`，由 `src/auth.ts` 验证。Worker 的专用私钥另用于 SSH 登录。不要混用 OAuth bearer、Access 断言、Tunnel token 与 SSH 密钥。

OAuth discovery、注册和换 token 由边缘 Managed OAuth 提供，Worker 只实现 `/mcp`。没有合法 Access 断言的直接 Worker 请求会被拒绝；这种结果不能证明客户端 OAuth 配置成功或失败。

## 超时与重试

TCP 建连和 SSH 握手各有 15 秒超时；`timeout_seconds` 控制命令执行阶段，整次调用可能更久。每次调用是新会话，目录和环境不保留。

超时、断线或客户端报错不能证明命令未执行。修改类操作先查远端状态；发布或创建资源的响应不明时先查资源状态。只有状态明确后才决定重试或继续，避免重复执行。
