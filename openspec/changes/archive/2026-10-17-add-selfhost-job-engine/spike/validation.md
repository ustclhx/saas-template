# 验证记录

基线：A #107，main `8c21cd20a48e0db3a696681a14b57766397d78d5`。B只修改本change的规划与证据，原型不进入合并，无root lockfile或业务代码改动。

| 命令 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | 通过，lockfile up to date |
| `pnpm check` | 通过，Biome及工程边界测试，无fix |
| `pnpm check:deps` | 通过，含新platform包及规则测试 |
| `pnpm check:singletons` | 通过，Drizzle/React各唯一实例 |
| `pnpm dedupe --check` | 通过，现有3项deprecated subdependencies提示 |
| `pnpm typecheck` | 14/14任务通过，13项复用cache，platform新检查实际执行 |
| `pnpm test` | 25/25任务通过，最新基线21项复用cache，其余实际执行；web53文件293用例通过 |
| `pnpm build` | 2/2通过，最新基线串行重跑，web实际构建、jobs复用cache |
| `pnpm exec tsc -p spikes/job-engine/tsconfig.contracts.json` | 通过；复制A正式中立接口与contracts.ts，验证本地ports.ts业务面签名，运行时原型不import业务实现 |
| `openspec validate add-selfhost-job-engine --strict` | 通过，最终文档收敛后再复核 |

上述root检查均在rebase到A #107后执行。原型运行固定Linux Node22.22.2；root检查使用本机满足仓库>=22要求的Node23.11.0。不配置外部凭据，不部署分支到staging。构建通过不能替代Node全套/服务器/staging部署验收。

## 运行证据与保留的失败

- `dbos.json` / `boss.json`：初轮共同driver；boss保留RPC重启打断和误用active update导致30s固定退避的失败，不改其失败断言。
- `*-postchecks.json`：原deadline不延长、queued早事件、终态拒绝、已有skip运行恢复。历史单项end字段在await前记录，不能计算用例耗时；整体start/end及数据库状态/断言有效。
- `*-extras.json`：实际两个worker竞争、独立outbox-only发布器退出88、成功批次成员各1次/崩溃消息最终确认、截止后事件不误消费。
- `*-retry-recheck.json`：修正后六次真实重试，30/60/120/240/480s下界均通过，attempts=6且有DLQ。900s为配置上限，5次重试不会动态达到，不宣称实测900s等待。
- `*-formal-contract.json`：任意字符串workflow ID、Date event、linear100/200/300ms退避、重复create不重复成功callback。
- `*-drizzle-transaction.json`：实际Drizzle/postgres.js transaction，保持未提交6秒、提交、回滚；原子可见性/零执行通过。
- `*-pipeline.json`：最终真实采集链路，完成后归档并据此勾1.7/1.8；第一桥接实验中止记录单独保留。
- `*-upgrade.json` / `permissions.json`：固定前版本升级/重复迁移、app无schema CREATE与readonly拒写；未证明跨代码版本热重放。

生产Node adapter、清理/fencing/完整readiness、CF业务移植、本地全服务与新加坡服务器验收仍在2–6，不因spike通过提前勾选。A资源预算建议见resource-budget.md；1.10必须协调者确认。

10:16:05控制器旧PID复用错误触发本实验PG自动恢复，首次观察器错误见boss-pipeline-observer-error.json；业务workflow检查点未丢，按原身份重新挂接观察器，不重提任务。最终pipeline报告保留observerFailures与failed/reattached时间轴，不能把首次观察器退出改写为通过。已核对PID指向实际node可执行文件/worker ID，后续只在确认原进程退出后接续。

`*-retention.json`只证明自有inbox手动SQL保留期可行性：清除终态24h以前的合成旧事件，active同龄事件保留；真实早到事件未改写。这不是生产自动清理验收，2.5仍未完成。

最终rebase基线升级至main923453624507c4440ebdab32dc694239473f3961（含A #109），正式接口仍为#107签收版本；必需root检查在该基线复跑。

最新基线的首次CF build与typecheck/test并发，Paraglide生成目录竞争，出现messages/_index.js缺失。保留失败原因；在所有生成检查结束后串行重跑build，不改业务代码或放宽检查。串行重跑2/2任务通过，web实际构建7.266s，jobs复用cache。

最终采集两候选passed=true：DBOS3706704ms/事件3706679ms；pg-boss3716550ms/事件3716514ms。成功步骤各1次，effect-window2次callback但仅1个业务结果，10条队列任务各1次，合计并发2、滑动10s启动2≤3，归并总数10。1.1–1.8已完成；1.9缺A整机预算对齐，1.10缺协调者审阅确认。
