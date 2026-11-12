# 模板设计稿索引

模板自身经使用者确认的设计稿副本与索引（流程见 `ui-design` 技能，规则见 [设计规范 §8.2](../../design-system.md#82-设计稿确认与原型索引)）。
本目录属于模板维护资料，生成器不复制到衍生项目；衍生项目的索引在 `docs/design/prototypes/README.md`。

关卡检查：本页面在下表中有一行，且「副本文件」（相对本目录）存在。确认只接受使用者本人在会话中的明确确认，附原话；
确认后画布再改动须重新确认并更新本行与副本。OpenSpec `design.md` 只引用本表的行。

| 页面 / 路由 | 画布链接 | 确认日期 | 使用者确认原话 | 副本文件 | 所属 change |
|---|---|---|---|---|---|
| 基线风格与预设（第一批） | https://claude.ai/artifact/JL1raENWEr8nomz7sqvHce | 2026-11-11 | 「画布审批确认，继续8.3-8.7」 | ui-review/Main.dc.html | add-ui-design-system |
| `/dev/ui` 组件（第一批） | https://claude.ai/artifact/JL1raENWEr8nomz7sqvHce | 2026-11-11 | 「画布审批确认，继续8.3-8.7」 | ui-review/Components.dc.html | add-ui-design-system |
| 工作台布局 `/app/$slug/*`（8.3） | https://claude.ai/artifact/JL1raENWEr8nomz7sqvHce | 2026-11-11 | 「画布审批确认，继续8.3-8.7」 | ui-review/Workbench.dc.html、ui-review/WorkbenchMobile.dc.html | add-ui-design-system |
| 长文阅读器（8.4） | https://claude.ai/artifact/JL1raENWEr8nomz7sqvHce | 2026-11-11 | 「画布审批确认，继续8.3-8.7」 | ui-review/Reader.dc.html、ui-review/ReaderMobile.dc.html | add-ui-design-system |
| 营销新区块 `/`（8.5） | https://claude.ai/artifact/JL1raENWEr8nomz7sqvHce | 2026-11-11 | 「画布审批确认，继续8.3-8.7」 | ui-review/Marketing.dc.html | add-ui-design-system |
| 嵌入式对话与评分（8.6） | https://claude.ai/artifact/JL1raENWEr8nomz7sqvHce | 2026-11-11 | 「画布审批确认，继续8.3-8.7」 | ui-review/Chat.dc.html | add-ui-design-system |
| 定价页 `/pricing`（8.7） | https://claude.ai/artifact/JL1raENWEr8nomz7sqvHce | 2026-11-11 | 「画布审批确认，继续8.3-8.7」 | ui-review/Pricing.dc.html | add-ui-design-system |
| 账单页 `/app/$slug/billing`（8.6、8.7） | https://claude.ai/artifact/JL1raENWEr8nomz7sqvHce | 2026-11-11 | 「画布审批确认，继续8.3-8.7」 | ui-review/Billing.dc.html | add-ui-design-system |
| 通知铃铛弹层（工作台顶部条，#90） | https://claude.ai/artifact/JL1raENWEr8nomz7sqvHce | 2026-11-12 | 「画布确认，124同意，3选A」 | ui-review/Notifications.dc.html、ui-review/NotificationsMobile.dc.html | —（0.3.1 小任务；变更提议 ①Popover ②底部 Sheet ④通知文案多语言 已同意，③「查看全部」跳工作台首页通知区） |

副本格式：`ui-review/` 保存画布确认版本的画板源码（`*.dc.html`）与画布索引 `canvas.json`。源码依赖画布运行时，
不能脱离 claude.ai 直接渲染，但完整包含布局、token 取值、文案与各状态分支（`state` / `dark` tweak），
实现与验收按源码逐项对照；需要图片时由使用者从画布导出 PNG 放到同目录。
