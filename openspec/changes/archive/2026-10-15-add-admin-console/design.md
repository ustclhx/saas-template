# Design

## Context

前面的 change 已经提供了后台所需的大部分底层能力：Better Auth `admin` 插件（封禁、模拟登录）、`packages/credits` 的 `grant` / 收回、回调重放、退款审核、模型编辑、`setting` 表与 `audit_log` 表。本 change 主要是把这些能力组织成可用的后台，并补上审计与权限约束。动机见 proposal.md。

## Goals / Non-Goals

**Goals:**
- 所有后台写操作经过同一个「审计 + 实时权限校验」包装。
- 后台页面统一用 TanStack Table 的列表 / 详情模式，降低后续扩展成本。

**Non-Goals:**
- 细粒度的后台权限（只读管理员、客服角色等）：首版只有 admin 一种。
- 审计日志导出、外部 SIEM 对接。

## Decisions

1. **后台写操作包装**：`adminAction(name, handler)` 统一执行 `requireFreshSession` + 角色校验 + 审计写入（与业务写入同一事务）。审计与业务同事务，避免「操作成功但没有审计」。
2. **模拟登录限制**：使用 Better Auth `admin` 插件的 impersonate；会话带 `impersonated_by`，在 `requireFreshSession` 中对模拟会话拒绝结账、退款申请、删号、修改密码 / 两步验证。页面顶部固定横幅显示被模拟用户与退出按钮。
3. **积分调整幂等**：后台表单提交时生成调整 ID（客户端生成 UUIDv7），以 `audit_log.id = 调整 ID` 作为 `credit_grant.source_ref`，重复提交命中唯一约束。
4. **审计只追加**：应用层不提供更新 / 删除接口；数据库层对 `app` 账号撤销 `audit_log` 的 UPDATE / DELETE 权限。
5. **指标计算**：每日 Cron 汇总到一张 `metrics_daily` 表（注册、付费空间数、MRR、积分消耗、平台承担超额、任务成功率），看板只读汇总表，避免在后台实时扫大表。MRR 按生效订阅的月化价格计算（年付除以 12）。
6. **设置生效**：`setting` 写入后删除对应 KV 键；读取侧最多约 60 秒的 KV 传播延迟，已在 spec 中说明。

## Risks / Trade-offs

- [管理员误操作影响大] → 封禁、收回积分、恢复空间需要二次确认并填写原因。
- [指标为日级汇总，不实时] → 看板标注数据截至时间；需要实时数据时直接看 AI Gateway 与支付平台后台。

## Migration Plan

新增 `metrics_daily` 表与 `audit_log` 权限调整；对已有审计记录无影响。

## Open Questions

（无）
