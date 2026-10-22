# Tasks

## 1. 模块

- [x] 1.1 实现 `packages/shared/src/fx.ts`：校验、缓存读写、拉取与回退
- [x] 1.2 经 `@saas/shared/fx` 子路径导出公共接口（不进入根入口）

## 2. 测试

- [x] 2.1 `fx.test.ts`：校验规则、缓存命中与未命中、失败回退且不写缓存、损坏缓存、署名常量

## 3. 验收

- [x] 3.1 `pnpm --filter @saas/shared typecheck` 与 `test` 通过
- [ ] 3.2 项目接入页面展示前，确认署名链接显示在使用汇率的页面上（由接入项目验收）
