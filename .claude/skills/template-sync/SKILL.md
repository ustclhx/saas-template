---
name: template-sync
description: 在由本模板生成的衍生项目中采纳模板更新：只读预检基准、版本区间与升级说明，在本地同步分支上三方合并、移植模板迁移并验证；推送、开 PR、线上迁移与外部配置前先列动作清单并确认。
---

# 采纳模板更新

在衍生项目根执行（含 `.template-base.json` 与 `template.config.ts`）。技能接受 `--to <template-v版本|分支|SHA>`，
默认取最新的 `template-v*` 发布；这是技能输入，不是新 shell CLI。完整阅读 `docs/create-project.md`
「采纳模板更新」与 `docs/upgrades/README.md`；迁移约定见 `docs/02-project-structure.md` §4。
同步脚本始终取自**目标版本**的模板克隆，不运行项目里的旧副本。

## 1. 只读预检

1. 工作区：`git status --porcelain --untracked-files=all` 必须为空；记录当前分支与完整 SHA。有改动时停止，
   请使用者先提交或清理，不代为 stash 或丢弃。
2. 基准：读取 `.template-base.json`。文件不存在、校验失败或 `clean=false` 时转到第 5 节「基准推断」。
3. 克隆目标模板到临时目录，用该克隆查版本区间（不修改项目）：

```sh
TEMPLATE_DIR=$(mktemp -d)
git clone --filter=blob:none <repository> "$TEMPLATE_DIR"
git -C "$TEMPLATE_DIR" tag --list 'template-v*' --sort=-v:refname | head
git -C "$TEMPLATE_DIR" log --oneline <基准 commit>..<目标>
```

4. 升级说明：区间内每个版本读目标树的 `docs/upgrades/<版本>.md`，整理：
   - 按基准 `params` 过滤后的「必须执行的动作」，标明哪些涉及外部系统（新 secret、部署绑定或资源、
     GitHub variables/environment、线上迁移）；
   - `requiresDeployed` 边界：边界版本未在线上部署时，本次目标改为边界版本；
   - 「数据库变更」中的迁移、类别与锁表风险；项目若删除过模板迁移依赖的表，列出需要 `--skip-migration` 的 tag。
5. 输出预检报告：基准与目标（版本或 SHA）、提交数、待办动作、边界、待移植与拟跳过的迁移。
   默认停在这里，等使用者确认目标与跳过清单。

## 2. 在本地分支同步

使用者确认后执行；工具只在新分支 `template-sync/<目标短 SHA>` 上提交，不推送、不合并：

```sh
node "$TEMPLATE_DIR/scripts/template-sync.mjs" sync --project . --to <目标> \
  [--skip-migration <tag>]... [--confirm-deployed <版本>]... [--verify-db <空的隔离库 URL>]
```

- `--verify-db` 只能指向使用者提供的空的隔离库，绝不使用 staging/production 或开发主库。
  未提供时报告中数据库验证为跳过，需在交付中说明。
- `--confirm-deployed` 只在使用者核实线上健康接口返回的版本后才加；不得凭推测越过边界。
- 退出码：0 为已是最新或同步完成；1 为冲突或验证失败；2 为预检失败（未改动项目）。

## 3. 读报告与处理冲突

报告路径打印在终端（`<git 目录>/template-sync/<短 SHA>.md`）。逐项核对：已应用变更、冲突文件、
`PROJECT_SETUP.md` 变化、锁文件版本变化、移植与跳过的迁移、升级说明待办与迁移核对告警、验证结果。

冲突逐个处理：先比较模板侧（`git diff refs/template-sync/base refs/template-sync/target -- <文件>`）
与项目侧改动，向使用者说明取舍后再改；不得整体采用任一方，不得删除冲突文件了事。
「模板删除了项目改过的文件」需使用者决定保留或删除。全部解决并提交后，在同步分支上用相同参数重跑第 2 节，
工具会跳过文件合并、继续迁移移植与验证。`PROJECT_SETUP.md` 的新增清单项按需手动吸收。

## 4. 迁移核对与验证

- 移植的模板迁移在 `packages/db/migrations` 末尾，文件名带 `tpl_`；核对其在项目自有迁移之后、
  journal `when` 递增，且报告中 `drizzle-kit generate` 无变化。
- 验证失败时修复并提交后重跑；基准记录只在无冲突且验证全部通过时更新到目标。
- 升级说明里的数据库风险（锁表、全表更新、不可逆数据迁移）写入交付说明，供上线时安排窗口与备份。

## 5. 基准推断（无记录或记录不可信）

```sh
node "$TEMPLATE_DIR/scripts/template-sync.mjs" infer-base --project . [--since YYYY-MM-DD --until YYYY-MM-DD] [--param key=value]...
```

展示还原的参数（及来源）、前 5 个候选、最佳候选的差异摘要；超过阈值时不写入。使用者选定后
`--write <sha>` 写入 `.template-base.json`，审阅并由使用者确认后再提交，然后回到第 1 节。

## 6. 交付与授权边界

完成条件：同步分支无冲突、验证全部通过、基准记录指向目标；报告与待办清单交给使用者。
以下动作必须先列出具体清单并获得明确确认，确认范围变化需再次确认：推送同步分支、开 PR、合并；
任何环境的数据库迁移；升级说明中的外部动作（创建队列等资源、写 secret、GitHub variables/environment）。
secret 只列名称与配置位置，不读取、不输出、不写入其值；报告中的邮箱与本机路径不进入公开 PR。
外部动作可交给 `deploy-cloudflare` 或 `deploy-selfhost` 技能按其流程执行。

## 常见故障

| 现象 | 处理 |
| --- | --- |
| 预检报基准 clean=false 或缺失 | 运行第 5 节基准推断 |
| 旧生成器拒绝参数 | 基准过旧或参数被手改；核对 `.template-base.json` 的 params，必要时重新推断 |
| 同步分支已存在 | 切到该分支继续，或确认无用后删除再同步 |
| 模板修改了已发布迁移 | 同步停止；向模板维护者反馈，不手改迁移 |
| 迁移因缺表失败 | 项目删除了该表；确认后用 `--skip-migration`，并检查依赖它的代码 |
| `drizzle-kit generate` 有变化 | 合并后 schema 与迁移不一致，多为冲突解决遗漏 schema 文件 |
| 停在 `requiresDeployed` 边界 | 先部署边界版本，核实健康版本后用 `--confirm-deployed` 继续 |
