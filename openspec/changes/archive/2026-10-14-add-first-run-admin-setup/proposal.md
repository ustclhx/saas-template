# Proposal

## Why

新项目没有首次管理员入口，创建 AI 模型后也无法在后台配置套餐模型权限，导致普通用户第一次调用返回 403。将首次运行配置与权限维护纳入已有认证及后台审计流程。

## What Changes

- 新增可选 Worker secret `BOOTSTRAP_ADMIN_EMAILS`；仅名单内、邮箱已验证且未封禁的用户可自动提升为平台 admin，提升与审计保持幂等。
- 在用户创建、邮箱验证持久化及会话创建后执行提升；移除名单不会自动降权。
- 新增 `/admin/billing/plans` 套餐模型权限列表及多选编辑，只更新 `features.models`，保留其他权益和不存在的模型 key。
- billing seed 重跑保留已有套餐模型权限；free 默认仍为 `[]`。
- 更新生成器环境清单、首次运行文档及 staging 验收指引。

## Capabilities

### New Capabilities

- `admin-bootstrap`: 已验证邮箱名单的首次管理员提升与审计。
- `plan-model-access`: 后台编辑套餐模型权限及 seed 保留策略。

### Modified Capabilities

无。admin-console 与 entitlements 尚在未归档 change 中，本 change 使用独立 ADDED requirements。

## Impact

影响 packages/auth、config 环境校验、billing catalog seed、web 后台路由与导航、项目生成器及文档。不新增外部库、schema 或迁移，不编辑价格，不调整默认权益，不部署或修改 staging；配置由协调者合并后完成。
