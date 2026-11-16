# Design

## Context

- 根布局 `root-document.tsx` 对 `@saas/ui/fonts` 的 `fontPreloads` 逐个调用 React `preload()`，每页 head 都有 Inter 拉丁子集的 preload。
- `apps/web` 构建：`vite build`（含 TanStack Start 预渲染）→ `scripts/inline-critical-css.mjs`（把整份 app.css 内联进每个预渲染 HTML）→ `scripts/check-home-bundle.mjs`（首页客户端静态闭包不得含阅读器等代码）。
- `vite.config.ts` 已关闭 Vite 的 modulePreload，但 TanStack Start 的路由清单仍在预渲染 HTML 中输出 modulepreload（模板首页 13 个）。
- 预渲染页的 CSP 按响应时内联脚本的 SHA-256 生成（`withStaticSecurityHeaders`），`script-src` 含 `'self'`，因此构建期新增的内联脚本与其动态插入的同源脚本都被允许。
- 基线（本 worktree，`lighthouse@13.5.0` 移动端 simulate，三次中位数）：`/` LCP 6.64s，`/zh` 7.52s，`/pricing` 6.51s；首页 HTML 185KB（内联 CSS 124KB），首页客户端闭包 39 个脚本、gzip 242KB，其中 `template-config` 分包 127KB（zod 与配置校验）。

## Goals / Non-Goals

**Goals:** 首帧前只传输渲染首屏必需的字节；视觉、CLS、SEO head 与数据库不可达时的可用性不变；已有衍生项目不显式启用时行为不变。

**Non-Goals:** 项目字体子集与品牌字体、页头布局；Worker 动态渲染页（登录后页面）的优化；改变路由文件的拆分方式（模板首页闭包已只含首页模块，项目路由的非拆分导出由项目调整，首页包预算帮助发现）。

## Decisions

### D1 字体预加载：项目自有文件

`apps/web/src/features/theme/fonts.project.ts`（模板只创建，加入 `template-release` 的项目自有文件清单）：

```ts
export function projectFontPreloads(defaults: readonly FontPreload[]): readonly FontPreload[] {
  return defaults
}
```

根布局改为对 `projectFontPreloads(fontPreloads)` 逐个 preload。项目返回 `[]` 关闭、返回新数组替换（可在该文件用 `?url` 导入自己的字体）、`[...defaults, x]` 追加。选择项目自有文件而不是 `template.config.ts`：字体地址需要 Vite 资源导入，配置文件只放数据。

`brand.css` 去掉注释后声明了 `--font-sans`、而首页 HTML 仍含 Inter preload 时，构建后处理打印警告（不失败：项目可能仍在部分页面使用 Inter）。

### D2 客户端模板配置用构建期 JSON

Vite 插件 `clientTemplateConfig` 只在 `client` 环境拦截 `template.config.ts` 的加载，返回 `export default <已解析配置的 JSON>`。解析结果来自 `vite-shared.ts` 已在 Node 中导入的同一文件；JSON 往返与原值不完全相等（含函数、Date 等）时构建失败。服务端与测试仍执行原文件，校验错误照常在构建期抛出。`security-client.ts` 改为 `import { config } from 'zod'`，只保留设置 jitless 的极小部分。

备选：给 `@saas/config` 拆出无 zod 的客户端入口——会让配置的默认值合并逻辑出现两份，被否决。

首页包检查新增标记：客户端首页闭包含 zod 的 schema 实现（以 `invalid_type` 等 issue 码与 `ZodError` 为标记）时，
设置了 `homeScriptGzipBudget` 判失败，未设置只警告——衍生项目首页可能在浏览器端用 zod 校验表单，升级模板不应因此构建失败。`marketing.performance.homeScriptGzipBudget` 为数字时，闭包 gzip 合计超出即失败。

### D3 构建后处理：按配置改写预渲染 HTML

`inline-critical-css.mjs` 扩展为按配置处理每个预渲染 HTML。配置由 `vite-shared` 的插件在构建开始时写入 `dist/.build/marketing-performance.json`（不在 `dist/client`，不会被公开）；文件缺失时按默认值（`eager` / `full`）处理，保证旧调用方式仍可用。

- `criticalCss: 'full'`：与现状相同，整份内联。
- `criticalCss: 'used'`：先整份内联，再用 beasties（`reduceInlineStyles`，不生成 preload，不内联字体文件）按该页 DOM 裁剪；之后把完整样式表中**全部** `@font-face` 规则补回（beasties 无法解析 `var(--font-sans)` 引用的字体族，会误删），`allowRules` 保留 `.dark` 等运行时才出现的选择器。完整样式表由首帧后加载器以 `<link rel="stylesheet">` 追加，并在 head 中以 `<noscript>` 引入供关闭 JS 的访客使用；其中的规则对首屏元素与内联规则相同，不引起重排。
- `hydration: 'after-paint'`：删除 `<link rel="modulepreload">`；把 `<script type="module" async src="/assets/…">` 替换为同一个内联加载器在首帧后插入。
- 加载器：`PerformanceObserver({ type: 'paint', buffered: true })` 见到 `first-contentful-paint` 后在下一个任务中执行；不支持时在 `load` 事件执行；最晚 3 秒兜底。先追加样式表，再插入入口脚本。内联脚本由响应时的 CSP 哈希授权。
- **head 不变**：处理前后分别抽取 head 中的 title、`meta[name|property]`、`link[rel=canonical|alternate|icon|manifest]` 与 `application/ld+json`，序列化比较，不一致即构建失败。

### D4 默认值与模板示例

`@saas/config` 的 `marketing.performance` 默认 `{ hydration: 'eager', criticalCss: 'full', homeScriptGzipBudget: null }`；模板自身的 `template.config.ts` 启用 `after-paint`、`used` 与预算（当前首页闭包 gzip 加约 5% 余量）。新生成的项目随之启用；已有项目在升级说明中按步骤显式启用并复测。

## Risks / Trade-offs

- [裁剪漏掉首屏规则导致闪烁或位移] → 验收用 Playwright 对每个预渲染页在 390 与 1280 宽、浅色与深色下截图：「只有关键样式」与「完整样式」两种渲染逐像素一致；Lighthouse CLS 不增加。
- [首帧前点击按钮无响应的时间变长] → 只用于预渲染营销页；链接是普通 `<a>`，导航不受影响；模板默认值不变，项目显式启用。
- [真实网络下水合开始更晚] → 文档说明取舍：首帧更早、可交互稍晚；TBT 纳入前后对比。
- [beasties 处理耗时] → 每页约 30ms，构建可接受。

## Migration Plan

纯增量，无数据库与部署变化。回滚：项目把 `marketing.performance` 改回默认或回退代码。
