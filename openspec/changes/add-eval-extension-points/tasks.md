# Tasks

并行说明：改动集中在 `packages/evals/src/runner.ts`，按顺序在一个分支内完成；第 4 组文档可与第 3 组并行起草。

## 1. 被评正文转换与生成耗时

- [x] 1.1 `suite.ts`：`SuiteDefinition.prepareOutput?: { version, run }`，`defineSuite` 校验版本为非空短标识、`run` 为函数（design D1）。验证：`suite.test.ts` 覆盖缺版本、非函数被拒绝。
- [x] 1.2 `models.ts`：生成录制增加可选 `durationMs`，评委录制增加可选 `prepareVersion`（design D2、D3）。验证：旧录制（无新字段）仍能读取；示例套件回放测试不变。
- [x] 1.3 `runner.ts`：生成后执行 `prepareOutput`（校验返回、双跑比对），失败记 `prepare-error` 计入失败；检查与评委使用被评正文；评委 `outputHash` 绑定被评正文，`prepareVersion` 写入并参与过期判定；真实 / 录制模式测量生成与评委耗时，回放读取录制耗时；样本结果增加 `prepared` 与 `usage.*.durationMs`。验证：`runner.test.ts` 新增——原文含可修正错误时检查与评委收到同一修正文、生成录制保留原文（record 模式模拟模型捕获评委请求）；hook 抛错 / 返回非字符串 / 不可重复各记 `prepare-error` 且退出码 1；转换版本变化或被评正文变化时旧评委录制判 `stale-recording`；录制模式写入 `durationMs`、回放读取录制值；全程零网络调用。
- [x] 1.4 `report.ts`：配置 hook 时写 `outputs/<id>.txt`（改变时另写 `.raw.txt`），`report.md` 列出转换版本、改变与 annotations、生成耗时。验证：单测断言文件存在与内容、未配置 hook 时不写 `outputs/`。

## 2. 评测后聚合门槛

- [x] 2.1 新增 `assess.ts`：`percentile`（最近秩）、`mean`、`collect(group, ids, pick)`，并从 `index.ts` 导出相关类型（design D6）。验证：`assess.test.ts` 覆盖最近秩 P95（如 20 个值取第 19 个）、空集合为 null、缺样本与缺值进入 `missing`。
- [x] 2.2 `suite.ts` / `runner.ts`：`evaluateRun` 契约（design D4），构造候选组与基线组（同次回放或旧报告宽松解析），校验返回；异常或不合法时记 `evaluate-run` 失败门槛；`EXIT.gates = 5`，failed 或 required incomplete 时计入，取最小非零码（design D5）；报告增加 `assessment`、`scope` 与 `summary.expectedScores`（design D7）。验证：`runner.test.ts` 用固定录制覆盖需求文件 §2 验收 1–6 与 §3——一维下降 0.11 失败 / 恰好 0.1 通过、accuracy 3.9 失败 / 4.0 通过、P95 token 与录制 `durationMs` 等于上限通过超过失败、缺样本 / 缺分数 / 缺时长判 incomplete、筛选范围写入报告与 ctx、评委非法 JSON 时门槛 incomplete 且退出码为 1、回退与门槛同时出现时退出码 4、非必需 incomplete 不影响退出码、hook 抛错退出码 5。示例门槛数值只出现在测试夹具中。
- [x] 2.3 `report.ts` / `cli.ts`：`report.md` 增加 Scope 与 Gates 小节，`EXIT_MEANINGS` 与命令行用法增加退出码 5，终端汇总列出门槛结果。验证：`cli.test.ts` 或 runner 测试断言报告文本包含门槛与范围；`--help` 列出退出码 5。

## 3. 兼容与验收

- [x] 3.1 未配置 hook 的示例套件行为不变：`pnpm --filter @saas/evals test`、`pnpm --filter @saas/evals typecheck`、`pnpm check`、`pnpm check:deps` 通过；`pnpm eval:prompts --suite example --baseline product-intro@v1` 以 0 退出，报告 `assessment` 为 null。

## 4. 文档与升级说明

- [x] 4.1 `docs/06-ai.md`「提示词版本与评测」：`prepareOutput` 与 `evaluateRun` 的契约、执行顺序、失败语义、录制字段、统计辅助、退出码 5、评委不自动重试。验证：文档示例与导出 API 名称一致（typecheck 覆盖的示例代码片段手工核对）。
- [x] 4.2 起草 `docs/upgrades/0.5.3.md`：无迁移、无部署变化；两个扩展点用法与迁移示例（旧脚本「转换后检查与评委」改为 `prepareOutput`，「逐维差值、绝对分、P95」改为 `evaluateRun` + `collect` / `percentile`），旧录制补 `durationMs` 的说明。验证：`node scripts/template-release.mjs check` 通过。
