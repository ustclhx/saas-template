# Design

## Context

动机见 proposal.md。生成器已有非交互参数与真实副本自检；staging-deployment 是现有 spec，实际 runbook 是 staging-neon / p2-staging-preparation，任务指定的 staging-deployment.md 不存在。根 README 不存在，现有文档入口是 docs/README.md。OpenSpec 双目录使用普通文件，差异仅在各 agent 的调用语法；新技能沿用普通文件方式并统一正文，不追改已有技能。

## Goals / Non-Goals

**Goals:** 让技能能根据当前源码执行并给出可核验的结果；对缺凭据、功能开关、目标环境和外部副作用给出明确分支。

**Non-Goals:** 不建立新部署器或页面代码生成器；不调整平台契约、迁移、依赖、现有 OpenSpec 技能或发布 workflow；不将本次离线结果冒充线上验收。

## Decisions

1. 每个技能一个 SKILL.md，`.agents` 为编写入口，复制到 `.claude` 并逐字节核对。避免 symlink，因为 create-project 明确跳过符号链接；不为八个文件新增同步框架。
2. 引用根目录相对路径，使用者先定位含 package.json/template.config.ts 的项目根。生成器会改包 scope，因此命令里的 @saas 必须从副本 manifest 读取替换。指向真实源码与 runbook，条件性细节按需阅读。
3. quick-start 先收集全部选项再调用已有生成器；默认安装/typecheck/unit，随后单独记录本地 PG、管理员、AI 的凭据依赖。列出已有集成 key 的取得入口与三层归属，不为用户自动申请外部服务。
4. 部署参数是自然语言技能输入，不声称存在新的 shell CLI。默认生成只读预检报告和动作计划；任何创建/迁移/seed/secret/发布之前检查用户是否明确批准该清单。重复执行按名称/ID/环境复核后跳过现有资源，有冲突则停止，不吞掉 create 错误。现有仓库 staging 仍只由 main 发布；新项目环境按自己的配置建立。
5. new-page/new-module 以现有 admin/app 与领域服务为模式；优先复用表和 package，强制鉴权/租户边界与积分 API。样例在临时副本验证并丢弃，不提交样例或新生产抽象。
6. security-scan 复用工程检查、staging secret 名称预检及现有 Git/rg 能力；后者并非泄漏扫描，技能要明确区别。扫描敏感文件路径与凭据特征时只输出文件名/行号，不展示值。无需引入第三方扫描依赖。

## Risks / Trade-offs

- 文档与源码漂移 → 命令执行前读取 manifest/help，引用路径与双目录 byte 比对；实际样例 forward-test。
- 复制双份维护成本 → docs 写明编辑一处后同步另一处；提交前逐文件 cmp。
- 缺外部凭据 → 精确报告哪些环节未验收；本次部署类只读/dry-run，不请求凭据或访问线上写接口。
- 安全扫描无法证明无漏洞 → 保留鉴权、注入、Webhook、SSRF、积分与敏感产物的 diff 审查，报告扫描范围与未覆盖内容。

## Migration Plan

新增文件可直接被支持项目技能目录的 agent 发现。回退删除本次新增技能与文档入口即可，无数据迁移。保持 change 未归档，由协调者合并后统一处理。
