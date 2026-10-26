# 从零配置到 ChatGPT 执行 whoami

本指南对应单用户、单台 Windows 的实现。各产品界面可能更新，操作时以当前账户页面显示为准。仓库不自动改动 Windows、Access 策略或 Tunnel。

## 1. 准备 Windows OpenSSH

Windows 上安装并启动 OpenSSH Server。已有 SSH 服务时沿用现有配置，不要覆盖原来的密钥和访问策略。相关官方操作见 [Microsoft OpenSSH 安装指南](https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse)。

以管理员身份检查：

```powershell
Get-Service sshd
Get-Content "$env:ProgramData\ssh\sshd_config"
ssh-keygen -lf "$env:ProgramData\ssh\ssh_host_ed25519_key.pub" -E sha256
```

记录并通过可信管理连接核对 Ed25519 主机指纹，填入 `SSH_HOST_KEY`。不要通过关闭主机校验解决连接问题。

本实现连接 `127.0.0.1:22`，确保 sshd 监听这个地址或包含该地址的监听范围。本次验证环境的 sshd 仅监听回环地址，采用公钥认证、禁用密码认证，并限制允许登录的用户。若修改已有 sshd，先确认不会影响现有管理入口。

## 2. 准备专用 SSH 密钥

在可信管理电脑生成专门供 Worker 使用的 Ed25519 密钥；不要上传自己的日常管理私钥。以下为 macOS/Linux 示例，密钥保存在仓库之外：

```sh
mkdir -p ../cloudflare-ssh-mcp-secrets
ssh-keygen -t ed25519 -f ../cloudflare-ssh-mcp-secrets/id_ed25519 -N '' -C cloudflare-ssh-mcp
```

把 `.pub` 公钥通过已有管理连接追加到 Windows 实际使用的 authorized-keys 文件，保留原有公钥。常见位置：

- 普通用户：用户目录下的 `.ssh/authorized_keys`。
- `sshd_config` 含 `Match Group administrators` 的管理员用户：通常为 `C:\ProgramData\ssh\administrators_authorized_keys`。

以实际 sshd 配置为准。管理员公钥文件应仅允许 SYSTEM 与 Administrators 等 sshd 要求的主体访问；不要通过放宽整个目录权限解决认证失败。参阅 [Microsoft OpenSSH 密钥管理](https://learn.microsoft.com/windows-server/administration/openssh/openssh_keymanagement)。

Worker 读取未加口令的私钥，其副本必须妥善保存。本项目不实现私钥口令交互。

## 3. 准备 Windows Tunnel

在 Cloudflare 创建或复用 Windows 上的 Tunnel，记录 UUID，填入 `vpc_networks[0].tunnel_id`。同一 Tunnel 的多个 connector 应具有一致的目标语义；此项目使用回环地址，因此应确认请求实际会落到目标 Windows 电脑。

Windows 的 `cloudflared` 应作为持续运行的服务保持在线。VPC 要求版本至少 `2025.7.0`、使用 QUIC，并允许出站 UDP 7844。已有兼容 Tunnel 可直接复用。安装与连接参数使用控制台提供的命令，Tunnel token 不写入仓库。详见 [Workers VPC 的 Tunnel 配置](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/)。

这里使用 **VPC Network** 直接绑定 Tunnel，并连接其 `127.0.0.1:22`。不需要为这条 Worker → SSH 链路新建公网 SSH 子域名或 HTTP/WebSocket ingress；也不需要新增供它使用的 Linked App Token 策略。已有交互式 SSH 的域名和策略可以独立保留。

## 4. 安装依赖并填写配置

```sh
npm ci --ignore-scripts
cp wrangler.example.jsonc wrangler.local.jsonc
```

填写 README 配置表中的值。多 Cloudflare 账户时，可在 `wrangler.local.jsonc` 增加 `account_id` 以明确目标账户。Worker 名称改变后，`PUBLIC_ORIGIN` 必须同步更新。

先为 `OWNER_EMAIL` 填写本人邮箱。Access 应用建立前可以保留空 `ACCESS_AUD`；此时所有 MCP 请求都会被拒绝。首次部署可用于取得 Worker 地址，再建立 Access 应用，填写 AUD 后重新部署。

## 5. Wrangler 授权与首次部署

仓库固定 Wrangler `4.151.2`，使用 `npx wrangler` 避免系统全局版本干扰。创建独立发布授权配置：

```sh
npx wrangler auth create ssh-mcp-vpc --scopes account:read user:read workers:write workers_scripts:write connectivity:admin
```

完成浏览器授权后：

```sh
npm run check
npm run deploy -- --profile ssh-mcp-vpc
```

本次实践中 `workers:write` 单独不足以访问 Worker deployments API，加入 `workers_scripts:write` 后发布成功。直接绑定 Tunnel 的 VPC Network 还需要 `connectivity:admin`。这些是部署端的权限，不交给 ChatGPT；VPC 管理权限作用于账户资源，并非只针对一个 Worker。

若采用自己管理的 API token，请按对应产品权限配置；不要把 Wrangler OAuth scope 名称当作 API token 权限名直接照填。

## 6. 为 MCP 入口配置 Access 与 Managed OAuth

在 Zero Trust 的 Access Applications 为 Worker 建立 MCP server 应用，并绑定它实际使用的主机名。策略仅允许本人邮箱登录；不要使用 Everyone/Bypass。若使用 Worker preview URL，也要保护或关闭该入口。

在 Advanced settings 开启 Managed OAuth，启用所需客户端动态注册并限制 redirect URI：

- 以 ChatGPT 应用管理页面显示的准确回调地址为准。
- 本次配置使用过 `https://chatgpt.com/connector_platform_oauth_redirect` 及 `https://chatgpt.com/connector/oauth/*`；新连接应按实际回调需要选择，不要无条件开放整个站点。
- 仅供网页端使用时，无需允许任意 localhost / loopback 客户端。

本次部署采用 15 分钟 access token 和 1 个月 grant session。有效 grant 内可以刷新 access token，grant 到期或被撤销后需要重新登录。这与 SSH 密钥独立，不是每月重新生成 SSH 密钥。设置含义见 [Managed OAuth 官方说明](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)；ChatGPT 身份验证要求见 [OpenAI 官方说明](https://developers.openai.com/plugins/build/auth)。

复制该 Access 应用的 Audience 到 `ACCESS_AUD`，确认 `ACCESS_TEAM_DOMAIN` 正确。Cloudflare 将客户端 OAuth token 解析为用户身份，并向 Worker 注入 `Cf-Access-Jwt-Assertion`；本项目验证这份 JWT，不把 OAuth bearer token 当作 SSH 凭据。

## 7. 上传专用私钥并发布最终配置

```sh
npm run secret:ssh -- --profile ssh-mcp-vpc
```

在终端的 secret 输入提示中粘贴第 2 步专用私钥的完整内容，保留 OpenSSH 头尾与换行。不要把私钥放进 `vars`、README、提交或聊天消息。然后发布最终配置：

```sh
npm run deploy -- --profile ssh-mcp-vpc
```

## 8. 接入 ChatGPT 并验收

在有自定义 MCP 权限的 ChatGPT 账户中，进入应用/插件管理的自定义 MCP 创建入口（部分账户需先开启开发者模式），配置：

- 名称：例如 Windows SSH。
- MCP URL：`https://<自己的 Worker 主机名>/mcp`。
- 认证：OAuth，通过 Managed OAuth discovery/动态注册连接。

完成本人身份登录，确认能发现 `ssh_exec`。具体账户是否提供入口及权限以当前 ChatGPT 界面为准。然后在启用该工具的对话中输入：

> 调用 Windows SSH 的 ssh_exec，仅执行 whoami，timeout_seconds=15，展示实际 stdout、stderr、exitStatus，不执行其他命令。

验收应得到实际 Windows 用户、`exitStatus: 0`。TypeScript 通过、打包成功或 Worker 已部署，都不等于这条链路已打通。若关键链路失败，按 [排障指南](troubleshooting.md) 定位后重新验收。

## 撤销

移除 Windows 上该项目专用公钥，可以撤销其 SSH 登录。移除 Worker 的 `SSH_VPC` binding，可以停止其 Tunnel 网络访问。禁用 MCP Access 应用或本人策略，可以停止客户端调用；撤销 OAuth grant 可要求客户端重新登录。日常交互式 SSH 的配置独立管理。
