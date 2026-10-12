# B spike 证据索引

执行日：2026-10-12。只使用本地 Docker，不连接云服务、共享 staging 或现有业务数据库。原型、独立依赖与 lockfile 位于 worktree-local `spikes/job-engine/`，不进入本 PR；原型单独归档：[固定快照](https://github.com/ustclhx/saas-template/tree/b5109e29b231849205867195892974aa919e5fc8/spikes/job-engine)，分支 `archive/selfhost-b-job-engine-20261012`，只作复现存档，禁止合并。

- `versions.json`：固定发行版本、npm gitHead、PG 镜像 digest、依赖许可、原型 SHA256。
- `dbos-LICENSE.txt` / `boss-LICENSE.txt`：固定 npm 包携带的 MIT 许可证原文。
- `dbos.json` / `boss.json`（初轮共享driver，原始失败保留）：同一 driver 的逐项断言、任务 ID、批量规模、尝试时间、工作进程启停、步骤调用计数与资源快照。
- `permissions.json`、`dbos-upgrade.json`、`boss-upgrade.json`：重复初始化、前版本升级、CREATE/TEMP/ALTER拒绝与只读查询。
- `resources.jsonl`：共享 cgroup 的 Docker CPU/内存/PID 快照。
- `validation.md`：仓库检查与已知限制。

## 复现入口

原型目录自包含 `CONTRACT.md`、`common.mjs`、`worker.mjs`、`driver.mjs`、候选 adapters、共享 scheduler 和独立 package-lock。从归档commit恢复 `spikes/job-engine/`（或在该archive分支的checkout）后，先 `npm ci --prefix spikes/job-engine --ignore-scripts`；升级实验分别在 `upgrades/dbos`、`upgrades/boss`执行各自npm ci。使用其独立依赖安装，不执行根目录 add/install，不 import 业务代码。Node 固定为 Linux arm64 22.22.2，运行在已有 `postgres:17` 镜像内；Node Docker 镜像拉取停滞，因此从 npm 固定 `node-linux-arm64@22.22.2` 获取运行时。PG 与 Node 共同受同一个 Docker cgroup 的 `--cpus 2 --memory 4g` 限制。

启动独立 PG17 容器/网络，无宿主端口；实验使用仅该容器内可达的 trust 连接，不生成密码或连接串。建立 `dbos_spike`、`boss_spike` 两个隔离数据库与 `app`/`readonly` 角色。复制原型到容器 `/spike`，在 `/spike` 执行：

```sh
# 两个 candidate 分别执行；仅迁移使用 postgres，运行使用 app。
PGHOST=localhost PGDATABASE=dbos_spike PGUSER=postgres CANDIDATE=dbos runtime/bin/node worker.mjs migrate
PGHOST=localhost PGDATABASE=boss_spike PGUSER=postgres CANDIDATE=boss runtime/bin/node worker.mjs migrate
# migrator 授予引擎 schema 的 app DML / readonly SELECT，撤销 app TRUNCATE/REFERENCES/TRIGGER。
PGHOST=localhost PGDATABASE=dbos_spike PGUSER=app CANDIDATE=dbos runtime/bin/node driver.mjs
PGHOST=localhost PGDATABASE=boss_spike PGUSER=app CANDIDATE=boss runtime/bin/node driver.mjs
```

初轮driver每候选启动两个jobs子进程；后续pipeline/extras通过容器loopback RPC控制同一对worker，初轮controller结束后guardian只在已确认旧PID退出时接续所有权，以稳定 worker ID 重启，使用完全相同的 workflow 与队列业务替身。最终 `pipeline.mjs` 的持久sleep合计 `3665000ms`，加上真实队列详情处理，完整时长在1–2h内；创建后即可发早到事件。初轮main driver与定向extras/Drizzle/linear/retry脚本也在归档中；外部事件在任务创建后发送，中途强制重启。结果只包含模拟消息、计数、UTC 时间和进程元数据，不包含邮件/真实 API payload。

## 证据解释

通过必须来自运行断言和数据库状态，官方文档、语法检查、设计假设均不能替代。原型补齐能力单独标明；共享 scheduler 的结果只能证明本地补齐方案，不能宣称为候选原生 cron 的全部能力。整机资源仍需与 A 的 web/cache/代理预算对齐；本 cgroup 测量不包含尚未交付的这些服务。

原始/修正报告及复现控制器入口：`driver.mjs` → `postchecks.mjs` / `extras.mjs` / `formal-check.mjs` / `drizzle-check.mjs` / `retry-check.mjs` → `pipeline.mjs`；长跑读取原instance检查点，观察器错误可用 `pipeline.mjs --resume`重新挂接；`guardian.mjs`只接续已核实退出的worker，不能只凭旧PID操作。进程身份核验修正见design失败记录。

最终主报告还包括 `*-pipeline.json`、`*-retry-recheck.json`、`*-formal-contract.json`、`*-drizzle-transaction.json`、`*-extras.json` 与 `*-postchecks.json`；这些脚本必须各自实际执行，不以类型夹具或旧失败报告替代。`resource-budget.md`为A待确认预算建议；最终资源与时间/计数汇总见 `resource-summary.json`。第一桥接流水线中止报告单独保留，不用于勾选1.8。
