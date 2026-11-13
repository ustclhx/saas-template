# Design

## Context

- **现状**：仓库里没有提示词定义、版本号或评测工具。`ai_message`（`packages/db/src/schema/ai.ts`）记录模型与用量，没有提示词版本列；对象对话的上下文自带 `version`（`[context type=… version=…]`），但那是上下文数据版本，不是提示词版本。
- **可复用部分**：
  - `packages/ai/src/text/model.ts`：`LanguageModelFactory = (model: AvailableModel, env) => LanguageModel` 与 `defaultLanguageModelFactory`（direct / gateway 两种出口，密钥只在请求头）。
  - `packages/ai/src/text/budget.ts`：`estimateInputTokens` / `estimateTextTokens`，按码点保守估算（默认每字符 1 token）。
  - `packages/ai/src/pricing.ts` 的单价单位是积分，不是美元，评测预算不能用它。
  - 模型注册表 `packages/ai/src/models.ts` 需要数据库，命令行评测不应依赖它。
  - 测试用 `ai/test` 的 `MockLanguageModelV4`；结构化输出可用 `generateText` + `Output.object`（已安装的 `ai@7` 提供）。
  - 录制夹具先例：`packages/ai/src/media/fixtures/*.recorded.json` 与其 README（区分真实录制与按文档构造，记录取得方式与费用）。
  - 根脚本都是 `node scripts/*.mjs`；运行 TS 的先例是 `node --env-file-if-exists=../../.env.local --experimental-strip-types`（`packages/billing` 的 seed / sync）。源码统一带 `.ts` 扩展名导入，满足类型剥离的要求。
  - 证据目录约定：`process.env.EVIDENCE_DIR || resolve(repo, 'test-results/evidence')`。
  - 项目自有文件先例：`share-cards.project.ts` 在 `create-project`、`template-sync/merge.mjs`、`template-release` 三处登记。
- **约束**：`packages/ai` 保持业务无关；评测不进 Worker 包；真实调用不能在默认 CI 中发生；终端、报告和录制都不能出现密钥或请求头。

## Goals / Non-Goals

**Goals:**
- 项目写一个套件目录（样本、提示词版本、评分标准、模型单价），就能离线回放对比两个提示词版本，并在需要时用有上限的费用跑真实模型。
- 「同一版本、内容不同」在评测时被机器发现，而不是靠人记住。
- 模板示例套件在 CI 的包单测中离线跑通，持续验证工具本身。

**Non-Goals:**
- 不做评测结果入库、后台页面或趋势图；报告是证据文件。
- 不做多轮对话、工具调用、图片或视频提示词的评测。
- 不追求真实模式结果可复现（模型本身有随机性）；可复现性由回放模式提供。
- 不提供通用的简繁转换，只做误用检测。

## Decisions

### D1. 新包 `packages/evals`，命令行经类型剥离运行

- 新增私有包 `@saas/evals`，依赖 `@saas/ai`、`ai`、`zod`，测试用 `vitest`。根 `package.json` 增加开发依赖 `@saas/evals: workspace:*`（根目录的 `evals/` 套件需要能解析它），以及脚本：

  ```json
  "eval:prompts": "node --env-file-if-exists=.env.local --experimental-strip-types packages/evals/src/cli.ts"
  ```

- `check-deps` 增加规则：除根 `package.json` 外，任何 app 或 package 的 manifest 与源码都不得依赖 `@saas/evals`，保证它不进 Worker 或自托管运行时。
- 不放进 `packages/ai`：评测需要文件系统、命令行参数、报告写入和字表数据，都是开发期能力；放在运行时包里会增加误打包的风险，也让 `packages/ai` 背上与业务套件交互的代码。`packages/ai` 只新增 D2 的提示词定义工具。
- 备选方案：
  - 根目录 `scripts/eval-prompts.mjs`：脚本是 JS，套件和评分标准需要类型，且无法复用 TS 的 `@saas/ai`，不采用；
  - 引入 `tsx` / `vite-node` 运行：多一个依赖，仓库已有类型剥离的先例，不采用。

### D2. 提示词定义放 `@saas/ai`，版本锁按渲染结果判断

- `packages/ai/src/text/prompt.ts` 导出：

  ```ts
  interface PromptDefinition<I> {
    id: string                    // 小写短横线，如 'report'
    version: string               // 如 'v4'；同一 id 下唯一
    system: string | ((input: I) => string)
    user: (input: I) => string
    sections?: readonly PromptSection[]   // { id, heading: string | RegExp, required?: boolean }
    maxOutputTokens: number
    params?: { temperature?: number; topP?: number }
  }
  definePrompt<I>(def): Readonly<PromptDefinition<I>> & { promptVersion: string }  // `${id}@${version}`
  renderPrompt(def, input): { system: string; user: string; params; maxOutputTokens }
  ```

  生产代码与评测套件导入同一个定义，评测测的就是线上用的提示词。定义模块应保持纯函数（不导入数据库或 app 别名），才能在命令行中加载。
- **版本不可变的判定**：不对函数源码做摘要（会漏掉被导入的辅助函数的改动）。改为对每个样本的**渲染结果**（system、user、params、maxOutputTokens 的规范化 JSON）做 SHA-256，写入套件的 `prompts.lock.json`：

  ```json
  { "report@v3": { "sample-01": { "input": "sha256:…", "rendered": "sha256:…" } } }
  ```

  - 每次运行（含回放）都重新渲染并比对：已有条目不一致时以退出码 2 失败；`input` 摘要相同而 `rendered` 不同提示「提示词内容已改动，请新建版本」，`input` 摘要不同提示「样本已改动，请新增样本 ID」；
  - 新版本或新样本的条目自动追加，已有条目从不改写；
  - 样本输入本身改动也会触发，此时应新增样本 ID 而不是修改旧样本。
- 备选方案：版本号由内容摘要自动生成。可以杜绝误用，但版本号失去可读性，生成记录里也难以对应人工命名的「v4」，不采用。

### D3. 不给 `ai_message` 加列，只写约定

- 模板自身的对话没有版本化提示词（system 来自对象上下文，已有自己的 `version`）。给 `ai_message` 加一个模板永远写空的可空列，会让所有衍生项目多一次迁移，且衍生项目的报告生成通常写在自有表中（xuanxue 已有 `promptVersion` 列）。
- 文档约定：项目自有的生成表加 `prompt_version text not null`，写入 `definePrompt` 返回的 `promptVersion`；结构化日志同时记录该字段。
- 以后模板自身出现版本化提示词时，再按需加列。

### D4. 套件目录与样本格式

```
evals/<suite>/                  # 项目自有；示例在 packages/evals/example/
  suite.ts                      # export default defineSuite({...})
  samples.json                  # 固定样本
  prompts.lock.json             # D2，运行时追加
  recordings/<promptVersion>/<modelKey>/<sampleId>.json   # D6
  README.md                     # 可选：录制来源与费用记录
```

```ts
defineSuite({
  name: 'report',
  prompts: [reportV3, reportV4],          // D2 的定义
  defaultPrompt: 'report@v4',
  models: {
    'sonnet': { provider: 'anthropic', providerModelId: '…',
                priceUsd: { inputPerMTok: 3, outputPerMTok: 15 }, tokensPerChar?: 1 },
    'judge-mini': { … },
  },
  generator: 'sonnet',
  judge: { model: 'judge-mini', rubric },  // 可省略，省略时不跑评委
  checks: [...],                          // 套件级确定性检查（D7）
  regressionThreshold: 0.05,              // D9，可省略
})
```

`samples.json` 中每个样本：`{ id, input, expect?: { sections?, length?, banned?, script?, … }, tags? }`。`input` 原样传给 `user(input)`；`expect` 覆盖或追加套件级检查参数。样本必须是合成或已脱敏数据，文档写明。

### D5. 三种模式与模型构造

| 模式 | 参数 | 行为 |
|---|---|---|
| 回放（默认） | 无 | 只读录制，不访问网络；录制缺失的样本记为失败（`no-recording`），不回退到真实调用 |
| 真实 | `--live --budget-usd <n>` | 调用真实模型，不写录制 |
| 录制 | `--record --budget-usd <n>` | 调用真实模型，并写入或覆盖录制 |

- 真实与录制模式缺少 `--budget-usd`、或用到的模型缺少单价时，在任何调用前以退出码 2 拒绝。
- `CI` 环境变量为真时拒绝真实与录制模式（退出码 2），不提供绕过开关；需要在流水线中跑真实评测时由项目自行加专门的手动工作流。
- 模型：按套件声明拼出 `AvailableModel` 形状（`provider`、`providerModelId`，其余字段填中性值），交给 `defaultLanguageModelFactory`，环境变量取自 `process.env`（脚本已用 `--env-file-if-exists=.env.local` 加载）。这样评测与线上走同一套出口代码（direct / gateway）。运行器核心接受注入的 `(modelKey) => LanguageModel`，单测注入模拟模型。
- 回放把录制包装成 `MockLanguageModelV4`，与真实模式走同一条 `generateText` 路径，评委的结构化解析也因此在回放中被覆盖。
- `--prompt <promptVersion>`、`--model <key>`、`--judge-model <key>`、`--samples <id,…>`、`--tag <tag>` 用于选择；`--concurrency` 默认 1、最大 4。

### D6. 录制文件

```json
{
  "kind": "generation",
  "promptVersion": "report@v4",
  "renderedHash": "sha256:…",        // 与 D2 锁文件相同的值
  "model": { "key": "sonnet", "provider": "anthropic", "providerModelId": "…" },
  "output": "…", "finishReason": "stop",
  "usage": { "inputTokens": 1234, "outputTokens": 2345 },
  "recordedAt": "2026-11-14T…Z", "source": "recorded"
}
```

- 评委录制放 `recordings/<promptVersion>/<modelKey>/<sampleId>.judge.<judgeKey>.json`，额外记 `rubricVersion` 与被评输出的摘要；回放时被评输出或评分标准版本不一致，视为录制缺失。
- 回放时 `renderedHash` 与当前渲染不一致，视为录制过期（`stale-recording`），样本失败。
- 录制只保存上述字段，不保存请求头、端点 URL、密钥或原始响应。录制属于测试夹具，提交进仓库；报告不进仓库（D9）。
- 示例套件的录制在 `source` 上区分 `recorded`（真实模型）与 `constructed`（手写），README 记录取得方式与费用，沿用媒体夹具的约定。

### D7. 确定性检查

- 检查接口：

  ```ts
  interface Check { id: string; run(ctx: { output: string; sample; prompt }): CheckResult | Promise<CheckResult> }
  interface CheckResult { pass: boolean; detail?: string; severity?: 'error' | 'warn' }
  ```

  套件 `checks` 中可混用内置检查和项目自定义检查。`severity: 'warn'` 只进报告，不影响退出码。
- 内置检查：
  - `sections`：按提示词定义的 `sections` 在输出中查找标题（字符串按整行匹配 Markdown 标题，或用正则），报告缺失项，可要求顺序；
  - `length`：按码点计的字符数区间，可对全文或单个章节；
  - `banned`：禁用词（大小写不敏感）与正则列表，报告命中位置附近的片段；
  - `script`：按文字统计汉字、拉丁、假名、谚文的占比，检查期望语言（如 `zh-Hans` 要求汉字占比 ≥ 阈值，`en` 要求拉丁占比 ≥ 阈值）；
  - `chinese-variant`：简繁误用。仓库内置两张字表：约 500 个常用的「仅繁体」字（如 這、們、來、會、說、時、個、過、還、發）和对应的「仅简体」字，取自 Unicode Unihan 的 `kTraditionalVariant` / `kSimplifiedVariant` 与常用字频表的交集，生成脚本与来源写在字表文件头部。`zh-Hans` 输出中「仅繁体」字数超过阈值（默认 0）即失败，`zh-Hant` 反之。
- 简繁不引入 `opencc-js` 等转换库：只需要检测而不是转换；常用字覆盖了模型误用的绝大多数情况；字表几 KB，可读、可审查。项目需要更严格的判定时，用自定义检查替换。

### D8. LLM 评委

- 评分标准由套件提供：

  ```ts
  interface Rubric {
    version: string
    instructions?: string                // 项目对评委的补充说明
    criteria: { id: string; description: string; weight?: number }[]
    scale: { min: number; max: number }  // 如 1–5
  }
  ```

- 评委提示词由 `packages/evals` 内置（业务无关）：给出评分标准、样本输入、提示词期望章节与被评输出，要求按 Zod schema 输出 `{ criteria: { [id]: { score, reason } }, summary }`。用 `generateText` + `Output.object` 解析，`temperature: 0`。
- 分数换算：各项按 `(score - min) / (max - min)` 归一到 0–1，再按权重加权得到样本总分。分数越界或解析失败记为评委错误（`judge-error`），样本不计分，计入失败，不当作 0 分。
- 评委模型独立于生成模型，有自己的单价；评委调用同样受 D6 录制与 D10 预算约束。确定性检查有 `error` 级失败时仍然评分（便于对比），报告中两者分开列出。
- `--no-judge` 跳过评委，只跑确定性检查。

### D9. 报告、基线与退出码

- **位置**：`$EVIDENCE_DIR/prompt-evals/<suite>/<UTC 时间戳>-<promptVersion>-<mode>/`，未设置时为已忽略的 `test-results/evidence/`。写 `report.json` 与人读的 `report.md`。
- **内容**：套件名、提示词版本与各样本渲染摘要、模型键与 `providerModelId`、模式、git 提交、逐样本（检查结果、评委各项分数与理由、用量、估算费用、状态）、汇总（通过率、平均分、总费用估算、预算上限与是否触顶）。不写环境变量、密钥、请求头或端点。
- **基线**：
  - `--baseline <promptVersion>`：在同一次运行中用回放跑基线版本（录制必须存在），免费且可复现，是推荐方式；
  - `--baseline-report <path>`：读取一份以前的 `report.json`，适合对比真实模式的结果。
  - 两者都按样本 ID 对齐，报告列出每个样本的分数差、检查结果变化，以及平均分差。
- **回退判定**：平均总分下降超过 `--max-regression`（默认取套件 `regressionThreshold`，再缺省为 0.05）即判为回退；单样本下降超过该值的列入报告，但不单独决定退出码。
- **退出码**（同时出现时取最小的非零码）：

  | 码 | 含义 |
  |---|---|
  | 0 | 全部通过，无回退 |
  | 1 | 有 `error` 级检查失败、生成或评委错误、录制缺失或过期 |
  | 2 | 配置错误：版本锁冲突、真实模式缺预算或单价、CI 中开启真实调用、套件不存在 |
  | 3 | 预算触顶，部分样本被跳过 |
  | 4 | 相对基线回退超过阈值 |

  配置错误在任何调用前发现，不写报告；其余情况都写报告后再退出。

### D10. 美元预算

- 每次调用前估算上限：`inputTokens × inputPerMTok / 1e6 + maxOutputTokens × outputPerMTok / 1e6`，其中 `inputTokens = estimateInputTokens([system, user], tokensPerChar)`（评委调用同理，`maxOutputTokens` 固定为 1024）。
- 预算账本：`已花费 + 在途预留 + 本次估算 > --budget-usd` 时不发出该调用，本样本及之后所有未开始的样本记为 `skipped-budget`，等在途调用结束后写报告，以退出码 3 退出。并发时先预留再调用，保证并发也不会超过上限。
- 调用结束后按返回的实际用量结算；用量缺失时按估算值记账（与 `ai-text-runtime` 中「未知用量按估算封顶」一致）。
- 回放模式不记费用，但报告按录制用量给出「真实运行约需多少美元」，帮助决定 `--budget-usd`。
- 单价由套件声明，不读后台模型表（命令行无数据库，且后台单价是积分）。

### D11. 测试与 CI

- `packages/evals` 的 `test` 是普通 vitest 单测，进 turbo `test`：
  - 检查、锁文件、预算账本、报告与退出码的单元用例；
  - 示例套件的完整回放（两个版本、带基线对比），断言报告内容与退出码；
  - 预算：用模拟模型覆盖「估算超额时不发出调用」「并发预留」「用量缺失按估算记账」。
- `eval:prompts` 根脚本不进 turbo 任何任务。

### D12. 模板交付与衍生项目

- 示例套件在 `packages/evals/example/`（模板拥有，同步时正常更新）；命令行 `--suite example` 指向它，其他名字解析为根目录 `evals/<name>/suite.ts`。
- 模板永远不在根目录 `evals/` 交付文件，所以 template-sync 不会与项目套件冲突，也不需要登记为项目自有文件。`template-release` 增加一条检查：模板仓库中 `evals/` 下没有被跟踪的文件。
- 生成器原样复制 `packages/evals`，生成的项目里 `pnpm eval:prompts --suite example` 离线可用。

## Risks / Trade-offs

- **[锁文件按渲染结果判断，改样本输入也会报版本冲突]** → 文档写明样本不可改、只能新增；报错信息区分「提示词渲染变了」与「样本输入变了」（同时比对样本输入的摘要）。
- **[字符数估算 token 偏保守，预算可能提前触顶]** → 套件可按模型声明 `tokensPerChar`；报告给出估算与实际用量的比值，便于调整。
- **[LLM 评委本身不稳定]** → `temperature: 0`、结构化输出、回放评委结果；文档建议以回放基线对比为准，真实模式的分数波动只作参考。
- **[常用字表覆盖不全，罕见繁体字漏检]** → 定位为误用检测而非完整转换；项目可用自定义检查替换。
- **[类型剥离不支持 enum、namespace 等语法]** → 文档要求提示词与套件模块只用可剥离的 TS 语法；包单测在 Node 下以同样方式加载示例套件来兜底。
- **[录制含模型输出，随仓库公开]** → 样本必须是合成数据；示例套件只用中性虚构内容。衍生项目若仓库公开，同样适用。

## Migration Plan

1. 无数据库迁移，无部署变化；`packages/evals` 不进任何运行时产物。
2. 回滚：删除 `packages/evals`、根脚本与 `packages/ai/src/text/prompt.ts` 即可。
3. 衍生项目同步后无行为变化。要评测时：用 `definePrompt` 定义提示词、生成表保存 `promptVersion`、在 `evals/<suite>/` 写套件，先 `--record --budget-usd` 录一次，之后日常用回放对比。

## Open Questions

无。2026-11-14 使用者决定：预算为美元上限 `--budget-usd`，按套件声明的单价与 token 估算，调用前判断（输入估算 + 最大输出）；离线默认回放。
