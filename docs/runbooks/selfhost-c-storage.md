# C 1.4：Node 文件接线验收与 B 交接

Node 配置通过 `nodeStorageConfig` 映射 `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_FORCE_PATH_STYLE` 和两个显式凭据，交给 `createNodeStorage`。完全未配置时 files/downloadFile unavailable，部分配置拒绝启动；预渲染不读取密钥或创建客户端。两个凭据支持固定 `_FILE` allowlist。端点必须同时被服务端和浏览器访问，不能在签名后改 Host、协议、路径或 query；生产使用 HTTPS。

web 装配 files 与 downloadFile，jobs 只注入所需删除能力，`string|string[]` 在 composition 逐 key 桥接。只有装配后才执行既有十分钟文件清理；删除失败保留数据库锚点供下一轮重试。

## 本地真实 HTTP 验收

先构建当前 Node web 产物，再运行隔离 runner：

```sh
pnpm --filter @saas/web build:node
node apps/web/scripts/test-node-storage.mjs
```

runner 要求本机已有 `postgres:17`、`valkey/valkey:8.1.6-alpine`、`chrislusf/seaweedfs:4.48` 镜像。禁止自动拉取，缺镜像明确失败。创建名称含 `selfhost-c-wire-storage` 的三个专用 Docker 容器，只映射随机 loopback 端口，随机生成本次 PG 三角色密码、Valkey 密码和 S3 凭据。通过 stdin 或临时文件传入，不输出真值；退出、失败和 SIGINT/SIGTERM 清理本次容器和临时目录，不碰既有 worktree 资源。迁移只应用仓库已有 SQL，不生成迁移。

`storage-http.node.ts` 启动 `.output/server/index.mjs` 真实生产进程，沿用认证 HTTP fixture 的实际 Better Auth 会话，验证：

- 声明上传 → 预签名条件 PUT → HTTP 确认 → attachment 下载，重复确认只计一次。
- 实际大小与声明不符拒绝确认，对象不可下载；删除故障留下 pending 墓碑，清理失败保留，恢复后删除对象与记录。
- 真实 S3 的小对象并发确认竞争同一空间剩余配额，只有一个成功。已用大额配额以数据库 fixture 表达，不生成大文件。
- 跨租户、失效会话与撤销分享返回 404，不发出新的下载签名。
- storage ready 而媒体 workflow 未装配时，真实 `/api/ai/tasks` 返回 503，task/hold 计数不变。
- `/server/index.mjs.map` 与 `/index.mjs.map` 不公开。

同一 runner 复用既有 `features/files/http.test.ts` 的守卫和错误响应回归。S3 协议完整安全矩阵继续由 `pnpm --filter @saas/storage test:node:s3` 负责；此 HTTP runner 不重复虚拟主机 DNS/TLS、multipart 或签名篡改矩阵。

## C → B 5.3/5.4

C 的交付是 `createNodeStorage(config)`、`createNodeMediaCopier(config)`、中立 `Storage` / `MediaOutputCopier` 以及文件 HTTP/清理能力。B 5.3 将两工厂注入既有 `persistMediaOutputs`，保留确定性 key、pending/ready、实际字节、空间锁、重放和失败清理。B 5.4 接媒体工作流的 create/status/sendEvent/terminate 后才能开放媒体提交；workflow gate 与存储 gate 独立。

本批不移植媒体 workflow、不修改 B 勾选。真实本地 PG/Valkey/S3 通过只证明协议与 Node 接线；外部 R2/第二兼容服务联通、浏览器 CORS、自带 object-storage profile 的持久化与全栈资源预算仍需相应独立验收，不在此记录提前通过。
