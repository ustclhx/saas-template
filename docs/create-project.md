# 从模板创建项目

在已安装 Node >=22 与本仓库 pnpm 版本的环境中，运行根目录 create-project 脚本。
无参数会询问项目名称、域名、目标目录、默认语言与功能开关。名称采用小写 kebab-case，
域名采用 HTTPS 主机名，语言支持 en、zh。目标默认是当前目录的同级项目目录
（`../<项目名称>`），必须是模板目录之外尚不存在的目录。

非交互示例（完整生成与自检）：

```sh
pnpm create-project --name acme --domain acme.example --target ../acme --locale zh \
  --ai text --features blog,waitlist --billing stripe --oauth google
```

默认开启文本、图片、视频、Stripe、PayPal、Google、GitHub 与 Turnstile，
可选功能仅开启 blog。列表传空字符串可全部关闭；交互时输入 `-` 可关闭列表。
`--turnstile false` 关闭 Turnstile，`--multi-tenant true` 启用团队空间，
`--support-email` 设置支持邮箱。完整参数见帮助命令。

默认生成后运行 frozen-lockfile 安装、typecheck 和 test；自检使用 CI 模式，清除调用者的
数据库连接环境变量，只验证单元测试，不访问模板数据库。`--skip-check` 仅生成，需自行补做
自检。失败时脚本返回非零状态并保留副本方便排查，不将部分自检报告为成功。

生成内容包含改名的包作用域、Worker / Queue / Workflow 名称、站点品牌、
`template.config.ts`、根目录及两个 app 的 `.dev.vars.example` 和 `PROJECT_SETUP.md`。
Hyperdrive / KV 的部署 ID 重置为零占位值，AI Gateway / R2 账号标识清空，所有环境都需配置新资源；
Rate Limiting 的 RL_AUTH / RL_AI / RL_API 命名空间需独立分配。Queue 名会同步到 jobs 消费者与测试。
FILES 桶按项目改名，R2_FILES_BUCKET 与绑定保持一致；文本模式也保留文件清理 Cron 所需的 FILES 桶。
清单按 AI、支付、OAuth 与 Turnstile 开关列出资源与密钥；关闭图片和视频时移除 Workflow 绑定，
清单不包含媒体服务商、Workflow 与媒体 R2 S3 密钥。
密钥模板只包含空值，APP_URL 使用公开默认地址，来自固定的变量名清单；脚本不读取本地真值生成模板。

PROJECT_SETUP.md 分别列出 Worker 配置与 GitHub staging environment secrets。
SENTRY_DSN 需要分别写入 web / jobs，SENTRY_ENVIRONMENT 设为 staging、production 或临时验收专用 smoke；
CI 的 SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT 仅用于 source map 上传。
APP_VERSION 与 Sentry release 使用同一个完整提交 SHA，CI 已负责注入；手动部署参考
[Sentry runbook](runbooks/sentry.md)。线上 secrets 需要通过 Wrangler 分别写入两个 Worker，
本地 .dev.vars 不会随部署上传。将 .github/workflows/deploy-staging.yml 中的 STAGING_URL
占位地址改为新环境实际可访问的 URL，并核对 staging APP_URL、邮件发件配置与数据库迁移凭据。

复制排除各级 `.git`、node_modules、`.env` / `.env.*` 和 `.dev.vars*`（保留 example）、
`.wrangler`、dist、`.turbo`、coverage、构建和测试生成目录、进行中的 `openspec/changes`、
探针 results、日志和证书私钥。符号链接不复制，二进制文件原样保留。
脚本不创建远程资源、不写入密钥；上线前按清单和 [基础设施文档](07-infrastructure.md) 配置，
另行验证数据库迁移、集成测试与 staging 端到端流程。

测试使用 Node 内置 test runner，在临时目录验证改名、真值排除、功能清单和路径边界，
无论成功或失败均清理测试目录；不向源树注入测试密钥。

完整副本验证使用 `pnpm test:create-project:verify`：从真实工作树生成临时项目，
逐文件确认模板原名称与排除目录不存在，再安装依赖并运行 typecheck 与单元测试，
结束后清理临时目录。该命令单独运行，避免日常边界测试重复安装完整依赖。

新库初始化时，先以 migrator 应用已有迁移，再将新库 app 连接通过进程环境传给
`pnpm billing:seed`（变量名为 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`）。
这条命令只写套餐示例，不调用支付服务，关闭支付的文本项目也需要套餐权益初始化。
在执行前编辑新项目 `packages/billing/src/catalog.ts` 的 free seed，将 `features.models`
显式配置为允许的模型 key 或标签；默认 `DEFAULT_FREE_FEATURES.models=[]` 不允许任何 AI 模型，
仅在后台新增模型和发积分仍会返回 403。当前后台没有套餐权益编辑入口，需要在新项目的 seed
配置中做此选择；不要为快速验收改模板默认策略。重新 seed 会覆盖示例套餐的配置，应只对明确
指定的新库执行。Neon staging 使用 TLS 直连与两个 Hyperdrive，不需要 Tunnel / Workers VPC
或自建库备份；实际部署顺序为迁移 → seed → jobs → web。

2026-10-12 临时 `saas-smoke` 部署验收已通过，临时云资源与本地副本已清理，
脱敏状态、ID 与界面观察见 [6.1 证据](runbooks/evidence/create-project/2026-10-12/acceptance.json)
及 [资源清单](runbooks/evidence/create-project/2026-10-12/resources.md)。
临时 jobs 删除前需先移除其两个 Queue consumer，否则 Cloudflare 会拒绝删除 Worker；
限流 namespace 为 Worker 绑定内的独立整数标识，清理时随临时 Worker 移除绑定。
