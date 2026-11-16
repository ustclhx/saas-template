# Proposal

## Why

xuanxue-saas 复测首页改版（Lighthouse 移动端 simulate，三次取中位数）时发现，营销页 LCP 的剩余瓶颈在模板文件中：simulate 的 LCP 估算约与首帧前下载的字节数成正比（约 7ms/KB）。模板对每页预加载 71KB 的 Inter（品牌换字体后仍预加载）；客户端首页闭包带入 zod 与模板配置校验（约 127KB）；HTML 头部列出十余个 modulepreload，水合入口与首帧争抢带宽，首帧早晚不同使三次测量相差 1.5–2.5s；整份 app.css（模板约 124KB、xuanxue 约 151KB）内联进每个 HTML。

## What Changes

- **字体预加载扩展点**：新增项目自有文件 `apps/web/src/features/theme/fonts.project.ts`，导出 `projectFontPreloads(defaults)`，项目可替换、追加或返回空数组；默认原样返回，行为不变。`brand.css` 覆盖了 `--font-sans` 而首页仍预加载 Inter 时，构建输出警告。
- **客户端不再解析模板配置**：客户端环境加载 `template.config.ts` 时替换为构建期已解析的 JSON（服务端照常执行原文件）；`security-client` 只导入 zod 的 `config`。首页包检查新增「客户端首页闭包不得含 zod schema 代码」，并支持可选的 gzip 预算。
- **营销页关键路径**（模板配置 `marketing.performance`，`@saas/config` 默认值保持现状）：
  - `hydration: 'eager' | 'after-paint'`：`after-paint` 时预渲染页面去掉 modulepreload，水合入口在首次内容绘制之后再加载。
  - `criticalCss: 'full' | 'used'`：`used` 时每页只内联该页 DOM 用到的规则（另保留全部 `@font-face`、深色模式规则与 `@layer` / `@property` 声明），完整样式表在首帧后加载。
  - `homeScriptGzipBudget`：首页客户端闭包 gzip 预算（字节），超出时构建失败。
  - 构建后处理逐页比对处理前后的 head 中的 SEO 标签（title、meta、canonical、alternate、JSON-LD），不一致即构建失败。
- 模板自身的 `template.config.ts` 启用 `after-paint`、`used` 与预算；已有衍生项目在自己的 `template.config.ts` 中显式启用。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `marketing-site`：新增营销页首屏关键路径要求（字体预加载可由项目配置、可选延后水合与按页关键样式、SEO head 不变、首页客户端包不含配置校验并受预算约束）。

## Impact

- 代码：`apps/web/scripts/{vite-shared.ts,client-template-config.ts,inline-critical-css.mjs,check-home-bundle.mjs}`、`apps/web/src/{security-client.ts,features/theme/root-document.tsx,features/theme/fonts.project.ts}`、`packages/config/src/template.ts`、`template.config.ts`、`scripts/template-release.mjs`（项目自有文件清单）。
- 依赖：`apps/web` 开发依赖 `beasties`（构建期按 DOM 裁剪 CSS）。
- 文档：`docs/design-system.md`（字体）、`docs/02-project-structure.md`（配置项）、升级说明 0.5.4。
- 不涉及数据库、密钥与部署绑定；只改变预渲染 HTML，Worker 动态渲染的页面不变。
