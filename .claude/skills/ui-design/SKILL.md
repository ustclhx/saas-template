---
name: ui-design
description: 新增页面、较大布局改动或建立项目视觉方向前，基于设计规范在 claude.ai 的 Design 画布产出设计稿（桌面/移动 × 浅/深 × 正常/空/加载/错误），经使用者确认后保存离线副本并记入 OpenSpec，再交给 new-page / new-static-page 实现。文案、小样式与缺陷修复免设计稿。
---

# 设计稿关卡

在含 `package.json` 与 `template.config.ts` 的项目根执行。下文路径均相对项目根；生成器副本已改包 scope，
先读 `apps/web/package.json` 的 name/dependencies，把示例中的 `@saas/*` 换成实际名称。
规范来源是仓库：完整阅读 `docs/design-system.md`，它与 `packages/ui` 不一致时以 `packages/ui` 为准。

## 1. 判断是否需要设计稿

按 `docs/design-system.md` §8.1 判断：

- **需要**：新增页面；改变区块结构、导航方式或信息层级的布局改动；新增页面模式；建立或改变视觉方向。
- **免**：文案与翻译、小样式（间距、对齐、已有 token 之间替换、组件变体切换）、缺陷修复、
  在已有内容集合中新增文章。免设计稿时直接回到调用方技能（`new-page`、`new-static-page`）或直接修改，不进入下文。

拿不准时按需要处理，并向使用者说明理由。已有经确认的设计稿时，在 OpenSpec change 的 `design.md`
「设计稿」一节找到链接与副本路径，确认副本文件存在后直接进入第 6 步：

```sh
rg -n '^## 设计稿' openspec/changes/*/design.md
ls docs/design/prototypes docs/design-system/prototypes 2>/dev/null
```

完成标准：写明本次是「需要」还是「免」及理由；需要时记录页面清单、用户角色、数据来源与所属 OpenSpec change。

## 2. 读取规范并确定视觉来源

```sh
test -f .template-base.json && echo 衍生项目 || echo 模板仓库
grep -nE '^export' packages/ui/src/index.ts
test -f packages/ui/src/project/index.ts && grep -nE '^export' packages/ui/src/project/index.ts
grep -nE -- '^ *--[a-z0-9-]+:' apps/web/src/styles/brand.css
ls docs/design 2>/dev/null
grep -n 'ui:' template.config.ts
```

- **模板仓库**：基线刻意保持中性（Fluid 默认视觉 + `ui.preset`），**不向使用者索取视觉参考**，设计稿只用现有 token 与组件。
- **衍生项目，已有视觉方向**（`docs/design/` 下有 `visual-system.md`，`brand.css` 有覆盖）：读取它与项目的
  Design System 镜像链接，按该方向出稿，不索取参考。
- **衍生项目，尚无视觉方向，或本次要改变方向**：先执行第 3 步。
- 读取 `docs/design-system.md` §1 的镜像链接；镜像的「最近同步提交」落后于 `git log -1 --format=%H -- packages/ui/src/styles`
  时，以仓库 token 为准，并在交付中提示协调者更新镜像。

完成标准：列出本次可用的组件、token 来源（基线 / 预设 / 品牌）与视觉方向文件；缺少的组件记为待补，不在页面里临时写。

## 3. 衍生项目建立视觉方向（仅需要时）

1. **索取参考**：请使用者提供 1–3 个参考网站或截图，并说明想借鉴的方面（配色、字体气质、密度、圆角、插画）。
   没有参考时停止本步，继续用模板基线，不自行发明配色。
2. **提出方向**：在模板基线上只改品牌层可覆盖的变量（`--primary`、`--fluid-accent`、`--focus-ring`、`--radius`、表面与文字色等），
   用 claude.ai 的 Design System Artifact 类型发布项目镜像，内容包括色板（浅 / 深）、字号阶梯、按钮 / 输入 / 卡片样例。
3. **多站点**：一个项目多个站点时，每个站点给出一组覆盖，写成 `:root[data-site="<站点>"]` 与
   `:root[data-site="<站点>"].dark`，由根布局写入 `data-site`。
4. **对比度**：正文与背景 ≥ 4.5:1；焦点环与背景、与主按钮 ≥ 3:1；浅色与深色都要满足。
5. **确认后写入项目自有文件**：
   - `apps/web/src/styles/brand.css`：只写变量，浅色与 `.dark` 成对，`.dark` 规则在 `:root` 之后；
   - `docs/design/` 下的 `visual-system.md`：参考来源（链接或截图文件）、借鉴点、变量取值、多站点表、镜像链接与同步提交；
   - 参考截图放 `docs/design/references/`。
   不修改 `packages/ui/src/styles/` 与 `packages/ui/src/components/`（模板拥有）。

完成标准：使用者确认视觉方向；`pnpm check:ui` 通过；brand.css 与视觉规范文档已提交到项目分支。

## 4. 产出设计稿

用 claude.ai 的 **Design** Artifact 类型产出画布（Claude Code 中调用 Artifact 工具 `action: quickstart`、`intent: design`，
按返回的类型说明创建）。Codex 等不能创建 Artifact 的 agent 在此停止，请协调者或使用者产出画布并提供链接。

- **画板矩阵**：每个页面 × 桌面（1440）/ 移动（390）× 浅色 / 深色 × 正常 / 空 / 加载 / 错误。
  不适用的状态（如纯静态页没有加载态）在画布中写明「不适用」及原因。
- **只用规范内的元素**：颜色、圆角、字号、阴影取第 2 步确定的 token；组件取 `@saas/ui` 与 `@saas/ui/project` 已有组件。
- **规范外需求**：需要新颜色、新字号或新组件时，在画布旁单列「token / 组件变更提议」，等使用者确认；
  模板 token 变更进模板基线，项目 token 变更进 `brand.css`，都不写死在页面里。
- **示例数据**：用中性领域的示例数据，不放真实用户信息与密钥。

完成标准：画布链接可打开，矩阵完整，变更提议单列。

## 5. 请使用者确认

把画布链接发给使用者，请其在画布上评论；按评论修改后再次请求确认。只有使用者明确表示「确认」才算通过，
沉默、只评论未表态都不算。确认后：

1. 保存可离线打开的副本：用 Artifact 工具 `action: read` 读取该画布（需要渲染后的页面时加 `page: true`），
   把保存下来的 HTML 复制到副本位置；断网打开核对所有画板可见。不能完整离线时，再为每个画板导出 PNG 放在同目录。
   - 衍生项目：`docs/design/prototypes/<页面>.html`
   - 模板仓库：`docs/design-system/prototypes/<页面>.html`
2. 在所属 OpenSpec change 的 `design.md` 增加或更新「设计稿」一节：

```md
## 设计稿

- <页面>：<画布链接>（YYYY-MM-DD 使用者确认）
  - 副本：docs/design/prototypes/<页面>.html
  - token / 组件变更：<无，或已确认的提议>
```

完成标准：副本文件已提交，OpenSpec 中链接与副本路径成对出现；后续实现与验收以副本为准，链接失效不影响开发。

## 6. 实现交接

回到调用方技能（`new-page`、`new-static-page`、`new-module`）实现，约束如下：

- 只从 `@saas/ui` 与 `@saas/ui/project` 导入组件；不直接导入 `radix-ui`、`motion`、`lucide-react`。
- 缺组件先补组件：模板仓库在 `packages/ui/src/components` 按 `packages/ui/UPSTREAM.md` 接入；
  衍生项目在 `packages/ui/src/project/` 新增并经 `@saas/ui/project` 导出。项目需要修改模板组件时，
  按 `docs/design-system.md` §9.2 的顺序处理（token → ui 配置 → project 包装 → 复制到 project 并在 forks 登记）。
- 不写死颜色、任意值尺寸、原生 `<select>`、`confirm()` / `alert()`；组件默认英文文案由应用层传入 `m.*()`。
- 四种状态都要实现；在 390px 宽无横向滚动，浅色与深色与副本一致。

验收（`<页面地址>` 换成实际路由，截图写入 `EVIDENCE_DIR`，未设置时用 `test-results/evidence/`）：

```sh
WEB_PACKAGE=$(node -p "JSON.parse(require('fs').readFileSync('apps/web/package.json','utf8')).name")
pnpm check
pnpm check:deps
pnpm typecheck
OUT=${EVIDENCE_DIR:-test-results/evidence}/ui-design && mkdir -p "$OUT"
pnpm --filter "$WEB_PACKAGE" exec playwright screenshot --viewport-size=390,844 --full-page "<页面地址>" "$PWD/$OUT/mobile-light.png"
pnpm --filter "$WEB_PACKAGE" exec playwright screenshot --viewport-size=390,844 --full-page --color-scheme=dark "<页面地址>" "$PWD/$OUT/mobile-dark.png"
pnpm --filter "$WEB_PACKAGE" exec playwright screenshot --viewport-size=1440,900 --full-page "<页面地址>" "$PWD/$OUT/desktop-light.png"
pnpm --filter "$WEB_PACKAGE" exec playwright screenshot --viewport-size=1440,900 --full-page --color-scheme=dark "<页面地址>" "$PWD/$OUT/desktop-dark.png"
```

截图与副本逐画板对照，差异逐项修正或记录为使用者确认过的偏离。需要登录的页面用 e2e 夹具或
`--load-storage` 加载会话；缺少条件时在交付中记为未验收。

## 常见故障

| 现象 | 处理 |
|---|---|
| 无法创建或打开 Design Artifact | 当前 agent 不支持时请协调者或使用者产出画布；链接失效时读取仓库副本继续 |
| 设计稿需要规范外颜色或字体 | 回到第 4 步单列变更提议，确认后改 token，不在页面写死 |
| `pnpm check:ui` 报颜色字面量或任意值 | 改用 token 工具类；确需例外（插画、第三方品牌图标）时在项目的 `scripts/check-ui.allow.local.json` 逐文件登记原因 |
| `pnpm check:deps` 报页面导入了 `radix-ui` / `motion` | 把交互封装进 `packages/ui`（模板）或 `packages/ui/src/project/`（项目）后经导出入口使用 |
| 深色下文字看不清 | brand.css 只覆盖了 `:root`；在 `.dark` 中补齐对应变量并重新核对对比度 |
| 模板组件指纹校验失败 | 项目改了模板组件；还原后按 `docs/design-system.md` §9.2 的定制顺序处理 |
| 截图全白或停在登录页 | 页面需要会话或数据；用 e2e 夹具登录、本地数据库种子数据后重截 |

交付：判断结论、视觉方向文件（如有）、画布链接、副本路径、OpenSpec 记录位置、变更提议与确认结果、截图对照结果、
未验收项。维护本技能时复制 `.agents/skills/ui-design/SKILL.md` 到 `.claude/skills/ui-design/SKILL.md`，用 `cmp` 保证字节一致。
