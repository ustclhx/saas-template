# 新加坡服务器验收：1888e7d

本次使用获授权的 `product-res-ecs`、`selfhost.ezarouter.cc` 与三个 selfhost 专用 R2 桶。
正式发布 SHA 为 `1888e7d165b0b87784e7d16a4c39709a9bc063e3`，来源是
[selfhost-publish 38924583361](https://github.com/ustclhx/saas-template/actions/runs/38924583361)。
分支已基于包含 #237 的 main；服务器只消费该 run 的原始 release bundle 和固定 digest，未构建业务镜像。

| 分配项 | 当前结果 | 证据 |
| --- | --- | --- |
| foundation 7.4 | 通过：真实受信 ACME 签发；同正式 Caddy 镜像、独立 staging 状态实际续期；恢复原入口后证书指纹一致 | [签发及 health](deploy-acme.json)、[续期](acme-renewal.json)；既有自带证书/XFF 证据见 selfhost-a7 runbook |
| storage-observability 1.7 | 通过：真实 R2 业务/SDK、条件上传、短期附件下载、配额与授权、清理重试、未知长度 multipart copier | [业务及 SDK](storage.json) |
| storage-observability 1.7 浏览器 | 通过：真实 Chromium 从应用 origin 发起 OPTIONS/PUT/GET/HEAD，响应头可见，未授权 origin 被拒 | [浏览器](browser.json) |
| R2 token 隔离 | 三个独立 bucket-scoped object read/write token 各自本桶成功、六次跨桶访问均 403 | [权限矩阵](permissions.json) |
| delivery 7.2 | 通过：真实 R2 每日 slot、额外完整备份周期、保留配置、主/仅副本同点 PITR 与逻辑恢复 | [备份摘要](backup-summary.json)、[状态](backup.json)、[保留计划](retention.json)、[R2 配置](r2-settings.json)、[逻辑材料](logical.json)、[逻辑恢复](logical-restore.json)、[主桶 PITR](restore-main.json)、[副本 PITR](restore-replica.json)、[副本挂载](restore-replica-audit.json) |
| job-engine 6.4 调度部分 | 调度器 10/10 通过，包括真实 601 秒停止心跳；队列与 61 分钟工作流继续运行 | [调度器](scheduler.json) |
| delivery 7.1、7.3；job-engine 6.4 其余部分 | 正式部署已成功；长时任务、资源预算与真实整机 reboot 继续验收，未提前勾选 | [部署](deployment.json)，后续批次追加 |
| foundation 9.4、delivery 7.4 | 完整矩阵与协调者签收待后续批次 | 未提前勾选 |

存储夹具通过实际 auth handler 创建合成测试身份及有效会话，公网认证保护未改变。
实际对象的匿名请求返回 R2 的 `400 InvalidArgument`，未返回对象内容；允许 origin 的预检是 204。
不把本地兼容端点的特定状态码套用到 R2。测试过程中修正了夹具的带凭据跨源请求和预检状态码预期，最终实际浏览器链路通过。

范围遵守已合并的 R2 用户决定：主备份与副本位于同一 Cloudflare 账号、不同桶、不同受限 token，
失去供应商独立性，存在账号级共同故障风险。未宣称第二供应商或独立账号容灾。
本次不验收真实邮件、OAuth/Turnstile 凭据、支付、AI 调用或首管理员；这些集成尚未配置。
生产 Cloudflare 与 staging 未修改；既有其他服务的容器、数据、卷及镜像均保留。

本批本地验证：`pnpm check`（既有 4 条 warning）、`pnpm typecheck`（14/14，缓存命中）、
备份 Python 单测 24 项、部署 11 项、bundle 8 项及 foundation/storage-observability 的 OpenSpec strict validate 通过。
证据只保留状态、时间、版本、证书公开元数据与固定测试结果，不包含凭据、连接串、会话或预签名 URL。

## 备份与恢复的实际边界

首次启动按真实日期补做 `2026-10-16T02:00:00Z` 每日 slot，随后显式执行一次完整 cycle，
16:15:37–16:18:24 UTC 非零失败次数为零；未修改系统时钟。持续 WAL 和每 300 秒校验/副本同步启用。
新环境只有两份真实 full base；保留计划保留两份，并如实列出前三周缺失的 weekly 锚点。
四周历史保留机制沿用 [已签收的正式镜像隔离演练](../d-drill-2026-10-15/report.md)，
本次不伪造四周真实运行历史。主桶 35 天锁、副本数据前缀永久锁，仅有未完成 multipart 的 7 天清理，
无按对象年龄删除 WAL 的生命周期规则。永久副本会持续增长，不能把当前磁盘/对象体积外推为长期容量保证。

两个物理恢复都使用初始 `base_000000010000000000000004`，显式目标
`2026-10-16T16:13:44.140506Z`。前标记存在、后标记不存在，真实 DBOS PENDING/checkpoint、
持久等待、已完成调度、文件数据、角色/约束/积分共 15 项通过；相同 replay LSN `0/1005AC40`，
最后重放事务时间 `16:13:44.131461 UTC`，不把该事务时间称为精确 wall-clock 目标。
恢复校验 RTO 主桶 32.164 秒、副本 36.645 秒；只包括数据库新卷、获取/重放及检查，
不含应用恢复与切入口。副本恢复挂载仅有其两个 secret 文件，token 对主桶 List 为 403，
不依赖主桶完成恢复；主桶服务仍正常运行，未人为破坏它。

备份状态记录的一次同步滞后为 103.028597 秒，`backup-summary.json` 保留连续恢复上界、
完成时间与采样时的链龄；这是实际观测，不是最坏 RPO/SLA。逻辑备份独立下载后按 manifest
大小/SHA 校验，使用正式 PG 镜像恢复 roles 与 custom dump 到禁网、仅 Unix socket 的新卷，
11 项业务/任务/约束/权限检查通过，耗时 7.541 秒。逻辑恢复包含后标记，体现完整 dump 快照，
不将其宣称为连续 PITR。三次恢复均未启动 web/jobs 或任何外部业务副作用，并清理了自己的临时卷。
