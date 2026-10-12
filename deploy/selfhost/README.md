# 自托管 Compose（A 7.1–7.4）

本目录定义本机可验收的部署拓扑；GHCR、多架构发布、服务器部署、备份和 Dokploy 配置由 D 交付。Node 已装配真实 B 队列与 Cron。关闭 Turnstile、开启验证邮件与多租户的本地生产验收见 [A 8/9 runbook](../../docs/runbooks/selfhost-a-final.md)；正式邮件凭据由部署方提供。默认 Cloudflare 构建与 staging 流程保持原样。

## 镜像与启动

从仓库根目录构建，源码与基础镜像均锁定。`APP_VERSION` 必须为对应源码的完整 40 位小写 Git SHA；没有 Git 的归档必须显式提供它，不能使用短 SHA 或版本号。所有 `FROM` 都固定 digest；镜像不携带部署凭据。只有构建阶段使用 root；运行及数据初始化均非 root。

```sh
APP_VERSION=$(git rev-parse HEAD) bash deploy/selfhost/build.sh
```

脚本生成 `saas-selfhost/{web,jobs,migrate,postgres,valkey,caddy}:<full-sha>`，不推送镜像。`app.Dockerfile` 的三个生产 target 共用多阶段构建：web 保留完整 Nitro `.output` 与 SSR 所需生产依赖闭包，jobs 保留 ESM 与生产依赖闭包，migrate 保留已锁定的迁移工具、workspace TS 与既有 SQL。构建期无部署 dotenv/数据库，Debian 预渲染固定 IPv4 DNS 顺序；输出仍由 `pnpm build:node` 产生。`native-smoke` 是独立验收 target，使用同一 Debian/Node 运行层加载 sharp 原生扩展并编码 PNG，不加入生产依赖。

```sh
docker build -f deploy/selfhost/app.Dockerfile --target native-smoke \
  --build-arg APP_VERSION="$(git rev-parse HEAD)" -t selfhost-native-smoke .
docker run --rm selfhost-native-smoke
```

根 `.gitignore` 作为 Tailwind 扫描输入保留，避免生成目录改变 SSR/client 两次构建的 CSS URL。构建使用 Dockerfile 专用 `.dockerignore`，排除 Git、dotenv、`.dev.vars`、密钥/证书目录、开发依赖目录及生成产物。密钥不能通过 Docker ARG/ENV 或构建缓存传入；需要修改模板开关时先改 `template.config.ts` 并重新构建。

部署目录复制 `.env.example` 为 `.env`，填写同一完整 SHA 的镜像引用，以及公开 HTTPS URL/域名和集成 ID。D 发布可拉取的镜像后可直接填写它们；在此之前先构建本机镜像。按 `secrets.example` 创建单文件 secrets 与证书，随后在本目录执行：

```sh
docker compose config
docker compose up -d
docker compose ps -a
```

Compose 没有 `build:`。示例 `.env` 设置 `COMPOSE_PROFILES=caddy`，所以普通 `up -d` 会启用代理。只有 Caddy 映射宿主 80/443；PG、Valkey、web 和 jobs 都没有 host ports。`postgres` healthy 后 migrate 依次执行：

```sh
pnpm --filter @saas/db db:migrate
pnpm --filter @saas/platform dbos:migrate
```

pnpm CLI 与其平台原生 binary 在镜像构建阶段预装到非 root 可读的共享缓存；migrate 设置 `COREPACK_ENABLE_NETWORK=0`，不需要部署时下载包管理器。wrapper 仅接受 `MIGRATION_DATABASE_URL_FILE` 的 migrator、postgres 服务名、`sslmode=verify-full` 连接，拒绝本地默认连接与直接值。迁移 CLI 的原始输出可能含驱动配置，因此只输出固定 JSON 成功/失败事件。失败容器退出非零且 `restart: no`；web/jobs 仅在其成功退出以及 Valkey healthy 后启动。重跑失败迁移前应检查版本、secret、证书和迁移本身，再执行 `docker compose up -d`，不配置无限重试。

jobs 的 `JOB_EXECUTOR_ID` 默认 `jobs-1`，Compose 将 hostname 固定为同值，并把持久 `job_owners` 卷挂载到 `/app/.data/job-owners`。每个 executor 的 hostname/ID 必须跨重启稳定；不能通过更换随机 ID 或清除 owner 文件绕过启动拒绝。Linux owner 记录包含 PID、host、PID namespace inode、boot ID 和进程启动时间，容器重建后即使重用 PID 1 也使用这些身份核对旧 incarnation 是否退出；证明规则与 guard 处置见 [任务引擎 runbook](../../docs/runbooks/node-job-engine.md#连接轮询与-ownership)。

双 jobs 副本需分别声明不同且稳定的 hostname/ID，挂载同一 `job_owners` 卷，并使用同一版本的完整 handler 集与队列策略。当前 service 使用固定身份，不能盲目用 `docker compose up --scale jobs=2` 扩容；不同 hostname 的副本也不能为另一 executor 证明退出。本地真实发信、双副本停启与保留卷重建证据见 [A 8/9 runbook](../../docs/runbooks/selfhost-a-final.md)。

## 文件与权限

PG 的 bootstrap 超级用户仅分配给 postgres；app 密码仅用于初始化，app URL 仅分配给 web/jobs；migrator URL 仅分配给 migrate。readonly 不分配给应用，排查时从操作员独立 secret 文件读取。应用镜像只有默认 DML，不能 DDL；readonly 不能写；audit_log 保持只追加；DBOS/job_engine 迁移与授权由 migrator 完成。

PG 复用 `infra/local/initdb/01-roles.sql` 和 `02-db-grants.sql`。唯一共享改动是前者支持 psql 密码变量，同时保留本地开发默认值；生产初始化严格读取四个 `_FILE`，不使用这些默认密码。密码支持引号和空格，通过环境/getenv/psql 字面量转义传递，不放入 argv；空值、多行、直接值冲突会失败。初始化只在空卷执行，改变文件不会自动轮换已有角色密码。

| 服务 | 运行 UID:GID | 空 named volume |
|---|---|---|
| postgres | 999:999 | 镜像预置 data 0700；TLS 复制目标 0700；私钥 0600 |
| valkey | 999:999 | `/data` 0700，AOF 持久化；ACL 散列只在 tmpfs 中 |
| web / jobs / migrate | 1000:1000 | 应用文件归 node；jobs 的 `/app/.data/job-owners` 为 0700；无数据库/证书写卷 |
| caddy | 10001:10001 | `/data` 与 `/config` 镜像预置可写，证书/ACME 状态持久化 |

首次 named volume 通过镜像目录复制正确属主，不使用 root init 容器。jobs 镜像由 node（UID 1000）创建 0700 的 owner 目录，空 `job_owners` 卷继承该属主和权限，owner/guard 文件为 0600。已有卷必须预先匹配上述 UID；不要通过 root 入口在每次启动时修正。Compose file secrets 不转换宿主文件 UID/mode：宿主父目录使用 0700，secret 文件与只读证书挂载源必须让分配的容器 UID 可读。Linux 可按对应 UID/GID 设置权限；不把私钥开放到公共宿主目录。PG 入口每次以 postgres 用户将挂载证书复制到受限可写目录。

PG 拒绝全部非 TLS TCP 连接，TLS 要求 SCRAM。`certs/postgres/server.crt` 必须有 `DNS:postgres` SAN；`server.key` 为对应私钥；`certs/ca.crt` 是签发 CA/bundle。所有 Node 容器使用 `NODE_EXTRA_CA_CERTS=/run/certs/ca.crt` 和 `sslmode=verify-full`，同时验证 CA 与服务名。不要改为 `require`（postgres.js 会关闭证书验证），也不要将 `sslrootcert=/path` 塞入 postgres.js URL。外部 PG 修改服务名时需要同步证书与受控 migrator wrapper。

Valkey 密码通过 ACL SHA-256 文件加载，不进入命令行；web/jobs 共用命名空间。内部 data 网络不向宿主映射端口，Valkey 使用认证 redis 连接，当前没有配置 Valkey TLS。需要跨主机缓存时应由部署方配置受验证的 rediss 与 CA。`maxmemory 256mb`、`noeviction`，达到容量时显式失败；AOF everysec，缓存不取代 PG 账本。

## TLS 与代理

`CADDY_TLS_MODE=acme` 使用 Caddy 自动签发，需真实域名指向主机且公网 80/443 可达；容器只监听 8080/8443。`CADDY_TLS_MODE=supplied` 使用只读 `certs/caddy/server.crt` 与 `server.key`，证书必须覆盖 `APP_DOMAIN`；可用自签 CA 完成本机验收。正式环境不要关闭客户端证书验证。

Caddy 不信任外部转发链；它将 XFF 覆盖为实际 peer，并移除 CF-Connecting-IP 与 Forwarded。web 只信任专用 ingress 上的 Caddy 固定地址 `172.30.77.2/32`，不信任所有 Docker 网段。没有开启请求 access log，避免认证链接/query 进入日志；Caddy 自身日志为 JSON。

外部代理模式设置 `COMPOSE_PROFILES=`，通过 `docker network connect <project>_ingress <proxy-container>` 将受控代理接到本项目 ingress，并使用 `web:3000`。给代理固定地址，将 `TRUSTED_PROXY_CIDRS` 设置为它的确切地址或受限子网；显式空值表示完全不信任转发头；代理同样必须覆盖客户端转发头。外部代理不接 data 网。Dokploy/Traefik 的外部网络、label、域名与证书由 D 配置，本 Compose 不声明 Dokploy 专有设置；接入后仍使用同样的迁移 gate 与 secret 隔离。

Caddy 配置依据官方 [global options](https://caddyserver.com/docs/caddyfile/options) 与 [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。Valkey ACL/认证依据官方 [security](https://valkey.io/topics/security/)；这些资料不替代本仓库固定镜像的实测结果。

## 资源、探活与停止

默认 CPU 配额总计 2 核；常驻服务内存上限合计约 3.25 GiB，migrate 额外 512 MiB。PG 最大连接100，web/jobs 各池10，迁移使用独立低并发连接；调整池预算时保留运维余量。每个 service 包含健康检查、资源上限、restart、日志轮转和45秒停止宽限期。应用 shutdown 默认30秒，必须小于容器 grace；增大 `SHUTDOWN_TIMEOUT_MS` 时同步修改 grace。

Docker `json-file` 的 `LOG_MAX_SIZE=10m`、`LOG_MAX_FILE=3` 可调。应用与迁移输出脱敏 JSON；PG/Valkey 保留官方 stderr 格式，由 Docker 包装和轮转。只有 Caddy profile 有公开入口。内部 `/internal/live` 仅用于容器进程探活，B 缺失不触发重启循环；外部 `/api/health` 实时检查 DB/cache/queue/scheduler，返回完整 SHA 与 `lastCronAt`。所有依赖正常且有有效成功心跳时返回 200；启动尚无心跳、依赖故障或消费者/调度器停摆时返回 503。容器 healthy 只说明进程存活，不能代替该 readiness。

初轮镜像与尚未通过的 ACME 项见 [A7 验收记录](../../docs/runbooks/selfhost-a7.md)，完整健康与认证尾部验收见 [A 8/9 runbook](../../docs/runbooks/selfhost-a-final.md)。停止保留数据用 `docker compose down`；仅删除隔离验收数据时才使用 `down -v`。
