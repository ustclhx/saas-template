# Design

## Context

动机见 proposal.md。createAuth 已合并个人空间的 databaseHooks，并有 afterEmailVerification 用于赠送积分。Better Auth 1.7.7 的创建后钩子在事务提交后运行。平台角色与封禁存 user，系统 actor 为空的 audit_log 已存在。后台通过 withAdminAction / adminAction 进行实时鉴权及事务审计，列表复用 DataTable 与 list.ts。getEntitlements 每请求直读 plan，无跨请求权限缓存。seedCatalog 目前 upsert 全部 values，会覆盖 features.models。

## Goals / Non-Goals

**Goals:** 在已验证邮箱这个信任边界上提升管理员；原子且并发幂等；套餐更新只影响 models 并在下一请求生效；复用已有模块与审计路径。

**Non-Goals:** 自动降权、配置 staging、改变 free 默认策略、编辑价格或其他权益、创建新 schema/迁移、增加通用权限框架。

## Decisions

1. BOOTSTRAP_ADMIN_EMAILS 作为可选 Worker secret，本地为 .dev.vars。逗号分割、trim、lowercase，空值禁用。AuthEnv 与 app env schema 接纳该字段，生成器清单标记 optional 并描述。secret 不放 wrangler vars 或 CI 模板中，部署不会覆盖已有 secret。相比硬编码名单，支持独立配置且仓库不保存真实邮箱。
2. auth 包新增内部 bootstrap helper；用户创建后、邮箱验证持久化后、会话创建后触发。另使用 user.update.after 覆盖 OTP / magic link 的已验证状态持久化，保证认证方式一致。与个人空间及注册赠送钩子组合，保留现有行为。使用 Drizzle transaction（也支持后台传入事务的嵌套 savepoint），避免依赖仅普通 Database 具备的 $client。auth 直接声明工作区已有的 drizzle-orm 同版本依赖，保持唯一实例。候选用户从数据库重读，在事务内条件 UPDATE：已验证、规范化邮箱在名单、banned 不为 true、角色列表尚不含 admin。RETURNING 成功才追加 admin.user.bootstrap（system actor，target user，meta.trigger、角色前后）；角色与审计同事务，失败传播而不吞错。并发 UPDATE 重新检查条件，使已 admin 无重写、无重复审计。仅在 auth 事件提升，移除配置不降权；后台守卫直接读 DB，不需要等待 Cookie / KV 用户副本刷新。
3. 新增 /admin/billing/plans，读取套餐及所有 ai_model keys。使用现有列表解析与 DataTable；编辑多选 key 及 '*'。不存在的当前 key 保留为可取消的选项并警告（含历史标签），不静默删除；新输入仅接受现有 key、'*' 或此套餐原有值。空数组允许明确撤销全部权限。服务端校验长度、非空字符串和去重；JSONB 更新当前 features 的 models 字段，行锁防止并发覆盖其他字段。价格及其他权益字段不暴露为写参数。
4. 写入通过 withAdminAction/adminAction，审计 admin.plan.models.update 记录 models before/after。复用实时会话、封禁、模拟登录限制，拒绝普通用户。权限直接读库，无 KV 失效工作；已有请求保留其快照，下个请求看到新权限。
5. seedCatalog 冲突更新保留数据库已有 features.models（包括空数组、'*'、历史 key），其他 seed 字段按现有规则更新。使用 upsert 中 JSONB 表达式，避免读写竞争；首次插入仍使用示例默认 []。相比文档告知 seed 会覆盖权限，安全保留防止意外撤权。
6. 测试复用 auth 与 web/billing 集成环境；验证真实 Better Auth 触发、审计幂等/并发、安全边界；后台更新与 can()/withEntitlement 的允许及 403，保留其他 fields、非 admin 拒绝、seed 重跑保留。无外部 AI 调用或 staging 写入。

## Risks / Trade-offs

- [邮箱未验证即获得管理员] → helper 每次以持久化 emailVerified 和 banned 为准，默认无需验证登录也不能绕过。
- [认证回调重复或并发] → 条件更新与审计同事务，已 admin 不写；失败后重新登录重试。
- [名单撤销不撤权] → 明确文档说明，撤权由运维显式修改数据库平台角色，当前后台不提供角色修改入口；禁用引导前核对角色。
- [历史授权 key 无法匹配模型] → 保留并显示警告，不新增任意未知 key。
- [配置名单存在的账号被手动降权后重新提升] → 名单仍有效时登录会再次提升；撤权先移除名单。

## Migration Plan

无 schema 变更。合并后协调者配置 staging 的 Worker secret。新项目迁移与 billing:seed 后配置名单，已验证账号登录，后台创建模型并为套餐授权。回滚代码不会自动撤销已授予角色或 models；由管理员显式调整。

## Open Questions

- staging secret 的具体邮箱及合并后部署验收时机由协调者提供；仓库与本 PR 不保存真实邮箱，也不提前勾选部署验收。
