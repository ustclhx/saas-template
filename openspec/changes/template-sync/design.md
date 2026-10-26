# Design

## Context

动机见 proposal.md。与实现方案相关的现状：

- `scripts/create-project.mjs` 只用 Node 内置模块。它从**工作区**遍历复制文件，排除 `.git`、`openspec/changes`、模板专属文档与脚本以及本地真值文件。复制时按 `replacements()` 改名，并改写 `template.config.ts` 和两个 `wrangler.jsonc`，最后写入 `PROJECT_SETUP.md` 和 `.dev.vars.example`。
- 生成逻辑本身没有时间戳或随机值，但从未验证过结果是否确定，也不记录来源提交和参数。
- 迁移在 `packages/db/migrations`，由 drizzle-kit 生成，带 `meta/_journal.json`（字段 idx、when、tag）和每个迁移的 snapshot。xuanxue 已有自有迁移 `0013_superb_excalibur`；模板之后新增了 `0013`–`0018`。
- 技能放在 `.agents/skills` 和 `.claude/skills` 两个目录，要求逐字节一致，生成器会原样复制进衍生项目。
- 模板仓库是公开的 GitHub 仓库。
- 模板没有自己的版本号体系。现有的 `v0.1.0`–`v0.1.3` 是 2026-10-16 演示站的生产发布 tag：`deploy-production.yml` 由 `v*` 触发，衍生项目也继承这套机制发布自己的产品。所有 `package.json` 的 version 都是 `0.0.0`，仓库里没有 CHANGELOG 或升级文档。
- 生产与 staging 的部署顺序都是「迁移 → jobs → web」，回滚只重新部署旧代码，不回退 schema。

## Goals / Non-Goals

**Goals:**
- 衍生项目每次同步，都能看到「模板这段时间改了什么」的改名后视图，并在独立分支上得到可审查的合并结果。
- 同步逻辑以模板的目标版本为准，衍生项目里的旧副本不影响结果。
- 迁移移植后，已上线的衍生项目数据库按正常部署流程就会执行新的模板迁移。
- 模板按需发布带版本号的版本；每个版本附带升级说明，写明必须执行的动作和数据库变更，衍生项目按版本逐个采纳。

**Non-Goals:**
- 不做冲突自动解决，也不做语义级合并（如 AST 合并）。
- 不支持把衍生项目的改动回传到模板。
- 不管理衍生项目的部署和线上迁移执行。
- 不支持私有模板仓库的认证拉取（当前模板公开）。

## Decisions

### D1 基准记录：`.template-base.json`

记录放在项目根目录，内容为：

```json
{
  "schemaVersion": 1,
  "repository": "https://github.com/ustclhx/saas-template",
  "commit": "<40 位 SHA>",
  "version": "0.2.0",
  "clean": true,
  "params": { "name": "acme", "domain": "acme.example", "target": "cloudflare", "...": "..." },
  "migrations": ["0000_init", "..."]
}
```

- `version` 只在 `commit` 恰好是某个 `template-v*` tag 时填写，否则为 `null`；同步时以 `commit` 为准，`version` 只用于展示和计算升级说明的区间。
- `params` 是生成器解析后的完整参数，默认值也展开写出，不含 `output`。键名与 CLI 参数一一对应，可以直接还原成命令行。
- `migrations` 列出副本中已有的模板迁移 tag。移植后记录的是**模板原 tag**，不是重新编号后的 tag，用来判断哪些迁移已经移植过。
- `repository` 取自源仓库的 origin 地址，统一成不带凭据的 https 形式。源目录不是 git 仓库或有未提交改动时，`clean` 写为 false。
- 用副本再生成项目时，源副本的 `.template-base.json` 不复制，以新生成的记录为准。

备选方案：
- 把基准写进 `package.json` 字段：会和包管理器的字段混在一起，而且 selfhost 等子目录也有 package.json，容易误读。
- 写进 `PROJECT_SETUP.md`：那是给人看的清单，不适合机器解析。

### D2 用各提交自带的生成器，从干净检出生成

同步工具把模板浅克隆到临时目录。基准和目标各自 `git archive <sha>` 解包成干净树，然后**在该树中**运行它自己的 `scripts/create-project.mjs --skip-check`。生成器只依赖 Node 内置模块，所以不用安装依赖。

参数由 `params` 还原成 CLI 参数。旧生成器不认识某个参数时，按 spec 直接停止。

备选方案：用新生成器处理旧源树。生成器的改名和改写逻辑与源树结构是一起演进的，比如新增文件的改写规则；混用版本会把生成器自身的差异误当成模板变更，因此不采用。

### D3 合并方式：把生成结果放进项目对象库，再做三方 apply

1. 两份生成副本依次提交进一个临时 git 仓库，得到 `base` 与 `target` 两个提交。
2. 在衍生项目中执行 `git fetch <临时仓库> base target`，把这两个提交拉进 `refs/template-sync/*`，补齐 preimage blob。
3. 在新分支 `template-sync/<目标短 SHA>` 上，执行 `git diff -M base target -- <排除项之外>`，结果交给 `git apply --3way --index`。

排除项：
- `packages/db/migrations/**`：由 D5 处理；
- `.template-base.json`；
- `PROJECT_SETUP.md`：只在报告中列出其 diff；
- `pnpm-lock.yaml`：由 D4 处理。

备选方案：
- 不 fetch，直接 `git apply -3`：preimage blob 不在项目仓库中，三方合并会失败。
- 对每个文件单独 `git merge-file`：要自己处理重命名、删除和二进制文件，重复实现 git 已有的能力，因此不采用。

### D4 依赖锁文件按合并结果重新解析

锁文件不做文本合并。合并后如果任一 `package.json` 有变化，就运行 `pnpm install`（不加 frozen）重新解析；未变化的版本范围保持现有锁定版本。随后用 `pnpm install --frozen-lockfile` 确认锁文件一致，再进入 typecheck 和 test。

### D5 迁移移植：追加到末尾，并使用新时间戳

drizzle-orm 的 PostgreSQL 迁移器以数据库中最后一次已应用迁移的 `created_at` 为界，只执行 journal 中 `when` 更大的迁移。因此模板迁移如果按原编号插到项目自有迁移之前，已上线的数据库会**静默跳过**它们。这一点在实施时用当前依赖版本先验证（见 tasks 3.1）。

移植步骤：
1. 取目标版本相对基准版本**新增**的迁移 tag，排除 `migrations` 中已登记的，按模板顺序处理。基准中已有的模板迁移文件如果内容变了，按 spec 停止。
2. 每个迁移复制成 `<下一个 idx>_tpl_<原名去序号>.sql`，并写入 journal 条目：`when` 取项目现有最大值加 1 毫秒后递增，tag 与文件名一致。
3. 中间迁移的 snapshot 沿用上一个 snapshot，只更新 id 链。最后一个移植迁移的 snapshot，在临时副本中对已合并的 schema 运行 `drizzle-kit generate`，取它生成的 snapshot，丢弃它生成的 SQL。这样项目之后再运行 generate 时，不会重复生成模板的 DDL。
4. 验证：
   - 在项目中运行 `drizzle-kit generate`，结果应为无 schema 变化；
   - 有本地隔离数据库时，从空库执行全部迁移；
   - 在执行到上一个项目迁移为止的库上，执行增量迁移。
5. 把模板原 tag 追加到 `migrations`。
6. 衍生项目有意删除了某些模板表时（例如 xuanxue 删除了 job_engine schema），使用者用 `--skip-migration <tag>` 跳过依赖这些表的模板迁移。被跳过的 tag 同样登记进 `migrations`，含义是「已处理」，报告中单独列出。

命名约定：项目自有迁移继续用 drizzle-kit 默认命名；移植的模板迁移带 `tpl_` 标记，便于区分来源。模板侧的约定写入 `docs/02-project-structure.md`：
- 已发布的迁移不再修改，修复改用新迁移；
- 迁移不得依赖固定的 idx。

备选方案：在衍生项目里按合并后的 schema 重新 `drizzle-kit generate` 一个迁移。这样会丢掉模板迁移中的数据语句，例如 `0017` 的审计去个人信息、`0018` 的计费数据调整，因此不采用。

### D6 工具位置与调用方式

- `scripts/template-sync.mjs` 放在模板中，子命令为 `sync` 和 `infer-base`。
- 衍生项目中的技能不直接运行本地副本里的脚本，而是指导：先克隆模板的目标版本，再执行 `node <模板临时目录>/scripts/template-sync.mjs sync --project <项目路径> --to <ref>`。这样同步逻辑总是来自目标版本。
- 测试文件 `scripts/template-sync.test.mjs` 加入生成器的 `templateOnly`。脚本本身仍复制进副本，方便离线查看。

### D7 基准推断

`infer-base` 的步骤：
1. **还原参数**：读取副本**首个提交**的树，从以下文件还原参数：
   - `template.config.ts`：语言、i18n、营销、billing、credits、AI、可选功能、OAuth、Turnstile、多租户、支持邮箱；
   - 根 `package.json` 的作用域：名称；
   - `wrangler.jsonc` 中的 `APP_URL` 或 routes：域名；
   - 是否存在 selfhost 发布工作流与镜像 namespace：部署目标。
2. **生成候选**：在 `--since/--until` 时间窗内（默认取首个提交日期前后 3 天），对模板 main 上的每个提交生成副本。
3. **评分**：评分只统计生成副本中存在的路径与首个提交之间的差异行数。只存在于项目的文件，例如交接文档，单独列出，不计分。按分数排序输出前 5 个候选。
4. **写入**：最佳候选低于阈值（默认 0 行差异以外最多 50 行）时，才允许在确认后写入。参数中有无法还原的项时，用 `--param key=value` 补齐。

备选方案：按日期直接取生成当天模板 main 的最后一个提交。生成可能发生在本地有未合并改动的工作区，日期不可靠，因此不采用。

### D8 生成器改动

- 在副本中写入 `.template-base.json`，SHA 与 `clean` 状态通过 `git -C <source>` 获取。
- 规范化参数的序列化：键排序，列表保持输入顺序并去重。
- 新增确定性测试：同一源和同一参数生成两次，输出到不同目录，比较文件列表、内容和权限位。
- 同步工具调用的生成器，等于基准版本或目标版本中各自的那一个。基准版本早于本 change 时，副本中不会有记录文件；这个差异由 D3 的排除项吸收。

### D9 版本号与 tag

- 使用 SemVer，发布 tag 为 annotated 的 `template-v<版本号>`。不用 `v*`，因为它会触发 `deploy-production.yml`。现有 `v0.1.x` 保留为演示站的历史发布，不算模板版本。首个模板版本为 `template-v0.2.0`，接在 v0.1.3 之后。
- 版本号只以 tag 为准，不写进 `package.json`。否则衍生项目会继承一个与自身无关的版本号，同步时还会在每个 `package.json` 上产生冲突。
- 版本级别按「衍生项目是否要手动处理」划分，判定规则见 spec。1.0 之前，不兼容变更提升 MINOR。
- 按需发版，不设固定周期。协调者在有值得采纳的变更时发版；安全修复尽快以 PATCH 发布。

发版流程：
1. 运行 `template-release.mjs draft` 生成升级说明草稿，人工补全后通过 PR 合并（merge-on-green）；
2. 等合并提交的 CI 与 staging 发布都成功；
3. 由协调者推送 tag。这是对外操作，需要用户确认；
4. `template-release.yml` 校验 tag 并创建 GitHub Release。它只需要 `contents: write`，不部署，也不读取任何部署凭据。

备选方案：
- 继续用 `v*` 并修改生产流水线的触发条件：衍生项目继承的生产发布语义会跟着改变，因此不采用。
- 用 changesets 管理版本：它面向发布 npm 包，按包分别打版本，与「整个模板一个版本」不符，因此不采用。

### D10 升级说明：每个版本一份，跨版本时串起来读

- 每个版本一份 `docs/upgrades/<版本号>.md`，只描述「上一版本 → 本版本」的变化。跨多个版本时按顺序串起来读，不为任意两个版本之间单独写文档，否则文档数量会随版本数平方增长。
- 骨架见 `docs/upgrades/_template.md`，frontmatter 与固定章节见 spec。`docs/upgrades/README.md` 是版本索引。
- 首个版本 0.2.0 的 `previous` 为 `v0.1.3`，覆盖 v0.1.3 之后的全部变更，包括迁移 `0013`–`0018` 与 harden 系列。xuanxue 这类早于版本体系生成的副本，也能从这份说明开始采纳。
- 升级说明随生成器复制进衍生项目，同步时按普通文件合并。文中的 `@saas/` 等标识会被生成器改名，衍生项目读到的是自己的名称。
- 「必须执行的动作」逐条写明适用条件，例如 `target=selfhost` 或 `billing=on`。同步工具按基准记录中的 `params` 过滤掉不适用的条目。

### D11 发版工具 `scripts/template-release.mjs`

只用 Node 内置模块，并加入生成器的 `templateOnly`，不复制进衍生项目。

- `draft --version <x.y.z>`：区间从上一个 `template-v*` tag 开始，没有时从 `v0.1.3` 开始，到 HEAD 为止。输出 Markdown 草稿，内容包括：
  - 按 conventional commit 前缀分组的 PR 列表；
  - 新增迁移，以及每条语句的分类：
    - 收缩：`DROP TABLE/COLUMN/CONSTRAINT`、`RENAME`、`ALTER COLUMN ... TYPE`、`SET NOT NULL`、无默认值的 `ADD COLUMN ... NOT NULL`；
    - 数据迁移：`UPDATE`、`DELETE`、`INSERT`；
    - 其余为扩展；
  - 配置差异：`template.config.ts` 的类型与默认值、两个 `wrangler.jsonc` 的绑定键、`packages/config` 环境校验的键、`.dev.vars.example` 中的密钥名、生成器写入 `PROJECT_SETUP.md` 的清单项；
  - 依赖主版本变化；
  - 建议的版本级别。
- `check --version <x.y.z>`：执行 spec 中的各项校验，失败时以非零码退出。PR 修改了 `docs/upgrades/**` 时，CI 运行 check；发布流水线也运行 check。
- `lint-migrations`：只检查本 PR 相对 main 新增的迁移，要求收缩类语句都带 `-- template-contract:` 注释，在 CI 中运行。已发布的迁移不检查，因为不允许修改。

语句分类用正则，不做 SQL 解析。分类只用来提醒，最终的类别由升级说明作者确认。如果误判为收缩，加一条注释说明即可，代价可以接受。

### D12 迁移兼容：先扩展，后收缩

部署先迁移再上线新代码，而且回滚只回退代码，所以每个版本的 schema 都必须让**上一版本的代码**也能正常运行：
- **扩展**：新建表、新增可空或带默认值的列、新建索引、新增枚举值，可以直接发布。大表加索引要在说明中注明锁表风险。drizzle 迁移在事务中执行，不能使用 `CONCURRENTLY`。
- **收缩**：分两个版本完成。
  - 版本 N：代码停止读写旧结构，必要时双写或回填新结构；
  - 版本 N+1 或更晚：执行删除、重命名或加约束，迁移带 `-- template-contract:` 注释，升级说明声明 `requiresDeployed: N`。
- **数据迁移**：必须可重复执行，例如使用 `WHERE` 条件或 `ON CONFLICT`。预计耗时超过秒级的回填交给 jobs 执行。
- **衍生项目自有代码**依赖了模板即将收缩的结构时，D5 第 4 步的迁移验证和 typecheck 会暴露问题。版本 N 的升级说明在「必须执行的动作」中提前预告这次收缩，给衍生项目一个版本的时间调整。

### D13 同步与版本衔接

- 不给 `--to` 时，取最新的 `template-v*` tag。也可以指定 `main` 或某个 SHA，这时报告标明「目标未发布」，基准记录中的 `version` 写 `null`。
- 升级说明的区间是版本 tag 所指提交满足两个条件的版本：不是基准的祖先，且是目标本身或目标的祖先。读取的是**目标树**中的升级说明，所以旧版本说明后来的勘误也会生效。
- 遇到 `requiresDeployed` 边界时，同步只到该版本。工具无法知道衍生项目实际部署到了哪个版本，所以由使用者用 `--confirm-deployed` 声明，技能在声明前先请使用者核实线上健康接口返回的版本。
- 报告列出两份清单：按 D10 过滤后的「必须执行的动作」，以及「移植的迁移 vs 说明中的迁移」。两者不一致时标为警告，不中断同步。

## Risks / Trade-offs

- [长期未同步时 diff 很大，冲突多] → 支持 `--to` 指定中间提交，可分批同步；报告按目录分组列出冲突。
- [迁移器的跳过语义与假设不符] → tasks 3.1 先用当前 drizzle-orm 版本实测，结果写进 design 和文档后再实现移植。
- [旧生成器存在已修复的缺陷，基准副本本身有问题] → 同步只看两份副本之间的差异，基准副本的问题在两侧一样，会自然抵消；生成器修复带来的差异如实呈现。
- [`pnpm install` 重新解析带来额外的依赖变动] → 报告列出锁文件中版本发生变化的包，交给使用者审查。
- [基准推断选错提交] → 只输出候选、不自动写入；同步报告中异常大的 diff 也会暴露选错的基准。
- [模板迁移依赖的表在衍生项目中已被删除或改名] → 从空库和增量两条路径执行迁移，失败即停止，由使用者处理。
- [先扩展后收缩让一次结构调整至少跨两个版本] → 接受。这是已上线衍生项目能先迁移、后部署，并且能回滚的前提。
- [升级说明靠人写，可能漏写动作] → 草稿由工具从 diff 生成；check 强制迁移清单完整、收缩迁移有说明；同步报告再核对一次迁移清单。配置类动作仍依赖作者，由发版 PR 的审阅把关。
- [`v*` 与 `template-v*` 两套 tag 容易混淆] → 在 `docs/upgrades/README.md` 与 `docs/02-project-structure.md` 写明用途；发布流水线拒绝不符合 `template-v<SemVer>` 格式的 tag。
- [正则分类 SQL 会误判] → 只用于提醒和 CI 标注，误判时补一条注释即可。

## Migration Plan

1. 模板侧合并生成器改动、同步工具、发版工具、技能和文档。新生成的项目自动带基准记录。
2. 发布首个版本 `template-v0.2.0`。升级说明覆盖 v0.1.3 之后的全部变更；推送 tag 需用户确认。
3. xuanxue-saas：
   1. 运行 `infer-base`，确认后在 xuanxue 仓库提交 `.template-base.json`；这是对该仓库的写入，需用户确认。
   2. 做一次同步到 `template-v0.2.0` 的演练，只到本地分支，产出报告作为验收证据。
   3. 是否合并由用户决定。
4. 回滚：工具是新增能力，删除 `.template-base.json` 或不运行工具即可回退；同步分支未合并前不影响衍生项目。

## Open Questions

- 基准推断的默认阈值（暂定 50 行）以 xuanxue 实测结果为准，再调整。
- 何时发布 1.0：暂定在至少两个衍生项目按版本完成过一次同步之后，届时再评估。
