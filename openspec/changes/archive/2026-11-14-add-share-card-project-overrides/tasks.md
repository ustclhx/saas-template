# Tasks

## 1. 项目回退字体

- [x] 1.1 新增项目自有文件 `share-cards.fonts.ts`（空列表与注释示例）与 `ProjectShareCardFont` 类型；`fonts.ts` 校验登记、生成文字匹配与指纹
- [x] 1.2 `text.ts`：`fallbackFontPlan` 区分 Noto 与项目字体，项目字体覆盖的文字不降级；谚文按全角计宽
- [x] 1.3 渲染核心按需加载项目字体并实例内缓存；Workers 经 `ASSETS.fetch`、Node 与构建期读本地文件；默认版式 `fontFamily` 与标题字重随登记调整
- [x] 1.4 生成器、`template-sync`、`template-release check` 把 `share-cards.fonts.ts` 与 `share-cards.sites.ts` 登记为项目自有文件

## 2. 多站点

- [x] 2.1 新增项目自有文件 `share-cards.sites.ts`；`site.ts` 解析主题覆盖、品牌、规范域名、副标题与站点指纹（不导入主题基线）
- [x] 2.2 默认版式增加可选 `brand`、`host`；`render` 增加第三个参数 `site`；默认分享图副标题取站点 tagline 或首页 SEO 标题
- [x] 2.3 卡片路由、分享页、`shareCardMeta`、`/dev/ui` 预览按请求 host 解析站点；构建期默认分享图按页面 locale / pathname 解析

## 3. 地址与缓存

- [x] 3.1 `shareCardVariant`：字体或站点指纹非空时追加到 `v`，都为空时与之前相同

## 4. 测试

- [x] 4.1 登记校验（非法文件名、未知文字、重复）、指纹随登记变化、谚文降级与触发规则、渲染器按需加载与失败重试
- [x] 4.2 Node 渲染器用夹具字体（`__fixtures__/hangul-test.ttf`）端到端渲染谚文；字体文件缺失时渲染失败
- [x] 4.3 站点解析：无解析函数时与单站点相同；按 host 替换品牌、域名与主题；不同站点地址不同、绝对地址使用站点声明的规范域名（不用请求 Host）、不合法域名使覆盖无效

## 5. 文档与验收

- [x] 5.1 `docs/share-cards.md` 项目字体与多站点章节；SEO README 文字支持范围
- [x] 5.2 升级说明 `docs/upgrades/0.4.1.md`（草稿）与索引
- [x] 5.3 `pnpm check`、`pnpm typecheck`、`pnpm check:deps`、`pnpm test`、`pnpm build`（首页包检查）、`template-release check --version 0.4.1`、`pnpm test:create-project` 通过
- [x] 5.4 衍生项目 xuanxue 放入 Noto Sans KR 后线上验收韩文分享卡片与双站点品牌（由接入项目验收）

## 6. 韩文与运行时语言（0.5.0，xuanxue 接入 0.4.1 后的反馈）

- [x] 6.1 底部元信息不再按测量宽度裁切：盒子占满域名左侧剩余宽度、上限随域名宽度收紧、satori 省略号兜底；回归单测
- [x] 6.2 韩文标题与摘要 `wordBreak: 'keep-all'`，`countLines` 按同一规则模拟；中日文与拉丁版式树不变；单测
- [x] 6.3 运行时语言：分享页与 `shareCardMeta` 传入页面语言，非默认语言且有站点覆盖时以 `l` 参数带到卡片地址并计入 `v`；卡片路由与预览校验 `l`；单测
- [x] 6.4 `docs/share-cards.md` 与升级说明 `docs/upgrades/0.5.0.md` 小节
