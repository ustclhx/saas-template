# Bundle 运维入口

仅使用受信 Actions 发布成功的 `image-set.json` / 同 SHA bundle。校验 checksum 用于传输
完整性；不替代来源核实。先校验源 SHA、发布 run、所有镜像两架构、namespace/revision。
首次真实 GHCR 发布需用户授权；本地 fixture 不能用于服务器。

1. 在明确选择的**空白** Ubuntu24.04 / Debian12 amd64/arm64 上，单命令运行
   `sudo ./init-server.sh --dir /srv/saas-selfhost`。已有主机只使用经审阅的既有 Docker / 入口，
   不运行空白初始化。初始化不部署应用或安装 Dokploy。
2. 部署目录0700，`.env`0600。复制本 bundle `.env.example`，填写域名、APP_URL和公开集成
   ID；依据 `secrets.example` 准备角色/认证 file secrets 和验证证书。PG SAN 为 postgres，
   app/migrator URL必须 verify-full；应用只拿 CA。不要输出或提交密钥，不将密码放命令行。
   secrets 挂载需让指定非root UID读取，父目录仍受限。
3. 本机执行 `./deploy.sh --local --dir /srv/saas-selfhost --sha <full-sha> --bundle <bundle-dir>`；
   从操作员电脑执行 `./deploy.sh --host <explicit-user@host> --dir /srv/saas-selfhost
   --sha <full-sha> --bundle <local-bundle-dir>`。SSH须已有可信 host key 与非交互身份。
   脚本校验并串行拉取→旧app排空→强制目标 migrate→启动→公开health及jobs版本检查。
   默认 readiness 窗口360秒覆盖首次五分钟成功心跳；失败返回非零。
4. 默认 Caddy profile 处理80/443。外部代理设置 `COMPOSE_PROFILES=`，仅web连接已有专用
   ingress，用 `--compose-file compose.proxy.yaml`，指定 `EXTERNAL_INGRESS_NETWORK` 及
   每个确切代理 `/32` 或 `/128`。PG/Valkey/jobs不连接代理网，不新增宿主端口。
   代理覆盖不可信XFF并移除CF/Forwarded；最终渲染必须检查，Dokploy只选择web:3000。
5. 可选 backup 用 `--compose-file compose.backup.yaml --env-file .env.backup`，该 env0600、
   独立备份file secrets/CA只给PG和backup。可选自带对象服务使用
   `--compose-file compose.object-storage.yaml --env-file .env.object-storage`，env含
   `COMPOSE_PROFILES=object-storage`；bucket init也必须成功后才启动应用。
6. release-state保留上一成功版本和最后迁移SHA。失败不自动回滚；兼容性审阅后执行
   `./deploy.sh --local --dir /srv/saas-selfhost --rollback <previous-success-sha>`（SSH换成
   `--host <explicit-host>`）。最后迁移release必须显式声明目标兼容，包括schema、DBOS
   handler/checkpoint和长任务版本；应用回滚不会降低数据库schema或执行旧migration。
   不兼容时恢复匹配PG17备份到**新空卷**，暂停jobs/外部副作用、核对业务/角色/任务状态、
   明确promote及入口切换。restore/drill入口尚未交付，交协调者完成恢复runbook与签收；
   不删除旧卷或ownership文件，不改DBOS内部表。

空间预检仅是部署目录至少2GiB余量；还需核对Docker data-root及PG/WAL/备份实际容量。
成功app health不代表备份成功。B/D退出证据签收、整机恢复、真实registry/公网TLS/Dokploy
和独立备份资源验收尚待协调者确认，禁止将本地机制测试当作服务器验收。
