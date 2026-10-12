# A 8/9：Node 认证与 Compose 尾部验收

本轮仅处理 Node 认证 500 与 A 8.1、8.2、8.3、9.2、9.3；不勾选 ACME、C 存储/媒体、D 正式交付或 A 9.4。

## 认证修复

srvx 1.0.5 的惰性 NodeRequest 继承原生 Request prototype，但没有 Undici 内部槽。
Nitro 将 HTTP entry 与 Start SSR 分开打包；SSR 中 `new Request(input)` 不经过 srvx 的包装，
误认输入为原生 Request，读取内部 `window` 时抛错。最小生产回归先通过真实
`/api/auth/get-session` 得到 500，断言报 `reading 'window': expected 500 to be 200`。

Node HTTP entry 改为根据 URL、method、headers、body、signal 创建原生 Request，再附加请求
runtime 并交给 Nitro。保留 body 流与取消信号，不缓存正文。Cloudflare 入口没有修改。
生产回归覆盖 get-session、注册/登录的正常 Turnstile 拒绝、真实 sign-out 与旧会话失效；
另外保留 SSR、RPC、静态资源、无 DB 预渲染、AI 客户端断开与 SIGTERM 完整结算。
关闭 Turnstile 后的成功注册/密码登录由下述 Compose e2e 验证。

## 可重复的空卷验收

从本 worktree 根目录运行：

```sh
node deploy/selfhost/test-acceptance.mjs
```

脚本使用仓库外 0700 临时目录与随机测试 secrets、自签 CA；没有真实 Provider/staging 凭据。
根据 Git 跟踪清单复制源码，在临时构建副本将 multiTenant、requireEmailVerification 开启、
Turnstile/OAuth 关闭，不改根模板。Node 生产镜像仍使用正式 Dockerfiles 和完整提交 SHA；
这个模板变体是本地验收镜像，不作为正式发布镜像。匿名 Docker 配置使用当前 daemon，避免
读取宿主 Docker Hub 凭据；保留 BuildKit 和 Dockerfile 专用 ignore 语义。

正式 Compose 与测试 override 组合，所有服务/网络/卷以 `selfhost-final` 开头；仅 Caddy
发布 80/443。PG17、Valkey、一次性 migrate、web、真实 B jobs 均使用正式入口。
测试增加非 root capture 服务，仅在 internal data 网络监听 8025，不配置 host ports。
jobs 只读挂载测试 preload，将原 Resend sender 的 POST 定向到 capture，并剥离 Authorization。
原队列、渲染、幂等键和 ack 链路全部保留；不从数据库取验证 token，不向外部发信。
捕获正文仅在内存，Playwright 通过 `docker compose exec` 读取并解析，不写日志/trace/video。
Dockerfile ignore 显式排除捕获夹具，连 migrate 的源码镜像也不携带它。

脚本检查迁移成功依赖、配置和实际 UID，等待真实下一 UTC 五分钟 heartbeat，验证 TLS CA、
完整 readiness 200，执行 Playwright；停止 jobs/cache 验证 503，再重启依赖进程恢复连接。
创建数据后执行 down/up 保留卷，验证 PG 用户与 Valkey AOF 键仍在。最后向主进程 stdout
写非敏感 JSON，跨越 20k 日志阈值，核对实际 3 个日志文件和 requestId、无 secret 值。
只读日志 helper 仅挂载本任务 web 日志目录。所有验收服务均非 root；此短命 helper 用于
读取 Docker 自身日志目录。无论成功或失败，finally 执行 down -v 并删除临时 secrets。
不操作其他容器，不清理其他镜像/缓存。

## 隔离测试矩阵

本机使用独立 `selfhost-final-tests` PG17/Valkey，只绑定宿主 loopback 测试端口；它不是生产
Compose 拓扑。三角色和权限脚本与项目相同，连接配置只在任务临时目录/进程环境中。
业务/Node HTTP 使用一个 worktree 测试库；B engine、workflow、scheduler 和 jobs wire 分库，
避免不同注册集、历史队列及已存在的心跳污染初始断言。先业务 SQL 迁移，再 DBOS 迁移。
执行结束对该隔离 Compose 同样 down -v。

| 命令/范围 | 本轮结果 |
| --- | --- |
| pnpm check | 通过，Biome 与业务写入边界/脚本检查 |
| pnpm check:deps | 通过，7 项边界用例 |
| pnpm check:singletons | 通过 |
| pnpm dedupe --check | 通过 |
| pnpm typecheck | 14/14 通过 |
| pnpm test | 168 文件/1240 项，26/26 任务通过；22 任务复用未改变代码的缓存 |
| pnpm build | 默认 CF web/jobs 2/2 通过，18 页预渲染 |
| pnpm --filter @saas/web test:e2e:smoke | 1/1 通过，注册、真实退出/登录、本地支付 provider |
| pnpm build:node | Node web/jobs 2/2 通过，18 页无生产凭据预渲染 |
| pnpm --filter @saas/web test:node | 12 组/687 项通过 |
| pnpm --filter @saas/jobs test:node | 11 文件/44 项通过 |
| pnpm --filter @saas/web test:node:production | 1 文件/7 项通过 |
| pnpm --filter @saas/jobs test:node:integration | 2 文件/2 项通过，96.29 秒；真实 retry/DLQ、五分钟 heartbeat 与停机 |
| pnpm --filter @saas/platform test:job-engine | 待本轮结果 |
| TEST_WORKFLOW_LONG=1 pnpm --filter @saas/platform exec vitest run --config vitest.workflow.config.ts | 待本轮结果，包含真实 61 分钟用例 |
| TEST_SCHEDULER_LONG=1 pnpm --filter @saas/platform exec vitest run --config vitest.scheduler.config.ts | 10/10 通过，623.23 秒，含真实 601 秒心跳停摆 |
| node deploy/selfhost/test-acceptance.mjs | 待本轮结果 |

Node 聚合包含 config 33、AI 113、platform 基础 16、DB/credits 86、Valkey 3、auth 3、
billing 296、entitlements 14、web AI 50、public 29、files 拒绝路径 10、admin 34。
公共 shared/ui/email/storage 单元与 platform task-health 等由根 test 覆盖。

跳过/独立范围逐项说明：

- credits 单独 Node 命令不重复执行：DB Node 配置已经复用同一批账本与并发用例。
- B workflow/scheduler 的默认长测试开关均显式开启，本轮不跳过其真实时钟验收。
- CF adapter、workerd 邮件与 R2 用例仍在根 CF 测试中执行；不把 CF harness 的业务用例
  冒称已经逐项移植到 Node。Node 的验证邮件/退出/空间行为由生产 Compose 补齐。
- auth CPU probe 只测 CF CPU，默认未启用，不属于 Node 业务验收。
- C 的 Node S3/文件和媒体成功链路未交付，独立验收；本轮只验证缺能力时 503 且无预扣。
- 本轮首次 B engine/workflow 缺业务迁移导致 setup 失败；补齐隔离库正式业务迁移后重跑。
  jobs wire 首次复用了生产烟测库，已有 heartbeat 导致初始 503 断言失败；新建独立库重跑。
  CF smoke 首次未显式覆盖 cached Hyperdrive，数据库匹配保护拒绝启动；覆盖两绑定后通过。
  以上均修正测试环境，没有修改业务断言、时限或生产代码来掩盖失败。

## CI 与 staging 边界

`.github/workflows/ci.yml` 与 `deploy-staging.yml` 无修改。CF e2e-smoke 仍独立运行，
Node job 没有 staging secrets/部署步骤。staging 保持 main CI push 成功后触发，按完整 SHA
checkout，迁移 → jobs/web 发布 → health SHA 检查 → staging Playwright。

当前 main `30731bfdfef267a0841bd534e2349d1a7a61d197` 的
[CI 38288222594](https://github.com/ustclhx/saas-template/actions/runs/38288222594) 和
[自动 staging 38288882367](https://github.com/ustclhx/saas-template/actions/runs/38288882367)
均通过；只读请求 staging `/api/health` 返回 200，version 同为完整 `30731bfdfef267a0841bd534e2349d1a7a61d197`，lastCronAt 非空。这是本分支基线的证据，不能替代本 PR 合入后的 run/health。
本分支不手工部署 staging、不自行合并；8.3 要求本 PR 合入后的 main 自动 staging 与完整 SHA，
取得该证据前保持未勾选，由协调者合入后补验。
