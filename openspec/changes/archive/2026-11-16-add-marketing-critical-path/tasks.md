# Tasks

按顺序在一个分支内完成（改动集中在 `apps/web/scripts/` 与根布局）。

## 1. 字体预加载扩展点

- [x] 1.1 新增项目自有文件 `apps/web/src/features/theme/fonts.project.ts`（`projectFontPreloads(defaults)` 默认原样返回），`@saas/ui/fonts` 导出 `FontPreload` 类型，`root-document.tsx` 改用它；`scripts/template-release.mjs` 项目自有文件清单登记该路径（design D1）。验证：`root-document.test.tsx` 覆盖默认输出 Inter preload、扩展点返回 `[]` 时无字体 preload、返回替换列表时只预加载替换项；`node --test scripts/template-release.test.mjs` 通过。
- [x] 1.2 构建后处理：`brand.css`（去注释后）声明 `--font-sans` 且首页仍含 Inter preload 时打印警告。验证：单测覆盖有 / 无覆盖与注释中的示例不触发。

## 2. 客户端入口去掉配置校验

- [x] 2.1 `apps/web/scripts/client-template-config.ts` 插件（只作用于 client 环境，JSON 不可往返时构建失败），接入 `vite-shared.ts`；`security-client.ts` 改为只导入 `config`（design D2）。验证：插件单测（client 环境返回 JSON、ssr 环境不处理、含函数的配置抛错）；构建后首页闭包不再有 `template-config` 分包。
- [x] 2.2 `check-home-bundle.mjs`：客户端首页闭包禁止 zod schema 标记；读取 `homeScriptGzipBudget`，超出失败。验证：`check-home-bundle.test.ts` 新增 zod 标记与预算超出 / 未超出 / 未设置用例。

## 3. 营销页关键路径

- [x] 3.1 `packages/config`：`marketing.performance` 类型、默认值与校验（`hydration`、`criticalCss`、`homeScriptGzipBudget`）。验证：`template.test.ts` 覆盖默认值、合并与非法值。
- [x] 3.2 `vite-shared.ts` 在构建时写出 `dist/.build/marketing-performance.json`；`inline-critical-css.mjs` 按配置处理：`used` 用 beasties 裁剪并补回全部 `@font-face`、`after-paint` 去 modulepreload 并改为首帧后加载器、样式表也由加载器追加；处理前后 head 比对（design D3）。纯函数拆到 `scripts/marketing-html.mjs` 便于测试。验证：`marketing-html.test.ts` 用夹具 HTML 覆盖四种组合、`@font-face` 补回、`.dark` 规则保留、加载器内容、head 改动时报错、配置文件缺失时按默认。
- [x] 3.3 模板 `template.config.ts` 启用 `after-paint`、`used` 与预算（design D4）；`pnpm --filter @saas/web build` 通过，首页 HTML 不含 modulepreload 与外链样式表。验证：构建日志与产物检查。

## 4. 验收

- [x] 4.1 视觉一致：Playwright 脚本（`apps/web/scripts/check-critical-css.mjs`）对预渲染的 `/`、`/zh`、`/blog`、`/blog/welcome`、`/legal/privacy`（`/pricing` 为 Worker 动态渲染，不经构建后处理）在 390 / 1280 宽、浅色 / 深色下截图，「仅关键样式（阻止完整样式表）」与「完整样式」逐像素一致；证据写入私有证据库。
- [x] 4.2 Lighthouse：与基线相同方法（`lighthouse@13.5.0` 移动端 simulate，`/`、`/zh`、`/pricing` 各三次取中位数），对比 LCP、FCP、TBT、CLS、HTML 与首屏 JS 字节；LCP 中位数不升高、CLS 不增加。证据写入私有证据库。
- [x] 4.3 `pnpm check`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm check:deps`、`pnpm check:singletons` 通过；e2e `seo.spec.ts` 与 `marketing.spec.ts` 通过。

## 5. 文档与升级说明

- [x] 5.1 `docs/design-system.md` 字体一节说明 `fonts.project.ts`；`docs/02-project-structure.md` 配置一节说明 `marketing.performance`。验证：文档与代码中的名称一致。
- [x] 5.2 升级说明 `docs/upgrades/0.5.4.md` 与索引：两项如何启用、取舍、验证与回滚。验证：`node scripts/template-release.mjs check --version 0.5.4` 通过。
