# 新加坡服务器验收：1888e7d

**当前阻塞：B 6.4 的短 sleep 恢复用例在整机2 vCPU下仍超过原断言上界；未执行 reboot。**
61分钟长用例、队列/调度、ACME、R2及备份恢复分别有通过证据，不能据此把整个 workflow 套件称为通过。
原断言、业务代码、已发布镜像与 bundle 均未修改；下方保留失败、对照实验与待协调者决定的具体夹具补丁。

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
| 恢复只读身份 | 另建两个桶级只读 token，本桶 List/Get 成功，跨桶/Put/Delete 均403，合计五个独立身份 | [只读权限](permissions-readonly.json) |
| delivery 7.2 | 通过：真实 R2 每日 slot、额外完整备份周期、保留配置、主/仅副本只读身份同点 PITR 与逻辑恢复 | [备份摘要](backup-summary.json)、[状态](backup.json)、[保留计划](retention.json)、[R2 配置](r2-settings.json)、[逻辑材料](logical.json)、[逻辑恢复](logical-restore.json)、[主桶只读 PITR](restore-main-readonly.json)、[副本只读 PITR](restore-replica-readonly.json)、[只读挂载](restore-replica-readonly-audit.json) |
| job-engine 6.4 调度/队列部分 | 调度器10/10、队列/引擎14/14通过，包括真实601秒停止心跳、六次重试及双worker限额 | [调度器](scheduler.json)、[队列](queue.json)、[重试时间轴](queue-timeline.json)、[双worker](permits.json) |
| job-engine 6.4 workflow | 首轮10/11，真实61分钟长例通过；短恢复用例失败，三次定向对照仍失败，保持未勾选 | [首轮](workflow-first.json)、[长例实测](workflow-proof.json)、[前](workflow-before.json)/[后](workflow-after.json)快照、[失败及CPU对照](workflow-recovery-failures.json) |
| delivery 7.1、7.3 | 正式部署/版本/readiness通过；资源签收随B6.4暂缓，按前置门未执行真实reboot | [部署](deployment.json)、[资源](resources.json)、[结束状态](blocked-final-state.json) |
| foundation 9.4、delivery 7.4 | 已提交需求矩阵，但B6.4/服务器尾项未通过，不提前代协调者签收 | [需求矩阵](matrix.md) |

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
16:15:37–16:18:24 UTC 完整 cycle 退出码0；未修改系统时钟。持续 WAL 和每 300 秒校验/副本同步启用。
新环境只有两份真实 full base；保留计划保留两份，并如实列出前三周缺失的 weekly 锚点。
四周历史保留机制沿用 [已签收的正式镜像隔离演练](../d-drill-2026-10-15/report.md)，
本次不伪造四周真实运行历史。主桶 35 天锁、副本数据前缀永久锁，仅有未完成 multipart 的 7 天清理，
无按对象年龄删除 WAL 的生命周期规则。永久副本会持续增长，不能把当前磁盘/对象体积外推为长期容量保证。

最终两次只读身份物理恢复都使用初始 `base_000000010000000000000004`，显式目标
`2026-10-16T16:13:44.140506Z`。前标记存在、后标记不存在，真实 DBOS PENDING/checkpoint、
持久等待、已完成调度、文件数据、角色/约束/积分共 15 项通过；相同 replay LSN `0/1005AC40`，
最后重放事务时间 `16:13:44.131461 UTC`，不把该事务时间称为精确 wall-clock 目标。
恢复校验 RTO 主桶 29.045 秒、副本 30.589 秒；只包括数据库新卷、获取/重放及检查，
不含应用恢复与切入口。两个恢复身份均只有 List/Get，没有 Put/Delete；副本恢复挂载仅有其两个只读 secret 文件，token 对主桶 List 为 403，
不依赖主桶完成恢复；主桶服务仍正常运行，未人为破坏它。

备份状态记录的一次同步滞后为 103.028597 秒，`backup-summary.json` 保留连续恢复上界、
完成时间与采样时的链龄；这是实际观测，不是最坏 RPO/SLA。逻辑备份独立下载后按 manifest
大小/SHA 校验，使用正式 PG 镜像恢复 roles 与 custom dump 到禁网、仅 Unix socket 的新卷，
11 项业务/任务/约束/权限检查通过，耗时 7.541 秒。逻辑恢复包含后标记，体现完整 dump 快照，
不将其宣称为连续 PITR。所有恢复均未启动 web/jobs 或任何外部业务副作用，并清理了自己的临时卷。

首次物理恢复使用了同步写入身份，其15项数据校验有效，但恢复身份权限高于 runbook 所需。
复核后另外创建两个只读身份，实际验证跨桶及 Put/Delete 拒绝，再以原版入口完整重做两次恢复。
首次报告 [主](restore-main.json)/[副本](restore-replica.json) 保留为初次演练记录；
最终签收及 RTO 采用上面的只读报告，备份写入/同步身份仍独立保留，不授予恢复实例。

## 夹具修正及测量范围

- aaf8299 的 S3 文件名门问题已由 #237 修复，旧失败记录保留在 [前次尝试](../server-acceptance-2026-10-16/attempt-aaf8299.md)。本轮只消费新正式1888e7d，没有修改原始 bundle。
- 首次1888e7d配置的副本secret basename与Compose不符，按受审文件名修正受限配置后重跑原始入口；诊断导入产生的本 worker Python cache 已删除，并重新通过 bundle verify。
- 首轮集成夹具先修正读取权限，再补上正式要求的只读宿主machine-id挂载；使用新隔离r2库重跑原始套件。未删除生产owner记录、放宽 ownership 校验或修改测试断言/时钟。
- JSON reporter 不保留 console 时间轴；重试时间在套件结束前直接只读SQL采得，双worker原用例在新隔离r3库用verbose reporter补测。长workflow另保留数据库前后快照。
- 存储配额边界用合成占用行构造；实际对象为3/4字节与8MiB copier，没有上传5GiB对象。采集流水线使用原测试的受控替身，没有调用真实Provider；本轮不宣称生产最大并发或吞吐能力。

## B 6.4 阻塞与拟议修正

首轮原始 workflow 套件11项无跳过，10项通过、1项失败。长例耗时3675.357646秒，
早到事件从16:12:15.175164到17:13:27.290579 UTC实际保留3672.115415秒，
18个callback均各一次、15个业务效果、7个原sleep及原wait deadline不变，native最终SUCCESS。
后续正常新增了 `early-event` 等待记录，不把新等待的deadline误认为旧等待被延长。

失败是 `workflow.integration.test.ts:438` 的 `Date.now() < originalDeadline + 1000`：
同用例此前的PENDING保留、完成输出、原sleep checkpoint相等断言已通过；这个时间断言失败后，
同用例后半段的副作用/checkpoint故障窗口没有继续执行，因此B6.4不能签收。

| 原用例执行 | 临时测试容器CPU上限 | 超出原上界 | 结果 |
| --- | --- | --- | --- |
| 首轮并行完整套件 | 0.5 | 2161ms | 10/11，1失败 |
| 独立新库r3、同用例 | 0.5 | 2121ms | 失败 |
| 独立新库r4、同用例 | 1 | 685ms | 失败 |
| 独立新库r5、同用例 | 2 | 297ms | 失败 |

整机始终2 vCPU；只调整临时测试进程配额，正式服务配额、源码、时钟、断言都未改变。
这些是事实；“2秒原sleep的剩余窗口被graceful drain和冷Node/TS模块启动消耗”仍是待验证解释，
不以它为理由豁免失败。定向报告：[0.5 CPU](recovery-cpu05.json)、[1 CPU](recovery-cpu1.json)、[2 CPU](recovery-cpu2.json)。

[拟议单行补丁](proposed-workflow-fixture.patch)仅将该夹具的初始sleep从2秒变5秒，
使恢复进程有机会在原deadline前完成冷启动；原deadline下界、`+1000ms`上界、checkpoint相等、
callback次数和副作用幂等断言全部保留，重置整个5秒sleep的错误仍会被捕获。
该补丁只通过 `git apply --check`，**未应用、未声称通过**，需协调者确认后复验。
没有重新请求reboot授权；原授权仍有效，但“先完成6.4”这一前置条件未满足。

## 整机资源与停在阻塞时的状态

采样16:00:16–17:21:25 UTC共669点，覆盖部署/迁移活动、外部存储、并行套件、完整备份、
主/副本恢复、61分钟等待及三个短恢复对照。实际物理内存3495.14MiB，宿主机2 vCPU。

| 指标 | 实测 |
| --- | --- |
| 最低MemAvailable | 1392.742MiB |
| selfhost及测试容器工作集合计峰值 | 1456.86MiB（Docker working set，不冒称精确RSS） |
| 最低空闲磁盘 | 7.7639GiB |
| 整机CPU / p95 / 加权均值 | 99.106% / 70.713% / 28.359%（100%为全部2核） |
| 主PG最大连接 | 44/100；最终21 |
| idle in transaction | 瞬时最大2（事务可见性测试），最终0 |
| WAL目录占用 | 32MiB→224MiB；额外累计生成量见pg_stat_wal |
| OOM | 宿主计数0；采样的验收容器OOM计数0 |

正式常驻单jobs加backup的内存上限合计3712MiB，加第二jobs为4480MiB；这些是单服务上限，
不是预留，也不能保证同时打满仍适合此主机。内存/磁盘有实测余量，但短恢复时间界限未通过，
不以低均值CPU或长sleep期间的空闲掩盖这一限制，不宣称整机预算全部验收完成。

完整原始采样：[resources.jsonl.gz](resources.jsonl.gz)，SHA256见[汇总](resources.json)；
[分钟/极值观测](resource-samples.json)、[采样代码](resource-sampler.py)、[汇总代码](resource-summary.py)、
[cgroup峰值/RSS观测](memory-events-blocked.json)、[各隔离库引擎体积](engine-footprints.jsonl)、
[累计WAL统计](pg-stat-wal.json)可复核。RSS快照会重复计共享页，退出子进程不计入该快照；
cgroup峰值与Docker工作集分开列出。

停止等待协调者前，只结束了本worker的采样PID和临时第二jobs/probe；原始日志、专用测试库、
镜像与数据均保留。正式6个常驻服务均healthy，公开health仍为完整1888e7d，
备份服务保持运行。已有其他服务未重启，整机reboot没有执行。
