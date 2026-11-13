# Tasks

并行说明：第 1、2 组相互独立，可先并行；第 3 组的 3.1–3.4 在第 2 组合并后可并行（各自只改 `packages/evals/src/` 下不同文件）；第 4 组依赖第 3 组；第 5、6 组依赖第 4 组，二者可并行；第 7 组的文档可与第 5、6 组并行，升级说明在最后定稿。

## 1. 提示词定义（`@saas/ai`）

- [x] 1.1 新增 `packages/ai/src/text/prompt.ts`（design D2）：`PromptDefinition`、`definePrompt`（校验 id 为小写短横线、版本非空，冻结并附 `promptVersion = <id>@<version>`）、`renderPrompt`（system 可为字符串或函数），以及渲染结果的规范化 JSON 与 SHA-256 摘要函数（用 Web Crypto，Workers 与 Node 都可用）；从 `text/index.ts` 导出。不新增依赖、不导入数据库。验证：`packages/ai` 单测覆盖非法 id、`promptVersion` 格式、函数式与字符串 system、相同输入摘要稳定、键顺序不影响摘要、params 变化改变摘要；`pnpm --filter @saas/ai typecheck` 通过。

## 2. 评测包骨架与依赖边界

- [x] 2.1 新增私有包 `packages/evals`（`@saas/evals`，`type: module`，依赖 `@saas/ai`、`ai`、`zod`，开发依赖 `vitest`），含 `typecheck` 与 `test` 脚本和 tsconfig；根 `package.json` 增加开发依赖 `@saas/evals: workspace:*` 与 `eval:prompts` 脚本（design D1，`--env-file-if-exists=.env.local --experimental-strip-types`）；`cli.ts` 先只打印用法。验证：`pnpm install` 后 `pnpm eval:prompts --help` 在 Node 22 下输出用法；`pnpm check:singletons`、`pnpm dedupe --check` 通过。
- [x] 2.2 `scripts/check-deps.mjs` 增加规则：除根 `package.json` 外，任何 app 或 package 的 manifest 与源码 import 都不得依赖 `@saas/evals`。验证：`scripts/check-deps.test.mjs` 新增用例（app 依赖与源码导入各一例被拒绝、根目录允许），`pnpm check:deps` 通过。

## 3. 评测核心（可并行）

- [ ] 3.1 套件与锁文件（D2、D4）：`defineSuite`、`samples.json` 的 Zod 校验（ID 唯一、`expect` 结构）、套件解析（`example` 指向 `packages/evals/example/`，其他名字指向根目录 `evals/<name>/suite.ts`，不存在时配置错误）、`prompts.lock.json` 的比对与只追加写入，区分「提示词改动」与「样本改动」两种报错。验证：单测覆盖重复样本 ID、未知提示词版本、改 system 报错且锁不变、改样本输入报不同错误、新增版本与新样本追加、已有条目永不改写。
- [ ] 3.2 确定性检查（D7）：检查接口与严重级别；内置 `sections`、`length`、`banned`、`script`、`chinese-variant`；样本 `expect` 覆盖套件参数。新增简繁字表数据文件与生成脚本（头部写明 Unihan 字段与字频来源、生成日期），约 500 个常用仅繁体字与对应仅简体字。验证：单测覆盖缺章节与顺序错误、章节内长度、码点计数（emoji 计 1）、禁用正则命中片段、英文输出被判非 `zh-Hans`、简体中混入「這們」失败、繁体中混入「这们」失败、自定义检查返回警告不影响结果、字表中没有简繁同形字。
- [ ] 3.3 预算账本（D10）：调用前估算（复用 `estimateInputTokens`，按模型 `tokensPerChar`）、预留、结算、用量缺失按估算记账、触顶后拒绝后续调用；缺单价时报配置错误。验证：单测覆盖 spec「美元预算上限」的三个场景，以及并发 4 时已花费与在途之和始终不超过上限（用可控延迟的模拟模型）。
- [ ] 3.4 评委（D8）：内置评委提示词、Zod 输出 schema、`generateText` + `Output.object`、`temperature: 0`、归一与加权、越界与解析失败记为评委错误。验证：单测用 `MockLanguageModelV4` 覆盖 spec「LLM 评委」两个场景（总分 0.75、无法解析），以及分数越界。

## 4. 运行器、回放与命令行

- [ ] 4.1 模型与模式（D5、D6）：按套件声明构造 `AvailableModel` 形状并调用 `defaultLanguageModelFactory`；回放把录制包装为 `MockLanguageModelV4`；录制缺失记 `no-recording`、`renderedHash` 不符记 `stale-recording`；录制模式写入生成与评委录制（只含 D6 字段）；真实与录制模式缺预算、缺单价、`CI` 为真时配置错误。验证：单测覆盖回放不触发 `fetch`（全局 `fetch` 打桩断言零调用）、录制缺失不回退真实调用、`CI=true` 拒绝、录制文件不含 `authorization` / `x-api-key` / `x-goog-api-key` / 端点 URL。
- [ ] 4.2 运行器与报告（D9）：样本选择（`--prompt`、`--model`、`--judge-model`、`--samples`、`--tag`、`--no-judge`、`--concurrency` ≤ 4）、逐样本执行（生成 → 检查 → 评委）、报告 `report.json` 与 `report.md` 写到 `$EVIDENCE_DIR/prompt-evals/<suite>/<时间戳>-<版本>-<模式>/`（缺省 `test-results/evidence/`）、回放模式给出按录制用量估算的真实费用。验证：单测断言报告字段完整、不含环境变量值；未设 `EVIDENCE_DIR` 时写入的目录被 `.gitignore` 忽略（`git check-ignore` 断言）。
- [ ] 4.3 基线与退出码（D9）：`--baseline <promptVersion>`（同次回放运行）、`--baseline-report <path>`、按样本 ID 对齐、`--max-regression`（缺省取套件值再缺省 0.05）、退出码 0–4 的优先级，配置错误不写报告。验证：单测覆盖 spec「分数回退」场景、基线缺录制时的报错、同时出现检查失败与回退时退出码为 1、预算触顶为 3。
- [ ] 4.4 命令行入口 `cli.ts`：参数解析（`node:util` 的 `parseArgs`）、`--help`、错误信息不打印环境变量值；终端只输出汇总与报告路径。验证：子进程测试运行 `--help`、未知套件（退出码 2）、`--live` 无预算（退出码 2）。

## 5. 示例套件

- [ ] 5.1 新增 `packages/evals/example/`：中性主题（如「产品简介撰写」），两个提示词版本 `product-intro@v1` / `@v2`，中英文样本各 3 个（含一个故意触发长度或章节失败、标为警告级的样本），示例评分标准，套件级检查覆盖全部内置检查；先用手写的 `constructed` 录制（生成与评委）让回放可跑，README 写明来源约定（沿用 `packages/ai/src/media/fixtures/README.md`）。验证：包单测以回放完整运行示例套件（含 `--baseline product-intro@v1`），断言退出码 0、报告中两版本的分数差，且全程零网络调用；`pnpm eval:prompts --suite example` 在本地以 0 退出。
- [ ] 5.2 用真实模型录制示例套件（需要外部凭据，协调者或持有密钥的 worker 执行）：`pnpm eval:prompts --suite example --record --budget-usd 0.5`，选一个低价模型做生成和评委，把 `source` 改为 `recorded`，README 记录日期、模型、实际估算费用与预算。再用 `--live --budget-usd 0.001` 运行一次，确认第一次调用前即触顶、未发出请求。验证：录制提交进仓库，5.1 的回放测试仍通过；两次运行的报告写入私有证据库。

## 6. 模板交付

- [ ] 6.1 `scripts/template-release.mjs` 增加检查：模板仓库中根目录 `evals/` 下不得有被跟踪的文件（design D12）。验证：`scripts/template-release.test.mjs` 新增正反用例，`node scripts/template-release.mjs check` 通过。
- [ ] 6.2 生成器：确认 `pnpm create-project` 原样复制 `packages/evals`，生成的项目中示例套件可离线运行。验证：`scripts/create-project.verify.test.mjs` 增加一步在生成的副本中运行 `pnpm eval:prompts --suite example` 并断言退出码 0；`pnpm test:create-project` 与 `pnpm test:create-project:verify` 通过。

## 7. 文档与升级说明

- [ ] 7.1 `docs/06-ai.md` 在 §3「对象对话、推荐追问与评分」之后新增「提示词版本与评测（add-prompt-evals）」：`definePrompt` 与版本不可变约定、锁文件与报错含义、项目生成表的 `prompt_version` 建议列与日志字段、套件目录结构、样本须为合成数据、三种模式与 `--budget-usd` 的估算方式、评委与评分标准、报告位置与基线对比、退出码表、真实评测不进 CI、类型剥离对 TS 语法的限制。`docs/02-project-structure.md` 登记 `packages/evals` 与根目录 `evals/`，AGENTS.md 常用命令表加 `pnpm eval:prompts`。验证：文档中的命令在本地照着执行可得到报告。
- [ ] 7.2 `new-module` 技能加入「AI 生成功能」的提示词版本与评测步骤（定义提示词、保存 `promptVersion`、建套件、先录制后回放）。验证：`.agents/skills/new-module/SKILL.md` 与 `.claude/skills/new-module/SKILL.md` 用 `cmp` 比对一致，`node --test scripts/agent-skills.test.mjs` 通过。
- [ ] 7.3 起草下一版本升级说明 `docs/upgrades/<下一版本>.md`：无迁移、无部署变化；新包与根脚本、`@saas/ai` 新导出、`check-deps` 新规则、项目自有目录 `evals/`、衍生项目接入步骤（含在自有生成表加 `prompt_version` 的建议）。验证：`node scripts/template-release.mjs check` 通过。

## 8. 验收

- [ ] 8.1 `pnpm check`、`pnpm typecheck`、`pnpm check:deps`、`pnpm check:singletons`、`pnpm test` 与 `pnpm build` 全部通过，`pnpm test:create-project:verify` 通过；确认 `pnpm build` 产物（web 与 jobs Worker、自托管构建）中不含 `@saas/evals` 的模块。
- [ ] 8.2 离线与预算验收：断网（或全局 `fetch` 拒绝）下 `pnpm eval:prompts --suite example --baseline product-intro@v1` 以 0 退出并写出报告；`CI=true pnpm eval:prompts --suite example --live --budget-usd 1` 以 2 退出；5.2 的预算触顶运行结果附在证据中。证据写入私有证据库，PR 只引用。
