# Tasks

> 依赖顺序：1 → 2 ∥ 4 ∥ 5.1–5.4 → 3 → 5.5 → 6 → 5.6 → 7。
> - 5.6 推送首个 tag `template-v0.2.0`，是对外操作，需用户确认；
> - 第 7 组写入 xuanxue-saas 仓库，需用户确认后由协调者执行。

## 1. 生成器：基准记录与确定性

- [x] 1.1 `create-project.mjs` 新增参数规范化与序列化：默认值展开、键排序、列表去重保序，不含 `output`。单元测试覆盖交互输入与非交互输入得到相同的规范化结果
- [x] 1.2 生成时写入 `.template-base.json`：`schemaVersion`、`repository`（去凭据的 https）、`commit`、`version`、`clean`、`params`、`migrations`。
  - `version` 只在源提交恰好是 `template-v*` tag 时填写，否则为 `null`；
  - 源有未提交改动或不是 git 仓库时，`clean=false`；
  - 源副本中已有的记录不复制。

  测试覆盖：干净源、打了 tag 的源、带改动的源、用副本再生成，并断言记录中没有绝对路径和个人信息
- [x] 1.3 新增确定性测试：同一源、同一参数输出到两个不同目录，比较文件列表、内容与权限位完全一致；Cloudflare 与 selfhost 各覆盖一组参数
- [x] 1.4 把 `scripts/template-sync.test.mjs`、`scripts/template-release.mjs` 及其测试加入 `templateOnly`。文档更新：
  - `docs/create-project.md` 说明 `.template-base.json` 的用途与字段；
  - `docs/02-project-structure.md` 列出该文件

## 2. 同步工具：生成与三方合并

- [x] 2.1 新增 `scripts/template-sync.mjs sync`，实现预检：读取并校验基准记录、`clean=true`、工作区干净、模板仓库可达、基准与目标不同。失败时不创建分支。测试覆盖缺少记录、记录不干净、工作区有改动、已是最新四种情况
- [x] 2.2 在临时目录浅克隆模板，`git archive` 出基准与目标两棵干净树，在各自树中运行其自带生成器（`--skip-check`），参数由 `params` 还原。旧生成器拒绝参数时，报出参数名与提交后停止。测试用临时 git 仓库模拟两个模板提交
- [x] 2.3 把两份副本提交进临时仓库，fetch 到项目的 `refs/template-sync/*`，在新分支 `template-sync/<短 SHA>` 上对排除项之外的 diff 执行 `git apply --3way --index`。排除项：迁移目录、`.template-base.json`、`PROJECT_SETUP.md`、`pnpm-lock.yaml`。测试覆盖：
  - 无冲突修改；
  - 同一段落冲突，保留冲突标记并列入报告；
  - 项目已填真实资源 ID，模板改了同文件其它位置，ID 保持不变；
  - 模板删除了项目改过的文件，报告冲突
- [x] 2.4 合并后处理依赖与验证：
  - 任一 `package.json` 有变化时运行 `pnpm install`，再用 `--frozen-lockfile` 确认；
  - 然后运行 typecheck、test；
  - 生成报告：变更、冲突、`PROJECT_SETUP.md` 的 diff、锁文件中版本变化的包、验证结果；
  - 只有无冲突且全部通过时，才更新基准记录的 `commit` 与 `version`。

  测试断言验证失败时记录不变
- [x] 2.5 `docs/create-project.md` 新增「采纳模板更新」一节：命令、报告解读、按版本分段同步、`requiresDeployed` 边界、冲突处理

## 3. 迁移移植

- [x] 3.1 用当前 drizzle-orm 版本实测迁移器的跳过语义：
  - 向已应用迁移的库插入一个 `when` 更早的迁移，确认它被跳过；
  - 再插入一个 `when` 更晚的迁移，确认它被执行。

  把结论写入 design D5 与 `docs/02-project-structure.md` 的迁移约定
- [x] 3.2 实现移植：
  - 取目标相对基准新增、且未登记的模板迁移，按序追加为 `<idx>_tpl_<名>.sql`；
  - 写 journal，`when` 递增且晚于项目已有的全部迁移；
  - 中间迁移的 snapshot 沿用前一个并更新 id 链，最后一个 snapshot 由对合并后 schema 运行 `drizzle-kit generate` 得到；
  - 把原 tag 追加到 `migrations`；
  - 基准中已有的模板迁移内容改变时停止；
  - `--skip-migration <tag>` 跳过的迁移不移植，但登记为已处理。

  测试用 fixture 覆盖四种情况：与项目自有迁移撞号、再次同步不重复移植、模板修改已发布迁移、跳过迁移
- [x] 3.3 移植后的验证接入同步报告：
  - `drizzle-kit generate` 无变化；
  - 有隔离数据库时，空库全量迁移成功；
  - 执行到项目自有最后一个迁移的库，增量迁移成功。

  Postgres 集成测试覆盖增量路径会执行移植的迁移
- [x] 3.4 `docs/02-project-structure.md` 写明迁移约定：
  - 已发布迁移不修改；
  - 迁移不依赖固定 idx；
  - 项目迁移与 `tpl_` 移植迁移的命名区分；
  - 先扩展后收缩（design D12）与 `-- template-contract:` 注释

## 4. 基准推断

- [x] 4.1 新增 `template-sync.mjs infer-base`：从项目首个提交还原参数（来源见 design D7），无法还原的项要求以 `--param key=value` 补齐。用一个已知参数生成的 fixture 副本做测试，断言还原结果与原参数一致
- [x] 4.2 在 `--since/--until` 时间窗内对模板 main 的每个提交生成副本并评分：
  - 只统计生成路径的差异行数，项目独有文件单独列出；
  - 输出前 5 个候选与差异摘要；
  - 用户确认后（`--write <sha>`）才写入记录，`migrations` 取该提交中已有的模板迁移，`version` 按该提交是否为发布 tag 填写。

  测试断言对 fixture 选出正确提交，超过阈值时拒绝写入

## 5. 版本、发版与升级说明

- [x] 5.1 新增 `docs/upgrades/`：
  - `README.md`：版本索引，并说明 `template-v*` 与 `v*` 两套 tag 的用途与版本级别规则；
  - `_template.md`：frontmatter 与固定章节骨架，见 spec「每个版本的升级说明」。

  `docs/02-project-structure.md` 链接到该目录
- [x] 5.2 新增 `scripts/template-release.mjs draft`：
  - 区间：上一个 `template-v*` tag 到 HEAD，没有时从 `v0.1.3` 开始；
  - 内容：PR 分组、迁移语句分类、`template.config.ts`、wrangler 绑定、环境校验键、`.dev.vars.example` 密钥名、`PROJECT_SETUP.md` 清单项的差异、依赖主版本变化、建议的版本级别。

  fixture 测试覆盖：扩展、收缩、数据迁移三类语句；没有上一 tag 的起点；新增密钥判定为不兼容
- [x] 5.3 新增 `lint-migrations`：检查相对 main 新增的迁移，收缩类语句必须带 `-- template-contract:` 注释，接入 CI。测试覆盖：
  - 未标注的 `DROP COLUMN` 失败；
  - 已标注的通过；
  - 已发布的迁移不检查
- [x] 5.4 新增 `check` 与 `.github/workflows/template-release.yml`：
  - `check` 校验 frontmatter 与 tag 区间一致、迁移清单完整、收缩迁移有说明与 `requiresDeployed`、不兼容时版本级别正确、索引已更新；PR 修改了 `docs/upgrades/**` 时，CI 运行 check；
  - 流水线由 `template-v*` 触发：校验 tag 格式、提交在 main 上、该提交的 CI 与 staging 发布都成功，并通过 check，然后用升级说明创建 GitHub Release；
  - 流水线权限只有 `contents: write`，不部署，也不读取部署凭据。

  测试覆盖 check 的每条失败规则
- [x] 5.5 同步与版本衔接（design D13）：
  - 不给 `--to` 时取最新 `template-v*`，非发布目标在报告中标明；
  - 报告汇总区间内的升级说明，按 `params` 过滤出适用的「必须执行的动作」；
  - 核对移植的迁移与说明中的迁移清单；
  - 遇到 `requiresDeployed` 边界时只同步到该版本，`--confirm-deployed` 声明后才继续。

  测试覆盖：默认目标、跨边界停止、声明后继续、基准位于两个版本之间、清单不一致告警
- [ ] 5.6 发布首个版本 `template-v0.2.0`：
  - 用 draft 起草 `docs/upgrades/0.2.0.md`，`previous: v0.1.3`，覆盖 harden 系列与迁移 `0013`–`0018`，逐个写明类别、兼容性与回滚；
  - 通过 check 后开发版 PR，合并后等 CI 与 staging 发布成功；
  - 推送 tag 前向用户确认，推送后核对 GitHub Release 内容

## 6. template-sync 技能

- [ ] 6.1 新增 `.agents/skills/template-sync/SKILL.md`，并复制到 `.claude/skills/template-sync/SKILL.md`，两份逐字节一致。内容包括：
  - 只读预检：基准、版本区间、升级说明待办、`requiresDeployed` 边界、待移植迁移；
  - 克隆目标版本模板并运行其同步脚本；
  - 读报告，逐个处理冲突；
  - 按升级说明逐项处理必须执行的动作；涉及密钥、绑定、线上迁移的，只列出名称与位置，取得确认后才执行；
  - 迁移核对；
  - 推送、开 PR 与线上迁移前，先列出动作并取得确认；
  - 没有基准时转入基准推断；
  - 常见故障。

  用现有的技能一致性检查与引用可解析检查验证
- [ ] 6.2 在 `quick-start` 技能的生成后步骤中提示 `.template-base.json` 需要提交，并指向 template-sync；更新 agent-skills 相关文档中的技能清单

## 7. 集成验收

- [ ] 7.1 模板侧端到端：
  1. 在临时模板仓库中，对较早提交和当前提交分别打 `template-v*` tag，并补齐两份升级说明；
  2. 从较早版本生成一个临时项目，在其中加入一个自有修改和一个自有迁移；
  3. 同步到较新版本。

  断言：
  - 自有修改保留；
  - 模板迁移追加在自有迁移之后；
  - 升级说明待办出现在报告中；
  - 基准记录的 `version` 已更新；
  - typecheck 与单元测试通过。

  证据写入 `EVIDENCE_DIR`
- [ ] 7.2 xuanxue-saas 基准推断：
  - 在 2026-10-16 至 2026-10-20 的时间窗内运行 `infer-base`；
  - 把候选与差异摘要提交给用户确认；
  - 确认后在 xuanxue 仓库提交 `.template-base.json`。这是对外写入，需用户批准
- [ ] 7.3 xuanxue-saas 同步演练：同步到 `template-v0.2.0`，只到本地分支，不推送。报告内容：
  - 冲突；
  - 升级说明待办；
  - 移植的迁移：`0013_node_job_engine` 起应排在 `0013_superb_excalibur` 之后；
  - 验证结果。

  证据写入 `EVIDENCE_DIR`。是否继续合并由用户决定
