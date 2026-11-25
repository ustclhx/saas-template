# 模板设计稿索引

模板自身经使用者确认的设计稿副本与索引（流程见 `ui-design` 技能，规则见 [设计规范 §8.2](../../design-system.md#82-设计稿确认与原型索引)）。
本目录属于模板维护资料，生成器不复制到衍生项目；衍生项目的索引在 `docs/design/prototypes/README.md`。

关卡检查：本页面在下表中有一行，且「副本文件」（相对本目录）存在。确认只接受使用者本人在会话中的明确确认，附原话；
确认后画布再改动须重新确认并更新本行与副本。OpenSpec `design.md` 只引用本表的行。
「画布链接」只是确认时的记录，Artifact 按账号私有，其他账号或开发者通常打不开；实现与验收一律以「副本文件」为准。

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
| 分享卡片版式（示例类型与构建期默认分享图，1200×630） | https://claude.ai/artifact/Cmugzpfw8WYipVdvUZerwZ | 2026-11-13 | 「cancas 审批通过，开水执行吧」 | share-cards/Main.dc.html、share-cards/Card.dc.html | add-og-images |
| 通用分享页 /s/$type/$token | https://claude.ai/artifact/Cmugzpfw8WYipVdvUZerwZ | 2026-11-13 | 「cancas 审批通过，开水执行吧」 | share-cards/SharePage.dc.html、share-cards/SharePageMobile.dc.html | add-og-images |
| 对话页 /app/$slug/chat/$conversationId（含消息各状态、Markdown、输入区） | https://claude.ai/artifact/5VgoViLrF6DXiagXomEMoj | 2026-11-14 | 「approve the design canvas for the chat components」 | chat-components/Main.dc.html、chat-components/Mobile.dc.html、chat-components/States.dc.html | add-ai-chat-components |
| 嵌入式 SubjectChat（inline / panel / 手机底部抽屉） | https://claude.ai/artifact/5VgoViLrF6DXiagXomEMoj | 2026-11-14 | 「approve the design canvas for the chat components」 | chat-components/Embedded.dc.html、chat-components/EmbeddedMobile.dc.html | add-ai-chat-components |
| 手机端页脚设置行（< 768px 公开页：语言与主题移入页脚，只留 Ask AI 悬浮） | https://claude.ai/artifact/9WTKL7Waxb7HMp3VdAC4ot | 2026-11-15 | 「确认」 | mobile-footer-controls/Main.dc.html、mobile-footer-controls/Mid.dc.html、mobile-footer-controls/Dark.dc.html | add-ui-design-system（9.3 验收缺陷 UI-01，0.5.1） |
| 公开页内链区块：面包屑、系列上一篇／下一篇、相关文章、同组列表、hub 分页（博客 / 文档 / 答案页 / 法律页） | https://claude.ai/artifact/NSHAVaDkrvs6og9n4Q6zVp | 2026-11-19 | 「canvas确认没问题，开发吧」 | seo-internal-linking/Main.dc.html、seo-internal-linking/Mobile.dc.html、seo-internal-linking/Hub.dc.html、seo-internal-linking/States.dc.html | seo-internal-linking（新组件 Breadcrumb、Pagination、LinkCard、LinkList 已同意）；已接受偏离：分页隔一页不省略、分页悬停底色、卡片悬停下划线、手机系列卡片 chevron（使用者 2026-11-19 确认） |
| Agent 列表与新建 /app/$slug/agents（桌面表格 + 新建弹窗；手机列表 + 底部面板；空、加载、失败态） | https://claude.ai/artifact/BQ3ghnRCniapqrXTpcrfY2 | 2026-11-24 | 「agent page design 确认，开始开发吧」 | agents/List.dc.html、agents/ListMobile.dc.html | add-ai-agents（无新组件；只列支持工具调用且套餐可用的模型） |
| Agent 对话页 /app/$slug/agents/$conversationId（工具调用卡片四态、确认卡片、本轮步数与积分、积分不足提示、空 / 加载态、手机端） | https://claude.ai/artifact/BQ3ghnRCniapqrXTpcrfY2 | 2026-11-24 | 「agent page design 确认，开始开发吧」 | agents/Main.dc.html、agents/Mobile.dc.html | add-ai-agents（工具卡片与确认卡片为消息部件渲染器中的新渲染器，用现有 Card / Button / Badge 组合；状态色用 --success / --warning / --destructive） |
| 后台 API 令牌 /admin/api-tokens（端点卡片、令牌表格、创建弹窗含权限与有效期、一次性显示令牌与 Claude Code 命令、吊销确认、空 / 加载 / 失败态；手机卡片列表 + 底部面板） | https://claude.ai/artifact/Tbg7CRYsoy5Kj1gw7FxV7U | 2026-11-25 | 「确认canvas」 | admin-mcp/Main.dc.html、admin-mcp/TokensMobile.dc.html | add-admin-mcp（无新组件；已吊销与已过期令牌置灰保留 30 天后从列表移除，使用者随画布确认） |
| 后台运行时设置·功能模型分组 /admin/settings（功能、种类与沿用顺序、同种类模型下拉、实际使用模型与来源：显式 / 沿用 / 所选已停用 / 未配置；无登记时隐藏；手机卡片） | https://claude.ai/artifact/Tbg7CRYsoy5Kj1gw7FxV7U | 2026-11-25 | 「确认canvas」 | admin-mcp/Settings.dc.html、admin-mcp/SettingsMobile.dc.html | add-admin-mcp（无新组件；状态点色用 --success / --warning / --destructive） |

副本格式：`ui-review/` 保存画布确认版本的画板源码（`*.dc.html`）与画布索引 `canvas.json`。源码依赖画布运行时，
不能脱离 claude.ai 直接渲染，但完整包含布局、token 取值、文案与各状态分支（`state` / `dark` tweak），
实现与验收按源码逐项对照；需要图片时由使用者从画布导出 PNG 放到同目录。
| 语言提示条（水合后固定定位，桌面右下 / 手机底部，叠在 Ask AI 上方）与语言切换器（只列本页真实存在的语言版本） | https://claude.ai/artifact/BXaZ5WDiiv1cqBC11KumVY | 2026-11-20 | 使用者在会话中选择：切换器 A（隐藏）、桌面右下、手机叠在 Ask AI 上方、接受全部变更提议 | multilingual-seo/Main.dc.html、multilingual-seo/MainDark.dc.html、multilingual-seo/Mobile.dc.html、multilingual-seo/MobileDark.dc.html、multilingual-seo/Switcher.dc.html、multilingual-seo/Motion.dc.html、multilingual-seo/Spec.dc.html | multilingual-seo（新组件 LanguagePrompt、Languages 图标、float-enter/exit 动画 160/120ms 与减弱动画版本、切换器改为链接 Dropdown、浮动控件总高 CSS 变量，均已同意）；已接受偏离：菜单行按规范 36px 且非当前项弱化、只有一个语言版本时切换器仍显示、无 Ask AI 时提示条距底 72px、ML-09 用 7 天浏览器登录标记（使用者 2026-11-20 确认） |
| 后台敏感操作验证弹窗 StepUpDialog（按账号可用方式：验证器 / 备用码 / 邮箱验证码 / 密码；未发送、已发送与重发倒计时、错误与剩余次数、锁定、验证中、成功后自动继续、无可用方式、救援模式；顶部「已验证剩余时间」与救援警示条；手机底部面板） | https://claude.ai/artifact/34yAK9z9Fc5ZnCAVHRFYUx | 2026-11-25 | 「确认画布设计」 | admin-step-up/Main.dc.html、admin-step-up/DialogMobile.dc.html | add-admin-step-up（6 位验证码输入：@saas/ui 无 InputOTP 时按 UPSTREAM 接入，使用者随画布确认） |
| 后台确认 AI 发起的操作 /admin/confirm/$id（摘要、现值 → 执行后表格、发起令牌与时间、剩余有效期；待确认、执行中、已完成、未执行：令牌已吊销 / 目标已变化、失败、已拒绝、已过期、非发起人只读可拒绝、不存在；手机底部操作栏） | https://claude.ai/artifact/34yAK9z9Fc5ZnCAVHRFYUx | 2026-11-25 | 「确认画布设计」 | admin-step-up/Confirm.dc.html、admin-step-up/ConfirmMobile.dc.html | add-admin-step-up（无新组件） |
| 后台待确认列表 /admin/confirmations（待确认 / 历史两栏、空 / 加载 / 失败态，导航项待确认数量；手机卡片列表） | https://claude.ai/artifact/34yAK9z9Fc5ZnCAVHRFYUx | 2026-11-25 | 「确认画布设计」 | admin-step-up/Confirmations.dc.html、admin-step-up/ConfirmationsMobile.dc.html | add-admin-step-up（无新组件） |
