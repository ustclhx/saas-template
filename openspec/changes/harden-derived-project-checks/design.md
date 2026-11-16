# Design

## Context

模板的 e2e 与 Nightly 只在模板仓库内运行过；衍生项目沿用同一组文件，配置与模板默认不同。用例已有按配置跳过的先例（`app-shell` 按 `ui.appLayout`、`auth` 按 `auth.*`）。

## Decisions

### D1 用例读取项目配置，而不是在项目侧改写

用例直接导入 `template.config.ts`（已有做法）或检查页面上的声明（`body[data-floating-controls]`），在不适用时 `test.skip` 并写明原因。
Workers AI 是否可用同时看 `ai.mediaProviders` 与 `apps/web/wrangler.jsonc` 的 `ai` 绑定：前者是项目选择，后者是运行时能否调用。

### D2 价格目录在 globalSetup 写入

开发服务器把价格目录缓存 1 小时；第一个访问 `/pricing` 的用例若早于目录夹具，后续用例读到空目录。globalSetup 在 webServer 启动后、用例前写入目录夹具，
与用例顺序无关。夹具写入幂等（按固定 key upsert）。

### D3 中性填充 token

新增 `--neutral-fill`，取值与当前 `--accent` 相同，模板外观不变；Badge 灰色实心改用它。`--accent` 保留给悬停底等用途，品牌层可以自由改写。
不复用 `--muted`：它比 `--accent` 浅一级，作徽标底与卡片底区分不够。

### D4 Nightly 多空间任务

任务第一步判断：仓库有 `.template-base.json`（衍生项目）且 `template.config.ts` 中 `multiTenant` 不是 `true` 时输出 `skip=true`，后续步骤据此跳过，
任务结果为成功并在摘要中说明。模板仓库没有基准记录，照常把配置改为多空间后运行。

## Risks

- 跳过条件写错会让用例静默不跑：每个跳过都带原因字符串，出现在报告中。
