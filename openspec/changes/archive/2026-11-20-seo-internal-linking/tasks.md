## 1. 页面元数据与配置

- [x] 1.1 `packages/config` 增加 `seo.linking` 类型与默认值（`mode` 默认 `report`、阈值、禁用词、`moneyPages`、`sisterDomains`、`series`、hub 分页上限），模板 `template.config.ts` 设为 `enforce`；补类型与默认值测试
- [x] 1.2 `SeoPage` 增加 `parent`、`titleMain`、`anchorShort`、`group`、`related`、`indexable`、`priority`、`sourceLocale`；`staticPage()` 声明模板静态页的上级与主词
- [x] 1.3 内容集合 frontmatter 增加可选 `parent`、`anchor_short`、`related`，按集合推导默认 `parent` 与 `titleMain`
- [x] 1.4 新增项目所有的 `pages.project.ts` 注册入口，与模板清单合并；登记到生成器的项目自有文件，并补生成器测试
- [x] 1.5 元数据静态校验：`url` 唯一、`parent`／`related`／`group` 目标存在且可索引、主词重复警告；单元测试覆盖各失败与警告分支

## 2. 多语言回退

- [x] 2.1 `publicPages()` 为回退页写入 `sourceLocale`，站点地图跳过回退页
- [x] 2.2 `pageHead()` 回退页 canonical 指向原语言地址，`alternateLinks()` 只列出真实译文
- [x] 2.3 单元测试与 `seo.spec.ts` e2e 覆盖「只有英文的文章」场景

## 3. 内链区块

- [x] 3.1 面包屑组件与 BreadcrumbList JSON-LD，接入博客、文档、答案页、法律页、定价等公开页面布局（新组件经 `ui-design` 设计确认）
- [x] 3.2 hub 列表：下级全列与超上限分页，接入博客列表与标签页
- [x] 3.3 同级区块、相关区块、系列上一篇／下一篇组件，锚文本只取 `titleMain`／`anchorShort`
- [x] 3.4 页头、页脚、面包屑、语言切换器与各区块加 `data-link-zone` 标记
- [x] 3.5 组件单元测试：真实 `<a href>`、锚文本来源、未声明时不渲染

## 4. 链接图检查

- [x] 4.1 `apps/web/scripts/check-links.mjs`：启动 preview，以站点地图地址与各语言首页为种子抓取，解析 `<a href>` 与区域标记，构建链接图
- [x] 4.2 实现失败级规则（孤岛、死链、正文指向不可索引页、禁用锚文本、图片链接缺 alt、姊妹站链接缺 nofollow／在导航层／镜像互指、H1 不是恰好一个）与警告级规则（H1 重复、页头频道数、正文链接数、深度、钱页入链、页脚数量、主词重复），`report`／`enforce` 两种模式
- [x] 4.3 规则单元测试使用固定的 HTML 夹具，不依赖真实构建
- [x] 4.4 对模板当前站点以 `report` 运行，修正模板自身的问题后切到 `enforce`；在 PR 中贴出报告摘要与耗时
- [x] 4.5 接入 CI（实际放在 build job 的 `pnpm build` 之后，见 design 决策 6），更新 `docs/ci.md` 的 job 说明

## 5. 文档与验收

- [x] 5.1 新增 `docs/seo-internal-linking.md`：字段、区块、规则分级、配置、项目自有页面注册方法；`apps/web/src/features/seo/README.md` 与 `new-static-page` 技能加入口
- [x] 5.2 用 xuanxue 的只读副本以 `report` 模式运行一次，记录孤岛与死链数量，作为升级说明的参考（不修改 xuanxue）
- [x] 5.3 升级说明草稿要点（发版时写入 `docs/upgrades/`）：默认 `report`、迁移步骤、回退页 canonical 变化
