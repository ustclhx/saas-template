## Why

模板的公开页面已经有统一的元数据、站点地图与 hreflang，但页面之间怎么互相链接没有任何约束：没有层级（parent）概念、没有面包屑、没有「同级 / 相关」区块，也没有检查孤岛页、死链和点击深度。衍生项目会批量生成程序化页面（xuanxue 的牌义、数字等），这些页面最容易成为没有入链的孤岛，而问题只能靠人工巡查发现。

另外，缺少译文的页面目前以默认语言内容发布在其他语言路径下，canonical 指向自身，形成跨语言重复内容。

现在把内链规范做成模板机制：页面声明层级，模板生成固定区块，构建后检查实际渲染出的链接图，衍生项目同步即得。

## What Changes

- 扩展公开页面清单 `SeoPage`：新增 `parent`、`titleMain`、`anchorShort`、`group`、`related`、`indexable`、`priority` 字段；页面清单之外的元数据规则不另建表。
- 新增模板区块：面包屑（含 BreadcrumbList JSON-LD）、同级列表、相关链接、系列上一篇／下一篇。锚文本只取 `titleMain` 或 `anchorShort`，不接受自由文本。
- 新增构建后链接图检查：从实际产出的 HTML 读取 `<a href>`，检查孤岛页、站内死链、点击深度、指向不可索引页的链接、禁用锚文本、姊妹站链接约束、钱页入链等；规则分「失败 / 警告」两级，阈值由项目配置。
- 新增项目配置：页面层级、阈值、钱页（`priority: 'money'`）、sister 域名列表（姊妹站之间可在正文中互链，但必须 `rel="nofollow"`，不放导航层、不做镜像互指）。
- **BREAKING（行为）**：缺少译文的回退页 canonical 改为指向原语言页，hreflang 只列出真实存在的译文，站点地图不再收录回退页。
- 新增规范文档 `docs/seo-internal-linking.md`，与 `docs/ci.md` 同级，作为项目新增页面时的依据。

不在本次范围：GSC 数据接入（钱页由项目声明）、锚文本占比统计（已取消）、跨站点链接图（只检查本站指向姊妹站的链接）、运营后台的内链编辑。

## Capabilities

### New Capabilities

- `seo-internal-linking`: 公开页面的层级声明、模板内链区块、锚文本规则与构建期链接图检查。

### Modified Capabilities

- `seo`: 「多语言关联」改为只关联真实译文，回退页 canonical 指向原语言页且不进入站点地图。

## Impact

- `apps/web/src/features/seo/`（`metadata.ts`、`pages.ts`、`structured-data.ts`）：字段扩展、canonical 与 hreflang 规则、站点地图过滤。
- `apps/web/src/features/marketing/`：新增区块组件，接入博客、文档、答案页、法律页布局；页脚链接数受检查约束。
- `apps/web/scripts/`：新增链接图检查脚本，接入 `pnpm build` 之后（或 CI 的现有构建产物步骤）。
- `template.config.ts` 类型：新增 `seo.linking` 配置段。
- 衍生项目：同步后需要为自有公开页面补 `parent` 等字段，否则检查失败；升级说明给出迁移步骤与报告模式开关。
- 不影响数据库、计费、应用区与后台。
