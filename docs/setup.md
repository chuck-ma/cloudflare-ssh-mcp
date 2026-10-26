# 部署流程

供智能体配置单用户、单台 SSH 主机。每阶段先检查已有状态，仅执行缺失的、已获授权的操作；成功条件未满足时保留当前状态，按具体错误处理。

## 0. 核对输入与已有资源

优先从用户指定的本地配置、Cloudflare 账户与已有管理连接读取。无法确定账户或目标资源时再询问；不在多个账户间试写。

| 输入 | 写入位置 / 核对方式 |
| --- | --- |
| Cloudflare 账户、发布凭据/profile | 多账户时在本地配置显式设置 `account_id`；确认当前身份有目标账户权限 |
| Worker 名称及 HTTPS origin | `name`、`PUBLIC_ORIGIN`；origin 无路径、无末尾斜杠 |
| Zero Trust 团队域名与本人邮箱 | `ACCESS_TEAM_DOMAIN` 不含 `https://`；`OWNER_EMAIL` 与 Access 策略一致 |
| 目标 Tunnel UUID 与 connector | `vpc_networks[0].tunnel_id`；connector 与 SSH 服务处于同一网络命名空间 |
| SSH 登录用户与可信 Ed25519 主机指纹 | `SSH_USER`、`SSH_HOST_KEY`，后者格式为 `SHA256:...` |
| 专用 SSH 密钥状态与现有管理途径 | 仅需知道存放位置、公钥指纹与是否已安装，不把私钥放进上下文 |
| MCP Access 应用及 Audience | `ACCESS_AUD`；尚未创建时在第 6 阶段取得 |
| 客户端、OAuth 能力与回调地址 | 使用用户指定的 MCP 客户端，核对 Streamable HTTP、Managed OAuth 接入能力与实际回调 |

**成功条件：** 目标账户、主机、用户和允许修改的资源已明确；已有匹配资源可复用。缺少私网 SSH 访问条件时，先处理第 1–3 阶段，不以公网暴露替代。

## 1. 核对 SSH 服务

确认目标服务已启动、允许指定用户使用 Ed25519 公钥登录、提供 `ssh-ed25519` 主机密钥，监听范围包含 connector 所在网络命名空间的 `127.0.0.1:22`。记录该用户默认 shell，后续命令使用相应语法。

通过已有可信管理途径核对主机公钥指纹，例如：

```sh
ssh-keygen -lf /path/to/ssh_host_ed25519_key.pub -E sha256
```

路径按目标服务实际配置替换。修改或安装 SSH 服务仅限用户授权范围，保留既有管理入口。本次来源部署只监听回环地址；这是部署选择，不应机械覆盖其他主机的监听配置。

**成功条件：** 目标监听与算法满足当前源码约束，`SSH_USER` 和 `SSH_HOST_KEY` 已确定。指纹不符或来源不可信时，停止 SSH 验证并查明原因。

## 2. 核对或配置专用密钥

优先复用明确属于本项目的专用密钥；不要替换为用户日常管理私钥。需要新建且已获授权时，选择仓库之外的未使用路径，例如本地 shell：

```sh
mkdir -p ../cloudflare-ssh-mcp-secrets
ssh-keygen -t ed25519 -f ../cloudflare-ssh-mcp-secrets/id_ed25519 -N '' -C cloudflare-ssh-mcp
```

若文件已存在，检查身份和用途，不能覆盖。当前实现读取未加口令的 OpenSSH 私钥。

通过已有管理连接检查目标用户实际生效的 authorized-keys 文件。OpenSSH 常用 `.ssh/authorized_keys`，但 `AuthorizedKeysFile` 与适用的 `Match` 规则可能改变位置。按公钥内容检查是否存在，缺失时追加，保留原有条目与正确的所有者/权限。

**成功条件：** 同一专用公钥只安装一次；知道私钥的受保护存放位置；主机校验与用户认证分别核对。

## 3. 核对或配置 Tunnel

复用指向目标主机的 Tunnel，并读取 UUID 和 connector 状态。VPC 要求 `cloudflared` 至少 `2025.7.0`、使用 QUIC、允许出站 UDP 7844；详情见 [官方 Tunnel 要求](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/)。确需新建时使用控制台提供的安装方式，不展示包含 Tunnel token 的完整命令。

本项目使用 **VPC Network** 直接绑定 Tunnel，不使用面向公网的 SSH HTTP/WebSocket 路由。connector 必须与目标 SSH 处于同一网络命名空间；同一 Tunnel 有多个 connector 时，每个可能接收请求的实例都必须满足目标条件。

**成功条件：** 选定 Tunnel 在线、connector 目标正确且满足 VPC 要求。若 connector 位于另一台主机/隔离容器，不能假设其 `127.0.0.1` 指向 SSH 主机。

## 4. 准备本地配置

```sh
npm ci --ignore-scripts
```

仅在 `wrangler.local.jsonc` 不存在时从 `wrangler.example.jsonc` 复制；存在时读取并核对，按需要合并字段，不覆盖已有部署值。填写第 0 阶段映射的非秘密参数。私钥不放入 `vars`。

首次创建 Access 应用前，允许暂留空 `ACCESS_AUD`；`src/auth.ts` 在 AUD 或邮箱为空时拒绝所有 MCP 请求。更新已有部署时，保留已核对的 AUD，避免不必要的中断。

```sh
npm run check
npx wrangler deploy --dry-run --config wrangler.local.jsonc
```

`check` 只检查示例配置和类型；第二条命令检查实际本地配置能否打包。两者都不证明账户权限、Tunnel 可达或 OAuth 正确。

**成功条件：** 本地配置与目标资源一致、无模板占位值（新部署的空 AUD 除外）、打包成功；敏感文件不进入提交。

## 5. Wrangler 授权与首次部署

读取现有发布身份与权限，足够时复用。仓库固定 Wrangler `4.151.2`，使用本地 `npx wrangler`。以下是本次验证过的独立 OAuth profile 示例；profile 名称可替换，已有可用凭据无需重复授权：

```sh
npx wrangler auth create ssh-mcp-vpc --scopes account:read user:read workers:write workers_scripts:write connectivity:admin
```

直接绑定 Tunnel 需要 `Connectivity Directory Admin`。本次仅有 `workers:write` 时 deployments API 拒绝访问，加入 `workers_scripts:write` 后成功。这些是发布端权限，不交给 MCP 客户端；OAuth scopes 与 API token 权限名不可直接互换。权限不足时说明具体缺项，遵循用户授权和所用工具的确认要求。

```sh
npm run deploy -- --profile ssh-mcp-vpc
```

profile 参数使用实际选定名称。首次发布可先保留空 AUD 以取得 Worker 地址；已有 Worker 直接继续配置核对，按需要发布，不为同名部署再建一个 Worker。

**成功条件：** 目标账户中的 Worker 已存在；发布时有明确版本结果且实际 binding 为目标 `SSH_VPC` Tunnel。新建情况下确认其 origin 并回填 `PUBLIC_ORIGIN`；此时仍未完成端到端验收。

## 6. 配置 Access 与 Managed OAuth

读取覆盖 MCP 主机名的 Access 应用，匹配时复用；缺失时在授权范围内创建 MCP server 应用。策略仅允许 `OWNER_EMAIL` 对应身份，保护实际使用的生产/预览入口。保留不属于本项目的应用与策略。

开启 Managed OAuth，按所选客户端需要配置动态客户端注册和回调 allowlist。回调必须来自该客户端实际连接页面或官方配置，不将某个客户端的地址写成通用默认值；参考 [场景索引](../README.md#使用场景)选择相关接入说明。仅在客户端确实需要时允许 localhost/loopback 回调。

grant session 和 access token 生命周期按当前用户选择配置；15 分钟 access token、1 个月 grant 是本次部署实例，不是实现要求。grant 有效时可刷新 token，到期或撤销后需重新登录，与 SSH 密钥周期独立。

将实际应用 Audience 填入 `ACCESS_AUD`。客户端提交 OAuth token，Cloudflare 向 Worker 注入签名的 `Cf-Access-Jwt-Assertion`；Worker 校验这份断言。OAuth discovery、注册和换 token 由边缘提供，Worker 只实现 `/mcp`。

**成功条件：** 读取已保存的应用确认主机、策略、Managed OAuth、回调与 AUD 一致，本地配置指向该应用。界面或客户端规则有变化时查 [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) 及所选客户端的官方身份验证文档，不要盲目扩大回调匹配范围。

## 7. Secret 与最终发布

先检查 Worker 是否已有 `SSH_PRIVATE_KEY` 及其来源记录。已确认与第 2 阶段公钥配对时保留；来源不明时不能根据 secret 名称断定已配对。需要安装或更换时，经用户授权，使用受保护文件/输入通道上传专用私钥：

```sh
npm run secret:ssh -- --profile ssh-mcp-vpc
npm run deploy -- --profile ssh-mcp-vpc
```

替换为实际 profile。保持 OpenSSH 私钥头尾与换行，不回显或输出 secret 值。若怀疑已泄露，报告并按授权撤销/更换，不把它作为普通连接错误重试。

**成功条件：** 所需 secret 已配置，最终部署包含正确的非空 AUD、邮箱、origin、主机指纹与 VPC binding，并已记录部署版本。

## 8. 从指定客户端验收

使用用户指定的 MCP 客户端，复用已有且匹配的服务连接。缺失时配置 `https://<自己的 Worker 主机名>/mcp` 与 OAuth，按客户端支持的注册方式完成本人登录，并确认发现 `ssh_exec`。

若请求携带 `Origin`，还需核对 `src/index.ts` 的 `allowedOriginHostnames` 是否允许该客户端。当前源码保留了已验证场景的显式白名单，不代表所有浏览器来源都可直接接入；需要修改时在代码授权范围内增加准确来源并部署，不使用通配放开方式。场景特定设置只在对应场景文档中维护。

从选定客户端调用：

```json
{"command":"whoami","timeout_seconds":15}
```

**通过条件：** 这次真实工具调用返回预期远程账户、`exitStatus: 0`，并记录实际 stdout、stderr。预期账户来自第 0 阶段，不能只看返回了任意字符串。stderr 单独非空不决定成败。

认证、工具发现、连接或命令失败均使该次验收失败；不可达则报告未验收。转入 [排障表](troubleshooting.md)，修复相关问题后重新执行只读验收。不得以直连 SSH、其他 MCP 客户端或历史部署结果替代用户指定入口。

## 按需撤销

仅撤销用户指定的资源：移除本项目专用公钥可停止该密钥登录；移除 Worker 的 `SSH_VPC` binding 可停止其 Tunnel 访问；禁用本项目 Access 应用/策略可停止客户端接入；撤销 OAuth grant 可要求重新登录。复用的 Tunnel 或日常管理凭据不能随项目撤销而直接删除。
