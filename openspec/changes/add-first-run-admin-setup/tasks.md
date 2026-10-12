# Tasks

## 1. 管理员引导

- [x] 1.1 实现认证邮箱名单提升、创建/验证/会话触发及原子幂等审计；运行 auth bootstrap 集成测试覆盖验证条件、封禁、规范化、已有账号与重复触发。
- [x] 1.2 添加可选环境校验、.dev.vars.example 与生成器清单描述，更新管理员首次运行及撤权文档；运行 env 与生成器测试并核对无真实邮箱、部署不覆盖 secret。

## 2. 套餐模型权限

- [x] 2.1 新增后台套餐读写、路由、多选编辑及导航，复用列表和 adminAction；运行 web 套餐集成及 UI 验证，覆盖新增/移除模型权限与 403、审计、其他权益保留、非管理员拒绝、历史 key 警告。
- [x] 2.2 修改 seed 保留既有 models（首次插入仍 []），更新权限与 seed 文档；运行 billing catalog 单元及 PostgreSQL 回归测试，覆盖重跑与并发保留。

## 3. 集成与交付

- [x] 3.1 运行 openspec validate --strict、pnpm check、check:deps、check:singletons、typecheck、test、build、dedupe --check 以及生成器验收；记录通过结果与任何未完成外部验收。
- [ ] 3.2 rebase origin/main 后复核，提交并推送同一 PR（提案与实现）；PR 说明 Worker secret、流水线不会覆盖及协调者合并后配置 staging，卡片设 in-review 并评论 PR 号。
