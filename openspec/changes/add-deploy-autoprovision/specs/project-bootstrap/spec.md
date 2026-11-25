## MODIFIED Requirements

### Requirement: 基础设施与密钥清单
脚本 SHALL 根据所选功能输出需要创建的 Cloudflare 资源、外部服务账号与密钥列表，并为本地开发生成根目录 `.env.example` 与 app 认证用 `.dev.vars.example`；这些模板 SHALL 只包含键名、占位符或非敏感默认值，不包含模板仓库本地配置的真实值。Cloudflare 目标的清单 SHALL 区分由部署资源解析自动查找或创建的资源（KV、R2 桶、队列）与仍需人工提供的资源（Hyperdrive 的数据库连接、自定义域名、Turnstile 站点），并给出运行资源解析计划的命令。

#### Scenario: 关闭视频功能
- **WHEN** 创建时关闭图片与视频功能
- **THEN** 输出的清单中不包含媒体服务商密钥与 Workflow 相关资源

#### Scenario: Cloudflare 项目的资源清单
- **WHEN** 以 Cloudflare 为目标创建项目
- **THEN** 清单把 KV、R2 桶与队列列为部署时自动解析，把 Hyperdrive 列为需提供连接串，并给出只读资源计划命令；生成的 wrangler 配置中 staging 与 production 的资源 ID 均为可识别的占位值

## ADDED Requirements

### Requirement: 限流命名空间按项目分配
生成器 SHALL 为新项目的每个限流绑定在每个环境分配 `namespace_id`，同一项目内互不相同，且按项目名称落在确定的号段内，以降低同一 Cloudflare 账号下不同项目共用计数的概率；同一输入的生成结果 MUST 确定。

#### Scenario: 同账号两个项目
- **WHEN** 以名称 `acme` 与 `globex` 分别生成项目
- **THEN** 两个项目各自的限流 `namespace_id` 不重复，`acme` 自身三个环境、全部限流绑定之间也不重复

#### Scenario: 重复生成
- **WHEN** 以相同输入两次生成 `acme`
- **THEN** 两次生成的 `namespace_id` 完全相同
