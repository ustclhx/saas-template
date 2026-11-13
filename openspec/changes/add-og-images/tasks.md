# Tasks

## 1. 可行性验证（先做，决定后续路线）

- [ ] 1.1 在 worktree 中实现最小渲染路由，配合示例版式和 CJK 字体懒加载，用 `wrangler versions upload` 上传到 staging，不切换流量。测量 design 第 7 条的五项指标：压缩体积增量、冷实例 CPU（含 CJK）、热实例 CPU、峰值内存、首页冷启动。数据与结论写入证据库。验证：证据 README 中有五项数值，以及「达标 / 改用常用字子集 / 移到 jobs Worker」三选一的结论。
- [x] 1.2 协调者把 1.1 的结论写回 design.md 第 5、7 条。如果路线有变，同步更新本 tasks。验证：design.md 中写明最终选定的路线。

## 2. 设计稿（协调者）

- [x] 2.1 用 `ui-design` 技能出 Design 画布：示例卡片的版式（中文和英文标题、长标题截断、浅色和深色各一张）、构建期默认分享图沿用的版式，以及通用分享页 `/s/<类型>/<令牌>`（桌面与 390px × 浅色与深色，加 404 / 到期态）。画布经使用者确认后，保存副本并登记原型索引。验证：原型索引中有对应行，附使用者原话。

## 3. 注册、到期与失效

- [x] 3.1 新增 `apps/web/src/features/share-cards/` 的注册表与类型定义（design 第 1、2 条）：`registerShareCard`、`ShareResolution`、`tokenPattern` 默认值、`ttlDays`（默认取 `template.config.ts` 的 `shareCards.defaultTtlDays = 90`）、`sharePage` 开关；`createShareToken()`；到期计算函数。项目自有的 `share-cards.project.ts` 与 `share-cards.theme.ts` 占位文件在生成器与 template-sync 中登记为项目拥有；示例类型 `sample` 用内存数据。验证：单测覆盖重名报错、未注册类型、令牌长度与字符集、`expiresAt` 优先、默认 90 天、按类型改为 30 天、`null` 永不过期。
- [x] 3.2 实现失效函数 `invalidateShareCard`：删除 R2 图片前缀与空间索引，写 KV 撤销标记。验证：集成测试（本地 R2 / KV 模拟）覆盖失效后图片与索引不存在、标记存在。
- [x] 3.3 删空间清理流程（含删号时的个人空间）按空间索引对每个令牌执行失效函数。验证：在现有清理测试中扩展用例，覆盖 account-deletion 增量规范里的两个场景。

## 4. 渲染与主题

- [x] 4.1 `packages/ui` 新增分享卡片主题的 token 值导出。验证：单测确认它与 `tokens.css` 的基线值一致，`pnpm ui:lock` 已更新。
- [ ] 4.2 在 `apps/web/src/features/share-cards/` 新增版式：
  - 默认版式 `layout.tsx`；
  - 示例类型 `sample` 的版式。

  验证：单测用固定数据得到版式树，主题值来自 4.1。
- [ ] 4.3 实现渲染器：经 WebRuntime 注入，Workers 实现在 `src/server/cloudflare/`、Node 实现在 Node 运行时，西文字体随包打包，CJK 字体按需加载并在实例内缓存，文本按字宽加权截断（design 第 5 条），并发上限为 2。验证：Node 单测渲染中文、英文和超长标题，输出 1200×630 PNG；并发超限时返回 503。
- [ ] 4.4 构建期 `apps/web/scripts/og-images.ts` 改为复用默认版式。验证：静态图测试与 e2e `seo.spec.ts` 通过，图片与 `share-cards/Card.dc.html` 的 `default` 变体一致（附前后截图；颜色从深蓝渐变改为主题 token 是已确认的变更）。

## 5. 路由、缓存与元数据

- [ ] 5.1 实现 `/share-card/<type>/<token>.png` 路由，按 design 第 3 条的顺序处理：令牌格式校验 → KV 撤销标记 → Cache API → R2（检查元数据中的到期时间）→ 调用 `resolve`、校验到期、比对摘要（不一致时 302）→ 渲染 → 写入 R2 图片、空间索引与 Cache API。缓存头受剩余有效期约束。自托管跳过 Cache API。验证：web 集成测试覆盖命中不调用 `resolve`、格式不符 404 且不调用 `resolve`、解析为空 404、失效后 404、R2 命中但已到期 404、摘要变化后 302、剩余 2 小时时 `s-maxage` ≤ 7200。写入 R2 图片与空间索引前再次检查 KV 撤销标记；补充测试覆盖渲染期间并发失效时不写入图片与索引，避免留下孤儿卡片。
- [ ] 5.2 新增 `RL_SHARE_CARD` 限流绑定，在各环境的 wrangler 配置和 `check-wrangler-envs` 中声明，卡片缓存未命中与分享页请求时消耗配额。验证：本地 `wrangler dev` 下超过限额返回 429，单测覆盖。
- [ ] 5.3 实现元数据工具 `shareCardMeta(type, token)`，输出 `og:image`（APP_URL 下的绝对地址加 `v` 参数）、宽高、alt、`twitter:card` 与 `noindex`；robots 放行 `/share-card/` 与 `/s/`，站点地图与 `llms.txt` 不收录。验证：seo 单测与 robots、sitemap 测试。
- [ ] 5.4 按 2.1 副本实现通用分享页 `/s/$type/$token`（design 第 8 条）：有效时显示卡片、标题、描述与站点入口；无效、到期、失效或 `sharePage: false` 时 404 页；先查 KV 撤销标记；缓存头与 `noindex`；文案进 `messages/{en,zh}`。验证：web 集成测试覆盖四种 404 情况；`ui-design` 第 6 步的四张截图与副本对照。
- [ ] 5.5 扩展首页包检查：服务端与客户端的首页闭包中不能出现渲染器、satori、resvg 和字体。验证：`pnpm --filter @saas/web build` 通过；故意把渲染器加进首页导入时检查失败（测试中模拟）。

## 6. 预览与示例

- [ ] 6.1 在 `/dev/ui` 加分享卡片预览：示例类型用固定数据，展示中文、英文和长标题，浅色和深色各一张，与 2.1 的副本对照。验证：截图与副本一致，`ui-preview.spec.ts` 通过。
- [ ] 6.2 e2e 用例：用示例类型（测试中注册，内存解析）打开分享页，元数据中的 `og:image` 指向卡片地址，抓取得到 1200×630 PNG；调用失效函数后卡片与分享页返回 404。选择器与断言不依赖语言。验证：e2e 通过，并加入夜间全量测试。

## 7. 文档与升级说明

- [ ] 7.1 更新 `apps/web/src/features/seo/README.md`（或新建 `docs/share-cards.md`），写明：注册步骤、项目自建分享表的建议结构（令牌不含资源 ID、部分唯一索引）、撤销与删资源时必须调用失效函数、删空间时清理自己的分享表、到期规则（默认 90 天与修改方式）、通用分享页与自建页面二选一、版式约束、主题覆盖、缓存语义、限流、自托管差异，以及「撤销对已被平台抓取的卡片无效」。验证：文档中的命令可以照着执行。
- [ ] 7.2 在 `new-module` 技能（或 `new-page`）中加入分享卡片接入步骤；在 `ui-design` 技能中说明卡片版式需要设计稿。验证：`.agents` 与 `.claude` 两份技能文件用 `cmp` 比对一致。
- [ ] 7.3 起草 `docs/upgrades/0.4.0.md`（或下一个版本），写明：无迁移、新绑定 `RL_SHARE_CARD`、新路由 `/share-card/*` 与 `/s/*`、R2 前缀、`template.config.ts` 新字段、项目自有文件、check-ui 例外、首页包检查变化。验证：`template-release.mjs check` 通过。

## 8. 验收

- [ ] 8.1 `pnpm check`、`pnpm typecheck`、`pnpm check:deps`、`pnpm check:singletons`、`pnpm test`与 `pnpm build` 全部通过，`pnpm test:create-project:verify` 通过。
- [ ] 8.2 staging 验收：
  - 示例卡片的冷、热渲染耗时与 1.1 一致；
  - 第二次请求命中缓存；
  - 失效后卡片与分享页返回 404；
  - 分享页在 390px 与桌面下与副本一致；
  - 首页 Lighthouse 性能分不低于验收基线；
  - 用社交平台的卡片调试工具抓取一次分享页，如果有限制只能人工查看，记录结果。

  证据写入私有证据库。
