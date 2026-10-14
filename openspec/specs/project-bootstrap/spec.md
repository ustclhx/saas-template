# project-bootstrap Specification

## Purpose

把模板复制成一个新项目时，自动完成改名与配置生成，并给出需要手动创建的基础设施与密钥清单，减少遗漏。

## Requirements

### Requirement: 生成新项目
创建脚本 SHALL 根据输入的项目名称、域名、默认语言与功能开关，生成改名后的项目副本：包名、Worker 名、模板配置与站点文案中的品牌占位符都被替换；生成的项目 SHALL 能直接通过类型检查与单元测试。

#### Scenario: 创建新项目
- **WHEN** 运行脚本并输入名称 `acme`、域名 `acme.example`
- **THEN** 生成的项目中不再出现模板原名称，`pnpm typecheck` 与 `pnpm test` 通过

### Requirement: 基础设施与密钥清单
脚本 SHALL 根据所选功能输出需要创建的 Cloudflare 资源、外部服务账号与密钥列表，并为本地开发生成根目录 `.env.example` 与 app 认证用 `.dev.vars.example`；这些模板 SHALL 只包含键名、占位符或非敏感默认值，不包含模板仓库本地配置的真实值。

#### Scenario: 关闭视频功能
- **WHEN** 创建时关闭图片与视频功能
- **THEN** 输出的清单中不包含媒体服务商密钥与 Workflow 相关资源

### Requirement: 不复制敏感与运行时数据
生成的项目 MUST NOT 包含模板仓库中的密钥、根目录或任意子目录的 `.env.local`、`.env.worktree`、`.dev.vars` 真值文件、git 历史或 OpenSpec 的进行中变更；配置模板 MUST NOT 从这些本地真值文件生成。

#### Scenario: 模板含本地真值与 worktree 配置
- **WHEN** 模板根目录或子目录中存在 `.env.local`、`.env.worktree` 或 `.dev.vars`
- **THEN** 生成的项目中没有这些文件及其真值，生成的根目录 `.env.example` 与 app `.dev.vars.example` 只包含键名、占位符或非敏感默认值
