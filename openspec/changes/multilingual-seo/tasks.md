## 1. 设计关卡（协调者 + 使用者）

- [ ] 1.1 按 `ui-design` 产出语言提示条设计稿：手机底部、桌面右下 × 浅色 / 深色，含关闭按钮、进入动画与 `prefers-reduced-motion`；同一画布给出语言切换器在「本页无该语言版本」时的两种处理，供使用者选择
- [ ] 1.2 使用者在会话中确认设计稿与切换器处理方式；保存副本到 `docs/design-system/prototypes/multilingual-seo/` 并在原型索引登记

## 2. 配置与路由（可与第 1 组并行）

- [ ] 2.1 `packages/config`：`i18n.untranslated`（`'hide'` 默认 | `'fallback'`）与 `i18n.rememberHomeLocale`（默认 `false`），补类型、默认值与校验测试
- [x] 2.2 Paraglide URL 规则输出小写前缀；请求中间件对大小写不同的前缀与默认语言前缀做 301（只看路径）；单测与 e2e 覆盖 `/en/pricing`、`/zh-Hant/…` 形态
- [x] 2.3 根路由按语言输出 `lang` 与 `dir`（`Intl.Locale` 文本方向，加内置 RTL 表兜底），补单测
- [x] 2.4 确认公开页在任意 Accept-Language、Cookie 下不跳转、不渲染不同语言；补请求级测试

## 3. 未翻译页与 hreflang

- [ ] 3.1 `localizedEntries()` 按 `i18n.untranslated` 返回真实条目或补齐；博客、文档、答案页、法律页详情在 `'hide'` 下找不到条目时返回 404，列表与区块只列真实条目
- [ ] 3.2 `SeoPage.alternates`：hreflang 与语言切换器使用声明的地址；静态校验检查语言合法与双向声明；单测覆盖本地化 slug 场景
- [ ] 3.3 canonical 一律指向自身（`'fallback'` 下的回退页除外）；站点地图与可索引集合一致；更新 `seo.spec.ts` e2e（未翻译 404、回退开启时的原有场景）

## 4. 语言提示条与 ML-09（依赖 1.2）

- [ ] 4.1 删除首帧脚本、`data-locale-suggestion*`、SSR 隐藏横幅与建议偏好 Cookie；保留并迁移语言匹配函数及其测试
- [ ] 4.2 按设计稿实现 `LanguagePrompt`：水合后挂载，候选取本页 hreflang，`<a href>` 跳转，关闭状态存 localStorage（try/catch）；组件测试与 e2e 覆盖「SSR HTML 中没有提示」「中文浏览器出现提示」「对应语言未发布不提示」，CLS 断言为 0 增量
- [ ] 4.3 语言切换器按设计稿只链接真实存在的版本，使用普通 `<a>`
- [ ] 4.4 ML-09：手动选择语言时写 localStorage 标记，退出登录清除；首页在配置开启、已登录、标记有效且本页 hreflang 含该语言时 `location.replace`；单测覆盖开关、匿名、标记无效与内页不跳

## 5. 多语言检查

- [ ] 5.1 `check-links-graph.mjs`：每页规则（canonical 自身、`html lang`、语言查询参数、提示条标记）与 hreflang 图规则（双向、同域、x-default 恰一条、目标可索引），使用固定 HTML 夹具测试
- [ ] 5.2 `check-links.mjs`：Accept-Language 对比（首页、各语言首页、抽样页）、语言 `Set-Cookie`、默认语言前缀 301；多站点按站点执行；补 HTTP 夹具测试
- [ ] 5.3 模板自身以 `enforce` 通过；记录报告摘要与耗时

## 6. 文档、升级说明与发布

- [ ] 6.1 新增 `docs/multilingual-seo.md`（ML-01～ML-10、模板与项目职责、验收与检查规则对照）；在 `docs/seo-internal-linking.md`、`features/seo/README.md`、`new-static-page` 技能加入口
- [ ] 6.2 `docs/upgrades/0.8.0.md`：必须执行的动作（未翻译页处理方式、移除旧建议组件引用、大写前缀、先跑 report）与回滚；`template-release.mjs check --version 0.8.0` 通过
- [ ] 6.3 合并后确认 main 流水线与 staging 部署成功，再打 `template-v0.8.0`；通知 xuanxue 与 product-res
