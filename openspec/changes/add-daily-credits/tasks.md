# Tasks

## 1. 积分领取核心

- [x] 1.1 增加 daily 来源和持久领取表，复用邮箱防刷并实现原子日/月额度、个人空间校验与有效期，相关类型检查及 Postgres 集成测试通过（同日并发、跨账号、D+1、月末并发、跨月、未验证、黑名单、关闭零查库、退款隔离）

## 2. 配置与运营指标

- [x] 2.1 增加模板开关、运行时默认值和后台校验表单，扩展现有 metrics 汇总及展示，相关设置和指标测试及类型检查通过

## 3. App 接线

- [x] 3.1 在 App 服务端入口惰性触发并加入用户日期短期缓存、模拟会话跳过与失败隔离，最小领取提示、验证入口及 daily 用量流水多语言接线，缓存与关闭零查库回归及相关 web 测试通过

## 4. 集成与交付

- [x] 4.1 drizzle-kit push 同步隔离 worktree 库，升级草稿记载 schema、配置和 DailyGrantNotice 交接，执行 pnpm check、typecheck、check:deps、check:singletons 及相关包含 Postgres 测试并保存证据
- [ ] 4.2 复核 diff 与严格 OpenSpec 验证，中文 conventional commit、推送并创建到 main 的 PR，PR 列出 schema 变化、验证结果及协调者待办
