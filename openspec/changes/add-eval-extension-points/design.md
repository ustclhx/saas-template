# Design

## Context

`packages/evals/src/runner.ts` 的 `runSample` 依次执行：生成（回放读取录制并包装成固定模型）→ `runChecks(output.text)` → `judgeMessages(output.text)` → 汇总。评委录制以 `promptSha256(output.text)` 为 `outputHash`。`finish()` 汇总并以 `compareBaseline` 判总分回退，退出码取非零码中的最小值（1 失败、3 预算、4 回退）。需求来源见 proposal；需求文件中的门槛数值属于项目，本设计不内置。

## Goals / Non-Goals

**Goals:**
- 两个扩展点只管理执行时机、证据与退出码，不含任何领域规则。
- 缺数据一律可被项目判为 incomplete：模板传全量结果，提供带缺口列表的收集辅助。

**Non-Goals:**
- 评委自动重试（默认不重试已满足需求；以后需要时另立变更）。
- 逐组合分组键、项目门槛预设、历史录制迁移。
- 在进程内强制 hook 无网络副作用（只在文档中约定，并以重复执行校验结果可重复）。

## Decisions

### D1 `prepareOutput` 的位置与失败语义

`SuiteDefinition.prepareOutput?: { version: string; run(ctx) }`，`ctx = { rawOutput, sample, prompt }`，返回 `{ output, annotations? }`。在生成结果（三种模式同一处）之后、检查之前调用。

- 校验返回：`output` 必须是字符串；`annotations` 若存在须为普通对象且 JSON 往返后相等（拒绝 `Date`、`undefined`、函数等）。
- 可重复：同一输入执行两次，`output` 与 annotations 的 JSON 必须一致，否则视为不可重复。hook 应是廉价纯函数，双跑成本可忽略，能拦住依赖当前时间或随机数的实现。
- 任一失败 → 新样本状态 `prepare-error`，计入失败（退出码 1），不运行检查与评委，不回退成原文。
- 备选：在检查接口加「返回新正文」——被否决，评委仍拿原文，且检查顺序会影响结果。

### D2 录制与证据

- 生成录制不变（原文、用量、结束原因），新增可选 `durationMs`。
- 评委录制新增可选 `prepareVersion`；`outputHash` 改为对被评正文求摘要。回放判过期：`rubricVersion`、`outputHash` 任一不符，或 `prepareVersion` 与套件当前版本不同（含一方缺省）。未配置 hook 时被评正文即原文，旧录制的摘要与缺省版本仍匹配，无需重录。
- 样本结果新增 `prepared`（仅配置 hook 时）：`{ version, rawSha256, outputSha256, rawChars, outputChars, changed, annotations }`；`outputChars` 维持为被评正文长度。报告目录写 `outputs/<id>.txt`（被评正文），`changed` 时另写 `outputs/<id>.raw.txt`。未配置 hook 时不写 outputs，报告与现状一致。

### D3 生成耗时

真实 / 录制模式用 `performance.now()` 包住生成调用，取整毫秒写入录制与 `usage.generation.durationMs`；回放取录制值，缺省为空。评委调用同样记录 `durationMs`（只进报告，不进录制）。不用回放耗时代替，避免把本机速度当证据。

### D4 `evaluateRun` 契约

```ts
evaluateRun?: (ctx: {
  samples: readonly Sample[]           // 本次选定样本（筛选后）
  scope: RunScope                      // totalSamples、selected、filtered、sampleFilter、tag
  mode: Mode
  rubric: Rubric | null                // 评委开启时
  candidate: EvaluationGroup
  baseline: EvaluationGroup | null
}) => RunAssessment | Promise<RunAssessment>

interface EvaluationGroup {
  promptVersion: string
  source: 'run' | 'report'
  generator: ModelRef | null           // 报告缺字段时为 null
  judge: { key; provider; providerModelId; rubricVersion } | null
  results: readonly EvaluationResult[] // 与选定样本一一对应；报告基线可能缺样本
}
```

`EvaluationResult` 取 `SampleResult` 的稳定子集：`id`、`tags`、`status`、`checks`、`judge`（含各维原始分、理由与错误）、`usage.generation`（token 与 `durationMs`）、`finishReason`、`prepared`。同次 `--baseline` 时基线组为本次回放结果；`--baseline-report` 时从旧报告宽松解析，缺字段保持缺省，交由项目判 incomplete。

返回 `{ gates: [{ id, status, detail, required?, metrics? }] }`，`required` 缺省 true。校验：`id` 合法且唯一、`status` 为三值之一、`detail` 为字符串、`metrics` 可 JSON 序列化。hook 抛错或返回不合法时，报告记一个 `id: evaluate-run`、`failed` 的门槛（带原因），不丢弃已有结果。

### D5 退出码

新增 `EXIT.gates = 5`：存在 failed 门槛或 required 的 incomplete 门槛。沿用「取最小非零码」，5 排在 1、3、4 之后，生成错误、预算触顶或回退仍以原码报告；门槛结果总在报告中可见。未配置 `evaluateRun` 时报告 `assessment: null`，退出码不变。

### D6 统计辅助（`assess.ts`，从 `@saas/evals` 导出）

- `percentile(values, p)`：最近秩，排序后取第 `ceil(p/100 × n)` 个（至少第 1 个），空集合返回 null。
- `mean(values)`：空集合返回 null。
- `collect(group, ids, pick)`：按给定样本 ID 顺序取值，返回 `{ values, missing: string[] }`；样本不存在或 `pick` 返回非有限数都列入 `missing`。项目以同一 `ids` 收集候选与基线即完成按 ID 对齐。
- 浮点比较余量由项目决定，模板不提供带阈值的判定函数。

### D7 运行范围与评分数

报告新增 `scope`（`totalSamples`、`selectedSamples`、`filtered`、`sampleFilter?`、`tag?`），`report.md` 在筛选时注明「Scope: N of M samples」。`summary` 新增 `expectedScores`（评委开启时为选定样本数，否则 0），与已有 `scoredSamples` 并列，评委错误不会被平均分悄悄排除。

## Risks / Trade-offs

- [hook 在进程内仍可访问网络] → 文档约定纯函数；双跑校验可拦住大部分非确定实现；回放测试打桩 `fetch` 可被项目复用。
- [旧报告作基线时缺耗时与评分字段] → 传缺省值，`collect` 列缺口，项目判 incomplete。
- [门槛退出码 5 被 CI 当作普通失败] → 文档退出码表说明；5 只在项目配置门槛时出现。
- [双跑使 hook 耗时翻倍] → hook 应为轻量字符串处理；若项目确有昂贵计算可自行缓存（结果仍须确定）。

## Migration Plan

纯增量：录制与报告只增加可选字段，旧录制照常回放。发布为 PATCH，升级说明给出 `prepareOutput` 与 `evaluateRun` 的迁移示例。回滚即回退代码；新字段被旧版本以宽松 / 严格 schema 读取时，旧版本会把带 `durationMs` / `prepareVersion` 的录制判为不合法，因此回滚后需重新录制或删除这两个字段。
