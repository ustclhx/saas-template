# Proposal

## Why

xuanxue-saas 迁移详批评测到 `pnpm eval:prompts` 时发现两个通用缺口：评委与检查只能评模型原文，无法评用户实际看到的「兜底后正文」；评分后只有加权总分回退判定，项目无法表达逐维度对比、绝对分、P95 token / 时长等门槛，且录制没有生成耗时。xuanxue 的 `readings-prompt-v4-yearly` 4.7 因此挂起，需要模板先提供业务无关的扩展点。

## What Changes

- 套件新增可选、带版本号的 `prepareOutput`：在确定性检查与评委之前把原文转换为被评正文。三种模式走同一路径；hook 异常、返回不合法或两次执行结果不一致时样本记为新状态 `prepare-error` 并计入失败。生成录制仍保存原文；评委录制的 `outputHash` 绑定转换后的正文，并记录转换版本，版本或正文变化时旧评委录制视为过期。报告记录原文与被评正文的摘要、字符数、转换版本与 annotations，并在报告目录写出被评正文（与原文不同时一并写出原文）。
- 套件新增可选 `evaluateRun`：候选与基线（若有）全部完成后调用，接收选定范围内的完整逐样本结果（状态、检查、评委各维原始分与错误、用量、生成耗时、模型与评分标准版本）及运行范围，返回门槛列表 `passed | failed | incomplete`。门槛写入 `report.json` 与 `report.md`；任一门槛 failed、必需门槛 incomplete，或 hook 本身异常 / 返回不合法时以新退出码 5 退出，优先级低于已有的 1、3、4，不掩盖已有失败。内置总分回退判定保留并同时生效。
- 导出业务无关的统计辅助：最近秩分位数、均值，以及按样本 ID 收集指标并列出缺口的 `collect`，便于项目在缺样本、缺分数或缺时长时判 incomplete，而不是缩小分母。
- 生成录制增加可选 `durationMs`（真实 / 录制模式实测），回放读取录制值；样本结果的生成用量带 `durationMs`，缺失时为空，不用本机回放耗时代替。
- 报告增加运行范围（套件样本总数、选定数、是否经 `--samples` / `--tag` 筛选）与应有 / 有效评分数。
- 评委 JSON 解析失败继续记为 `judge-error` 并判样本失败；本次不提供自动重试。
- 未配置两个 hook 的套件（含模板示例）退出码与判定不变。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `prompt-evals`：新增「被评正文转换」「评测后聚合门槛」「生成耗时记录」「运行范围」等要求；「LLM 评委」与「报告与基线对比」补充转换后正文与退出码 5。

## Impact

- 代码：`packages/evals/src/{suite,runner,models,report,cli,errors,index}.ts`，新增 `assess.ts`；测试与 `test-support.ts`。
- 文档：`docs/06-ai.md`「提示词版本与评测」、下一模板版本升级说明（含两个扩展点的用法与迁移示例）。
- 兼容：录制与报告只增加可选字段，旧录制可继续回放；无数据库、部署或配置变化。
