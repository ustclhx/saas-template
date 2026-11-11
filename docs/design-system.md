# 设计规范

模板与衍生项目的 UI 分层、设计 token、组件用法、动效、页面模式与设计关卡。规范以仓库为准：
token 在 `packages/ui/src/styles/`，组件在 `packages/ui/src/components/`，本文说明如何使用它们。
claude.ai 的 Design System Artifact 只是可视化镜像，供出设计稿前读取，二者不一致时以仓库为准。

决策来源：OpenSpec change `add-ui-design-system`（design D1–D11）。组件来源与上游月份见
[`packages/ui/UPSTREAM.md`](../packages/ui/UPSTREAM.md)。

## 1. 镜像与同步记录

| 字段 | 值 |
|---|---|
| Design System 镜像 | https://claude.ai/artifact/5bJuRwNuRe7xV5aQcCfULr（私有，需所有者共享后他人可见） |
| 最近同步提交 | e623daa（2026-11-11） |

镜像在**发布模板版本时**由协调者按仓库内容更新，同时把上表的「最近同步提交」改为该版本的提交；
平时合并 token 或组件 PR 不逐次更新。判断镜像是否落后（模板仓库中执行，退出码 0 表示不落后）：

```sh
git merge-base --is-ancestor "$(git log -1 --format=%H -- packages/ui/src)" <最近同步提交> && echo 镜像为最新
```

镜像落后时以本文与 `packages/ui` 为准。衍生项目跳过这项判断，以项目自己的 `docs/design/visual-system.md`
与项目镜像为准。

## 2. 分层

自下而上，每层只依赖下一层：

| 层 | 位置 | 说明 |
|---|---|---|
| 框架 | TanStack Start + Tailwind CSS v4 | 路由、SSR 与工具类生成 |
| 底层交互 | `radix-ui` 统一包 | 焦点管理、键盘与无障碍语义；不使用拆分的 `@radix-ui/react-*`。Base UI 以后再评估 |
| 组件层 | `packages/ui`（`@saas/ui`） | 以 Fluid Functionalism 的 Radix 版为主、shadcn 补缺，逐个组件接入并适配（`UPSTREAM.md`）|
| 设计 token | `packages/ui/src/styles/globals.css` → `presets/*.css` → `apps/web/src/styles/brand.css` | 三层：基线 → 预设 → 项目品牌，见第 3 节 |
| 页面模式 | 工作台、列表、表单、营销区块等 | 由组件组合而成的固定版式，见第 6 节 |
| 业务页面 | `apps/web/src/routes`、`apps/web/src/features` | 只组合 `@saas/ui` 与 `@saas/ui/project`，不写死颜色与尺寸 |

边界由检查脚本落地，不只靠约定：

- `pnpm check:deps`：`radix-ui`、`motion`、`lucide-react`、`class-variance-authority` 等只允许 `@saas/ui`
  依赖与导入，`@radix-ui/*` 在任何包中都禁止。规则在 `scripts/check-deps.rules.json`。
- `pnpm check:ui`（并入 `pnpm check`）：扫描 `apps/**/src/**/*.tsx`，禁止颜色字面量（hex / rgb / hsl / oklch）、
  className 任意值（`-[...]`）、原生 `<select>` 与 `confirm()` / `alert()`。例外逐文件登记在
  `scripts/check-ui.allow.json`（模板）与 `scripts/check-ui.allow.local.json`（项目），每条写明规则与原因。

## 3. 设计 token

### 3.1 三层归属

| 层 | 文件 | 归属 | 内容 |
|---|---|---|---|
| 基线 | `packages/ui/src/styles/globals.css` | 模板 | Fluid 默认视觉（中性灰阶）：语义色、表面阶梯、阴影、交互态、层级、字号阶梯；`@layer base` |
| 预设 | `packages/ui/src/styles/presets/{neutral,blue,violet,green}.css` | 模板 | 只覆盖强调色与焦点环，挂在 `<html data-preset="…">`，同为 `@layer base` |
| 品牌 | `apps/web/src/styles/brand.css` | 项目 | 项目品牌值；不分层，普通 `:root` / `.dark` 选择器即可覆盖前两层 |

模板基线刻意保持中性，不按任何具体产品的参考调整；视觉方向由衍生项目提供参考后写在品牌层。
`apps/web/src/styles/app.css` 已把 `brand.css` 作为最后一个导入，项目不需要改 `app.css`。

### 3.2 token 清单

数值会随上游与预设调整，本表只列名称与用途；当前取值直接从源文件读取：

```sh
# 基线（浅色在前，.dark 在后）
grep -nE -- '^ +--[a-z0-9-]+:' packages/ui/src/styles/globals.css
# 各预设覆盖的变量
grep -nE -- '--[a-z0-9-]+:' packages/ui/src/styles/presets/*.css
# 项目品牌层实际生效的覆盖（模板版本只有注释，无输出）
grep -nE -- '^ *--[a-z0-9-]+:' apps/web/src/styles/brand.css
```

| 类别 | 变量 | 工具类 | 用途 |
|---|---|---|---|
| 页面与容器 | `--background` `--foreground` `--card(-foreground)` `--popover(-foreground)` | `bg-background` `text-foreground` `bg-card` `bg-popover` | 页面底色取 `--surface-1`，卡片与弹层取 `--surface-3` |
| 强调 | `--primary` `--primary-foreground` `--primary-text` | `bg-primary` `text-primary-foreground` `text-primary-text` | 主按钮等实心强调；预设与品牌层改这里换色。强调色作文字（链接）用 `--primary-text`，深色预设下为更亮的同色系以满足 4.5:1 |
| 次级 | `--secondary(-foreground)` `--muted` `--muted-foreground` | `bg-secondary` `bg-muted` `text-muted-foreground` | 次要底色、说明文字（在 muted 与高层表面上满足 4.5:1） |
| 较重强调底 | `--accent` `--accent-foreground` | `bg-accent` | Fluid 原值，较重；普通悬停与当前项改用 `bg-hover` / `bg-active` |
| 状态 | `--destructive` `--destructive-light` `--success` | `text-destructive` `bg-destructive-light` `text-success` | 危险与成功；作文字时满足 4.5:1 |
| 边框与输入 | `--border` `--input` | `border-border` `border-input` | 边框由前景色混出，随明暗自动变化 |
| 交互态 | `--hover` `--active` `--selected` `--tint` `--tint-hover` | `bg-hover` `bg-active` `bg-selected` `bg-tint` | 悬停、按下、选中与按钮底色层 |
| 焦点与品牌强调 | `--fluid-accent` `--focus-ring` `--ring` | `bg-fluid-accent` `ring-ring` | 唯一的品牌强调色：开关、选区与焦点环；焦点环与背景、与主按钮 ≥ 3:1 |
| 表面阶梯 | `--surface-1` … `--surface-8` | `bg-surface-1` … `bg-surface-8` | 浅色靠阴影分层，深色层级越高越亮 |
| 阴影 | `--shadow-1` … `--shadow-8` | `shadow-surface-1` … `shadow-surface-8` | 与表面层级配对使用 |
| 圆角 | `--radius` | `rounded-sm/md/lg/xl` | 基准值；控件 `rounded-lg`、容器 `rounded-xl`；按钮、选择器与弹窗的形状另由 `ui.shape` 控制 |
| 字号阶梯 | `--fs-*` / `--lh-*`（display、title、subtitle、body、caption、micro，各含 `-compact`） | `text-display` `text-title` `text-subtitle` `text-body` `text-caption` `text-micro` | 页面只用这六个角色，不写任意字号 |
| 层级 | `--z-sticky` `--z-overlay` `--z-modal` `--z-popover` `--z-tooltip` `--z-toast` | — | 离开组件流的浮层只用这些值；Toast 在模态与提示之上 |
| 控件 | `--control-border` `--field-border` `--switch-thumb-on` `--switch-thumb-off` | — | 复选框边框与开关关闭轨道、输入类边框、开关滑块 |
| 字体 | `--font-sans` | `font-sans` | 自托管 Inter 可变字体（opsz），中文回退系统字体 |

新增 token 先改基线（模板）或品牌层（项目），再用工具类引用；页面中不出现原始颜色值。

### 3.3 主题预设与 ui 配置

`template.config.ts` 的 `ui` 段：

| 键 | 取值 | 作用 |
|---|---|---|
| `preset` | `neutral`（默认）`blue` `violet` `green` | 强调色与焦点环；根布局在 SSR 时写入 `<html data-preset>`，首屏无闪烁 |
| `shape` | `sharp` `rounded`（默认）`pill` | 按钮、选择器与弹窗的圆角形状，经 `UiRoot` 下发 |
| `density` | `default`（默认，控件 36px）`compact`（28px） | 控件尺寸与字号阶梯 |

省略的键取默认值，未知取值在构建期报错。新建项目时可用生成器参数选预设，写入 `template.config.ts` 与
`.template-base.json`：`pnpm create-project --name acme --domain acme.example --theme violet`（可选值见 `pnpm create-project --help`）。每个预设同时定义浅色与 `.dark`，对比度由
`packages/ui/test/presets.test.ts` 断言：正文 ≥ 4.5:1，焦点环与背景、与主按钮 ≥ 3:1。
明暗主题由 `themeInitScript` 在首屏前设置 `<html class="dark">`，`ThemeToggle` 提供浅色、深色与跟随系统。

## 4. 组件用法

页面只从 `@saas/ui`（模板组件）与 `@saas/ui/project`（项目组件）导入，不直接导入 Radix、motion、lucide-react
等底层库（`pnpm check:deps` 会失败）。当前可用的公开组件以 `packages/ui/src/index.ts` 为准：

```sh
grep -nE '^export' packages/ui/src/index.ts
```

规则：

- **根组件**：根布局用 `UiRoot` 包裹一次，传入 `template.config.ts` 的 `shape`、`density`；上下文 hooks 与 Provider
  不导出（随上游月度改名），只经 `UiRoot` 配置。
- **按钮**：`Button` 保留 shadcn 变体（`default` `destructive` `outline` `secondary` `ghost` `link`）与尺寸；
  需要加载态时用 `loading`，图标用 `leadingIcon` / `trailingIcon`，不要在按钮里手写转圈。
- **选择**：用 `Select` 系列，不用原生 `<select>`。`SelectItem` 需要显式 `index`（从 0 起，与渲染顺序一致），
  它同时驱动悬停高亮注册与渲染期的高亮判断。
- **确认**：删除等危险操作用确认对话框，不用 `confirm()`；取消后焦点回到触发按钮。确认对话框用
  `AlertDialog`（受控用法替换 `confirm()`，关闭后焦点回到打开前的元素，退场期间按钮不可再次触发）。替换步骤见 [4.1](#41-替换原生控件)。
- **列表与表单**：后台列表用 `DataTable` 与 `apps/web/src/features/admin/list.ts`；表单用 `useAppForm` / `TextField`。
- **多语言文案**：组件不带英文默认文案，类型上要求调用方传入（`apps/web` 中传 `m.*()`）：

  | 组件 | 属性 | 说明 |
  |---|---|---|
  | `DialogContent` | `closeLabel` | 关闭按钮的可读名称；`showCloseButton={false}` 时不需要 |
  | `SelectTrigger` | `placeholder` | 未选择时显示的文字 |
  | `AlertDialogAction` / `AlertDialogCancel` | `children` | 按钮文字；标题与说明同样由调用方传入 |
  | `Switch` | `label` 或 `aria-label` | 不显示标签时传 `aria-label` |
  | `Tooltip` | `content` | 提示文字 |
  | `ThemeToggle` | `labels` | 由调用方传入 |
  | `DataTable` | `labels` | 全部文案必填（4.2 去掉英文默认值）；`apps/web` 用 `dataTableLabels()`（`features/i18n/table-labels.ts`）或后台的 `adminTableLabels()` |
  | `Tabs` / `TabsItem` | `aria-label` / `label` | `label` 在仅图标（`activeLabel`）时兼作可读名称；`Tabs` 的 `aria-label` 建议传 |
  | `DropdownSearch` / `DropdownEmpty` | `placeholder` / `children` | 搜索框占位文字（兼作可读名称）与无结果文字；`MenuItem`、`DropdownSubTrigger` 的 `label` 必填 |
  | `ComboboxInput` / `ComboboxChips` | `placeholder`；`clearable` 时 `clearLabel` | 占位文字与清除按钮名称 |
  | `ComboboxChips` | `chipsLabel`、`removeLabel(label)` | 已选标签组名称与每个移除按钮名称 |
  | `Combobox` / `ComboboxEmpty` | `onCreate` 时 `createLabel(query)` / `children` | 创建行文字与无匹配文字 |
  | `CommandMenu` | `labels`（`placeholder`、`suggestions`、`tabs`、`selectHint`、`tabsHint`、`closeHint`） | 搜索框占位（兼作可读名称）、建议分组标题、标签栏名称与底部按键提示；键帽字形保留 |
  | `CommandMenuDialog` | `title`（`description` 可选） | 对话框的可读名称 |
  | `Toaster` | `labels`（`region`、`announcement`、`close`） | 通知区域名称（可含 `{hotkey}`）、读屏播报前缀、关闭按钮名称；`toast()` 的内容与 `action.label` 由调用方传入 |
  | `SidebarProvider` | `labels`（`title`、`expand`、`collapse`、`rail`、`railResize`、`railCollapse`；开启 peek 时 `peek`） | 移动抽屉名称、触发按钮与拖拽条的名称和提示；`SidebarMenuButton` 在 `status="unread"` 时必传 `unreadLabel` |

  新组件引入新的可读文字时，同步更新本表与 `packages/ui/UPSTREAM.md`。
  `labels` 对象可以内联传入（`labels={{ … m.*() … }}`）：不会导致重新挂载，Command Menu 内部另按字段稳定引用；
  放在频繁重渲染的组件里时可提到 `useMemo` 中减少子组件渲染。
- **图标**：业务页面从 `@saas/ui/icons` 按名称导入（如 `import { Folder } from '@saas/ui/icons'`），传给组件的图标槽位
  （`Button` 的 `leadingIcon`、`SidebarMenuButton` / `TabsItem` / `CommandMenu` 条目的 `icon` 等）；apps 不直接依赖
  lucide-react（`pnpm check:deps`）。入口只登记常用图标，项目需要更多时在 `packages/ui/src/project/` 中再导出。
  组件内部的图标槽位（`UiRoot` 的默认图标表，会进入首页包）目前 9 个；**超过约 15 个或首页 JS 增量超过 5 KB 时**，
  改为各组件自带回退图标、只在 `UiRoot` 传入替换项，不再扩充默认表。
- **通知（Toast）**：`toast()` 来自零依赖的 store（`toast-store.ts`），任何地方都可调用；`<Toaster />` 含动效库
  （约 44 KB gzip），只在 app / admin 布局中用 `React.lazy` 挂载一次，**不放进根布局**，营销页不加载：

  ```tsx
  const Toaster = lazy(() => import('@saas/ui').then((ui) => ({ default: ui.Toaster })))
  // 布局中：<Suspense fallback={null}><Toaster labels={{ region: m.…(), announcement: m.…(), close: m.…() }} /></Suspense>
  ```
- **侧边栏**：`collapsible="icon"`（收起为图标栏）时每个 `SidebarMenuButton` 都必须传 `icon`，收起后名称由 Tooltip
  显示（`tooltip` 省略时取行内文字）；默认 `offcanvas`。快捷键 `shortcut` 默认关闭，需要时显式传入（如 `"["`）；
  嵌入式预览等区域可加 `data-keyboard-scope` 属性，焦点在其中时外层侧栏的快捷键不响应（受支持的属性）。
  折叠状态由布局在 `onOpenChange` 中写 cookie、服务端读回 `defaultOpen`（tasks 8.3）。
  `SidebarProvider` 的 `widthIcon` 设图标栏宽度（工作台用 4rem）；移动抽屉里点击同页链接后自动关闭，焦点回到打开抽屉的按钮
  （`<Sidebar closeOnNavigate={false}>` 关闭此行为）。收起时才显示 / 隐藏的自定义内容用 `in-data-[collapsible=icon]:` 变体，
  只在抽屉里显示的内容用 `in-data-[mobile=true]:` 变体。
- **命令面板**：键帽按平台显示 ⌘ 或 Ctrl；SSR 首帧无法得知平台，需要时在布局中用
  `<CommandMenuPlatform mac={…}>` 包裹，`mac` 取自请求头 `Sec-CH-UA-Platform` 或 User-Agent，避免水合后键帽变宽。
- **浮层层级**：自定义吸顶、遮罩与弹层用 `--z-*` 变量，不写任意 `z-[…]`。

已接入：Button、Input、Textarea、Select、Combobox、Checkbox、Switch、Badge、Tooltip、Tabs、Dropdown（菜单）、
Command Menu、Dialog、AlertDialog、Toast、Sidebar、Card、Alert、Separator、Label、ScrollArea、DataTable、Form。
`Toaster` 含动效库（约 44 KB gzip），只在需要的页面挂载，不放进根布局；以后全站使用时按需动态加载。缺少的组件先在 `packages/ui` 补齐（模板）或在 `packages/ui/src/project/` 补齐（项目），
再实现页面，不在页面里临时写一个。

### 4.1 替换原生控件

存量的原生 `<select>`、`confirm()` 与 admin 私有控件按本节逐处替换；待替换位置以
`scripts/check-ui.allow.json` 的 `pendingReplacement` 为准（原生 select 在各功能目录，`window.confirm` 只剩
`features/workspace/components.tsx` 两处）。样例：`apps/web/src/routes/admin/models.tsx`（Select 的各种变体）、
`apps/web/src/routes/admin/credits.tsx`（AlertDialog、Textarea），对应 e2e 为 `apps/web/e2e/admin-models.spec.ts`、
`admin-model-params.spec.ts`、`admin-credits.spec.ts`。

每处替换的收尾：

1. 从 `scripts/check-ui.allow.json` 的 `pendingReplacement` 删除该处登记（同一文件的条目全部清除后删掉整个键），
   运行 `pnpm check:ui`。
2. 查找并更新依赖原生控件的测试：
   `git grep -nE "selectOption|on(ce)?\('dialog'|option\[value|tagName" -- apps/web/e2e apps/web/e2e-live`
   （包含 `e2e/staging-acceptance`），以及该组件的单元测试（见下文「测试」）。
3. 只改控件本身与必需的标签结构；页面布局、文案和业务逻辑不顺带调整。

#### Textarea

admin 页面把 `Textarea` 的导入从 `features/admin/ui.tsx` 改为 `@saas/ui`，属性不变。组件自带高度（3 行起随内容
增高到 10 行后滚动）与字号，去掉 `md:text-sm`、`min-h-*` 等尺寸类，保留 `font-mono` 这类语义类。

#### Select

导入 `Select, SelectContent, SelectItem, SelectTrigger`（分组另加 `SelectGroup, SelectLabel, SelectSeparator`）。

| 原生写法 | 替换为 |
|---|---|
| `<select value={v} onChange={(e) => f(e.target.value)}>` | `<Select value={v} onValueChange={f}>` |
| `value`、`defaultValue`、`disabled`、`required`、`name` | 放在 `Select` 上 |
| `id`、`aria-label`、`aria-describedby`、`aria-invalid`、`onBlur`、宽度类 | 放在 `SelectTrigger` 上 |
| 展开的属性对象（`{...common}`、`{...field('x')}`） | 拆开：`value`/`disabled`/`required`/`name` 给 `Select`，`id`/`aria-*` 给 `SelectTrigger`，`onChange` 改写为 `onValueChange` |
| `<option value={x}>文字</option>` | `SelectContent` 内的 `<SelectItem index={i} value={x}>文字</SelectItem>` |
| `<option disabled>` | `<SelectItem disabled>`，仍占一个 `index` |
| `<optgroup label="…">` | `<SelectGroup><SelectLabel>…</SelectLabel>…</SelectGroup>`，组间可放 `<SelectSeparator />` |
| 原生 select 上的 `rounded-md border p-2` 等外观类 | 删除 |

基本形态（受控、值总是存在）：

```tsx
<div className="grid gap-2">
  <label className="font-medium text-sm" htmlFor={`${idPrefix}-mode`}>
    {m.admin_pricing_mode()}
  </label>
  <Select disabled={disabled} value={draft.mode} onValueChange={(mode) => set({ mode: mode as Mode })}>
    <SelectTrigger id={`${idPrefix}-mode`} className="w-full" placeholder={m.admin_pricing_mode()} />
    <SelectContent>
      <SelectItem index={0} value="per_call">{m.admin_per_call()}</SelectItem>
      <SelectItem index={1} value="token">{m.admin_per_token()}</SelectItem>
    </SelectContent>
  </Select>
</div>
```

规则：

- **index**：`SelectContent` 内从 0 起按渲染顺序连续编号，跨分组不重置；`SelectLabel`、`SelectSeparator` 不占编号。
  静态列表手写 0、1、2；动态列表先 `filter` 成最终数组，再用 `map((item, index) => …)` 的下标（不要用过滤前数组的
  下标）。条件渲染的选项（`{cond && <option …>}`）先组成数组再 `map`，不要手写会跳号的下标。分组时在渲染函数里
  累计计数，每次渲染从 0 开始：

  ```tsx
  function PlanOptions({ groups }: { groups: PlanGroup[] }) {
    let index = 0
    return (
      <SelectContent>
        {groups.map((group) => (
          <SelectGroup key={group.id}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.items.map((item) => (
              <SelectItem key={item.id} index={index++} value={item.id}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    )
  }
  ```
- **取值必须是非空字符串**：Radix 遇到 `value=""` 的选项会抛错。数字、布尔等非字符串值转成字符串（如枚举用
  `String(i)` 作值、读回时 `enum[Number(v)]`）。原生的空值选项按语义选一种处理：
  - **必填，或选后不需要再清空**（「请选择…」「Choose a payment」）：删除该 `<option>`，文字改作 `SelectTrigger`
    的 `placeholder`；值为 `''` 时触发器显示占位文字。例：models.tsx 的服务商（`m.admin_choose_a_provider()`）。
  - **可选，且需要能选回空值**（「默认 / 全部 / 无」，parameter-form 的非必填参数与文件选择）：保留这一项，值用
    占位值 `'__default__'`，读写时换回 `''`（或 `undefined`）。常量放在页面已导入的 feature 模块里并导出，
    e2e 按值选择时导入同一个常量（路由文件不导出非路由内容）：

    ```tsx
    // features/ai/admin-model-params.ts
    export const DEFAULT_CHARGE_ON = '__default__'
    export const CHARGE_ON_VALUES = ['any_output', 'success'] as const

    // 页面
    <Select
      value={CHARGE_ON_VALUES.some((v) => v === draft.chargeOn) ? draft.chargeOn : DEFAULT_CHARGE_ON}
      onValueChange={(value) => set({ chargeOn: value === DEFAULT_CHARGE_ON ? '' : value })}
    >
      <SelectTrigger id={…} className="w-full" placeholder={m.admin_default()} />
      <SelectContent>
        <SelectItem index={0} value={DEFAULT_CHARGE_ON}>{m.admin_default()}</SelectItem>
        <SelectItem index={1} value="any_output">{m.admin_any_output()}</SelectItem>
        <SelectItem index={2} value="success">{m.admin_success()}</SelectItem>
      </SelectContent>
    </Select>
    ```
- **值必须在选项里**：原生 select 的值不在选项中时显示第一项，Select 的触发器会是空白。动态选项先校验再传值：
  `value={options.some((o) => o.id === v) ? v : ''}`（值为 `''` 时显示 placeholder）。需要特别处理的：
  `routes/app/$slug/billing.tsx` 的 `priceId`（切换支付方式后可能不在新列表里）、`features/ai/model-picker.tsx`
  的 `value ?? models[0]?.id`（`value` 可能是已下架的模型）、`features/ai-media/parameter-form.tsx` 的文件选择
  （文件可能还未就绪）。样例：models.tsx 的服务商
  `value={mediaProviders.includes(draft.provider) ? draft.provider : ''}`。
- **placeholder 必传**：有「请选择…」文案就用它；值总是存在的选择框传字段标签的文案（如 `m.admin_kind()`）。
- **文案来源**：跟随该页面现有方式。页面用 `m.*()` 时复用或新增 `apps/web/messages/{en,zh}/<feature>.json`
  中的键（两种语言同时加）；通用的「取消」用 `m.common_cancel()`。页面仍是英文字面量的（如
  `features/workspace/components.tsx`），沿用同风格字面量，不在替换时顺带国际化。
- **标签与外层元素**：触发器是 `<button>`，不要放进 `<label>` 里。把 `<label …>文字 <select …/></label>` 改为上面的
  「`div` + 兄弟 `label htmlFor` + `SelectTrigger id`」结构：原 label 的布局类（`grid gap-2`）留在 `div`，文字类
  （`font-medium text-sm`）留在 `label`；admin 表单也可用 `features/admin/ui.tsx` 的 `Field`。原来没有 id 的用
  `useId()` 生成；只有 `aria-label`（无可见标签，如语言切换）的把 `aria-label` 放到 `SelectTrigger`。
  `SelectTrigger` 最外层是块级 `<div>`，外层不能是 `<p>`、`<label>`、`<span>`，否则 SSR 水合报错：原来包在
  `<p>` 里的（如 `features/settings/account-sections.tsx`、`features/ai/model-picker.tsx`）改为 `<div>`，包在带
  样式的 `<label>` 里的（如 `features/i18n/language-controls.tsx`）把该 `label` 改为 `div` 并保留其类名。
- **宽度**：触发器默认最小 160px、随内容变宽；与输入框并排或同列的表单字段加 `className="w-full"`。
- **禁用**：外层 `<fieldset disabled>` 不会进入 Select 的状态，fieldset 在水合后仍会禁用的（如请求进行中），
  需要同时给 `Select` 传 `disabled`（样例：models.tsx 把编辑器的 `disabled` 传给每个 Select，并给
  `ParamsSchemaEditor` 加了 `disabled` 属性）。只在水合前禁用的 fieldset（如 `HydratedControls`）不需要传；
  原来直接写在 `<select>` 上的 `disabled={!ready}`、`disabled={pending}` 照搬到 `Select`。
- **选择后触发动作**（切换空间、修改成员角色、切换语言）：在 `onValueChange` 中执行原 `onChange` 的逻辑。`value`
  继续由当前状态或服务端数据驱动，失败时不改它，触发器自然显示原值；进行中用 `disabled` 防止重复触发。
  选后执行但不保留选择的「动作型」选择框固定 `value=""` 并给 `placeholder`（样例：models.tsx 的参考模板）。
- **表单提交**：
  - 受控且提交时从 state 读取（大多数页面）：不需要 `name`，也不写隐藏 input。
  - 依赖 `FormData` 或非受控：`Select` 放在 `<form>` 内并传 `name`（非受控时用 `defaultValue`），Radix 会自动
    渲染一个隐藏的原生 `<select aria-hidden>` 承载 `name`、值与 `required`，`FormData` 能读到；不要再手写
    `<input type="hidden">`，否则同名字段会出现两次。
  - `required`：保留在 `Select` 上（表单内会触发原生校验），但浏览器提示定位在隐藏元素上，提交处理中原有的
    空值检查保留（或在未选择时禁用提交按钮）。
  - TanStack Form（现有代码用 `form.Field`）：值同样受控；下例的空值是「跟随默认」，用占位值常量 `LOCALE_DEFAULT`
    （`'__default__'`）：

    ```tsx
    <form.Field name="locale">
      {(field) => (
        <div className="grid gap-2">
          <Label htmlFor={field.name}>{copy.locale}</Label>
          <Select
            value={field.state.value || LOCALE_DEFAULT}
            onValueChange={(v) => field.handleChange(v === LOCALE_DEFAULT ? '' : v)}
          >
            <SelectTrigger
              id={field.name}
              onBlur={field.handleBlur}
              aria-describedby={`${field.name}-errors`}
              placeholder={copy.localeDefault}
            />
            <SelectContent>…</SelectContent>
          </Select>
          <FieldErrors id={`${field.name}-errors`} errors={field.state.meta.errors} />
        </div>
      )}
    </form.Field>
    ```
- **服务端渲染与 `valueLabel`**：Radix 要到客户端才把选中项文字放进触发器，SSR 与水合前触发器为空（隐藏的原生
  select 也没有选项）。公开或预渲染页面（`routes/pricing.tsx`、`features/i18n/language-controls.tsx`）以及任何
  水合前禁用的选择框（`disabled={!ready}`、`HydratedControls` 内）必须给 `SelectTrigger` 传 `valueLabel`，从渲染
  选项的同一份数组算出，并加 `className="w-full"` 或固定宽度，避免水合后宽度跳动；`disabled={!ready}` 保留在
  `Select` 上。后台与登录后页面的其他选择框可以不传。

  以 `routes/pricing.tsx` 的支付方式为例（该页仍用英文字面量，选项文字与原 `<option>` 一致）：

  ```tsx
  const providerId = useId()
  const current = catalog.providers.find((p) => p.id === provider)
  const providerLabel = (p: (typeof catalog.providers)[number]) =>
    p.available ? p.id : `${p.id} — unavailable`

  <div className="grid gap-2">
    <label htmlFor={providerId}>Payment method</label>
    <Select value={current ? provider : ''} disabled={!ready} onValueChange={setProvider}>
      <SelectTrigger
        id={providerId}
        className="w-full"
        placeholder="Payment method"
        valueLabel={current ? providerLabel(current) : undefined}
      />
      <SelectContent>
        {catalog.providers.map((p, index) => (
          <SelectItem key={p.id} index={index} value={p.id} disabled={!p.available}>
            {providerLabel(p)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
  ```
- **测试**：
  - e2e：`selectOption` 改用 `apps/web/e2e/select.ts` 的 `chooseOption(trigger, '选项文字')`，触发器按可访问名称
    定位：`form.getByRole('combobox', { name: 'Pricing mode', exact: true })`。水合前点击无效，函数会重试到列表
    展开，原来为等水合而包的 `expect.poll` 可以去掉。只有取值的数据驱动脚本用 `chooseOption(trigger, { value })`
    （按 `SelectItem` 的 `data-value` 匹配，空值传页面导出的占位值常量）。`toHaveValue(x)` 改为
    `toHaveText('选项文字')`；`locator('option[value=…]')` 计数改为判断触发器存在或打开后计 `getByRole('option')`；
    `tagName` 为 `SELECT` 的断言改为 `BUTTON`。
  - `apps/web` 单元测试在 node 环境用 `renderToString`：只能断言 `role="combobox"`、id / `aria-label`、
    占位文字（值为空时）、传了 `valueLabel` 时的选中文字以及表单内隐藏 `<select name>` 的存在；选项列表不在 SSR
    输出里，改为测试生成选项的纯函数，或移到 e2e。
- **已知限制**（后续处理，替换时不用绕开）：触发器上的 `onBlur` 在打开弹层时就会触发（焦点移入列表），校验配在
  `onBlur` 上时会提前显示错误；语言切换替换后外层 `div` 与触发器各有一层边框，后续去掉外层边框。

#### Checkbox

用 `@saas/ui` 的 `Checkbox` 替换 `CheckboxField`。受控值保持 `checked={value}`，回调改为
`onCheckedChange={setValue}`（参数是 boolean，不再读取 `event.target.checked`）。

```tsx
<Label htmlFor="registration-enabled" className="font-normal text-sm leading-normal">
  <Checkbox id="registration-enabled" checked={enabled} onCheckedChange={setEnabled} />
  {m.admin_registration_enabled()}
</Label>
```

`Label` 的文字保持原可访问名称，`htmlFor` 与 Checkbox 的 `id` 一致；整行标签仍可点击。
重复列表的 id 要包含记录标识。需要禁用时保留原 `disabled` / `fieldset disabled`。

依赖 `FormData` 时，把 Checkbox 放在 `<form>` 内并保留 `name` / `value`（非受控用 `defaultChecked`）。
Radix 会生成携带相同 `name` / `value` 的隐藏 checkbox：未勾选不提交，勾选且未指定 `value` 时提交 `"on"`；
服务端原解析不变，不再手写隐藏 input。提交时从 state 读取的受控表单无需添加 `name`。
e2e 用 `getByRole('checkbox', { name: '原标签文字', exact: true })` 勾选，并验证保存后的业务状态。

#### AlertDialog（替换 `confirm()`）

整页（或整个列表）只放一个受控确认框，不要在每行各放一个：行内按钮只记录目标并打开。`open` 与目标分开保存，
关闭后目标保留到退场动画结束，说明文字不会在淡出时变空。

```tsx
const [revokeOpen, setRevokeOpen] = useState(false)
const [revokeTarget, setRevokeTarget] = useState<Row | null>(null)

// 行内按钮（替换 `if (window.confirm(…)) void run(row)`）
<Button
  type="button"
  variant="outline"
  onClick={() => {
    setRevokeTarget(row)
    setRevokeOpen(true)
  }}
>
  {m.admin_revoke_batch()}
</Button>

<AlertDialog
  open={revokeOpen}
  onOpenChange={(open) => {
    if (!busy) setRevokeOpen(open) // 请求进行中忽略 Escape
  }}
>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>{m.admin_revoke_batch_confirm_title()}</AlertDialogTitle>
      <AlertDialogDescription>
        {m.admin_revoke_batch_confirm_description({ batchId: revokeTarget?.id ?? '' })}
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel disabled={busy}>{m.common_cancel()}</AlertDialogCancel>
      <AlertDialogAction
        variant="destructive"
        loading={busy}
        onClick={(event) => {
          event.preventDefault() // 阻止立即关闭，等请求结束再关
          void confirmRevoke()
        }}
      >
        {m.admin_revoke_batch()}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

按原调用的结果展示方式选一种 `onClick` 写法：

- **结果显示在页面状态行**（原代码 `confirm` 后调用的函数自己设置 message / error，样例 credits.tsx）：
  ```tsx
  async function confirmRevoke() {
    if (!revokeTarget || busy) return
    await submit(/* 原 confirm 之后的调用，参数取自 revokeTarget */)
    setRevokeOpen(false) // 成功失败都关闭，结果由页面原有的 role="status" / 错误区域展示
  }
  ```
- **错误显示在对话框内**（失败后让用户在原处重试）：增加 `const [confirmError, setConfirmError] = useState('')`，
  打开时清空；失败时 `setConfirmError(…)` 且不关闭，成功时 `setRevokeOpen(false)`；在 `AlertDialogHeader` 之后放
  `{confirmError ? <p role="alert" className="text-destructive text-sm">{confirmError}</p> : null}`。
- **不需要等待**（原代码 `confirm` 后同步执行或不关心结果）：`AlertDialogAction` 不调用 `preventDefault()`，
  `onClick={() => run(target)}`，对话框随点击关闭；`busy`、`loading` 不需要。

同一列表有多种需要确认的动作（如成员行的「移除」与「转让所有权」）时，仍只放一个确认框，目标里带上动作，
标题、说明、按钮文字与 `variant` 按动作取；只有危险操作（删除、移除、撤销）用 `destructive`：

```tsx
type Pending = { action: 'remove' | 'transfer'; member: Member }
const [confirmOpen, setConfirmOpen] = useState(false)
const [pending, setPending] = useState<Pending | null>(null)
const copy = pending?.action === 'transfer'
  ? { title: 'Transfer ownership?', body: `${pending.member.name} becomes the owner.`, confirm: 'Transfer', variant: 'default' as const }
  : { title: 'Remove member?', body: `${pending?.member.name ?? ''} loses access to this workspace.`, confirm: 'Remove', variant: 'destructive' as const }
// 行内：onClick={() => { setPending({ action: 'remove', member: m }); setConfirmOpen(true) }}
// AlertDialogTitle/Description/Action 分别用 copy.title、copy.body、copy.confirm，Action 传 variant={copy.variant}
```

规则：

- **文案**：原 `confirm('…?')` 拆为标题（简短的问句，如「撤销剩余积分？」）与说明（对象名称与后果，如批次号、
  「此操作无法撤销」）；确认按钮文字用动作动词（通常与行内按钮相同），取消用 `m.common_cancel()`（英文字面量
  页面用 `'Cancel'`）。删除、撤销、移除等危险操作用 `variant="destructive"`。文案来源规则同 Select。
- **焦点返回**：组件记录打开前获得焦点的元素并在关闭后归还，前提是该元素在对话框打开期间没有被重新挂载。
  `DataTable` 按函数调用渲染单元格（tasks 4.2 已在组件内根治），`columns` 每次渲染新建也不会替换行内按钮，
  不需要为此 `useMemo` 列定义（`packages/ui/test/data-table.test.tsx` 覆盖）。非 DataTable 的列表保持行 `key`
  稳定即可。确认后所在行被删除时焦点落到 `body`，属已知限制。
- **防重复**：组件在退场期间吞掉按钮点击；异步时再用 `busy` 守卫函数入口，并给确认按钮 `loading`、取消按钮
  `disabled`。
- **测试（e2e）**：删除 `page.once('dialog', (d) => d.accept())` / `page.on('dialog', …)`，改为点击触发按钮后
  操作对话框；原 `dialog.dismiss()` 改为点「取消」，并断言没有发生写入：

  ```ts
  await row.getByRole('button', { name: 'Revoke batch' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Revoke the remaining credits?' })
  await dialog.getByRole('button', { name: 'Revoke batch', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  ```

## 5. 动效与减少动态效果

- 动效只在 `@saas/ui` 组件内部实现，档位取 `packages/ui/src/lib/springs.ts` 的 `spring.fast` / `moderate` / `slow`
  （移动的东西越大越慢），不手写时长；退出用对应档位的 `.exit`。
- `UiRoot` 以 `MotionConfig reducedMotion="user"` 包裹：系统开启「减少动态效果」时去掉位移与布局动画，
  只保留淡入淡出或直接切换。纯 CSS 动画用 Tailwind 的 `motion-reduce:` 变体降级。
- 营销页优先用 CSS 过渡；`motion` 只随交互组件按需加载，不进入营销首屏。新增动效区块须保持营销页
  Lighthouse SEO 与可访问性分数不下降，并在数据库不可用时仍可预渲染。

## 6. 页面模式

| 模式 | 组成 | 状态 |
|---|---|---|
| 工作台 | 侧边栏（分组由项目注册、可折叠、手机抽屉、底部升级与账户入口），与顶部布局经 `ui.appLayout` 二选一 | 现有（tasks 8.3），见下文 |
| 后台列表 | `DataTable` + `adminListSearch` / `adminListPage`，筛选改变回第一页 | 现有 |
| 表单 | `useAppForm` + 字段组件，提交按钮 `SubmitButton`，错误用 `FieldErrors` | 现有 |
| 长文阅读 | 安全 Markdown、自动目录、吸顶高亮、阅读进度、打印样式 | 将由 tasks 8.4 提供 |
| 营销区块 | 数据背书（未配置不渲染）、三步流程、编号产品矩阵、悬浮 AI 入口 | 将由 tasks 8.5 提供 |
| 业务界面组件 | 推荐追问、消息评分、嵌入式对话、余额不足弹窗、预计消耗、会员锁定、每日领取 | 将由 tasks 8.6 提供，接口写入本节 |

**AI 聊天组件（tasks 9.1 选型结论，待使用者确认）**：倾向移植 Fluid 的 AI 组件（chat-message、thinking-steps、
thinking-indicator、input-message 等，Radix 版，MIT），另写一层把 AI SDK `UIMessage` 各类 parts（正文、推理、工具调用）
分发给组件的转换层；Vercel AI Elements 只作参考，不整体引入（shadcn 风格需逐个改样式，依赖重，上游声明 `ai` ^6）。
Markdown 与代码高亮另行选型，优先轻量方案；替换聊天页与 SubjectChat 另起 change。完整对比见本 change 的
`ai-components.md`（归档后在 `openspec/changes/archive/` 下）。

**工作台（tasks 8.3）**：`template.config.ts` 的 `ui.appLayout` 取 `'sidebar'`（默认）或 `'topbar'`（原顶部布局，
结构不变），构建期决定。侧边栏布局在 `apps/web/src/features/app-shell/`：侧边栏在 surface-1，展开 248px、收起为 64px
图标栏，折叠状态存 cookie `app_sidebar`，服务端首屏按 cookie 渲染；内容区是 `SidebarInset` 的 8px 外边距
surface-2 + shadow-2 圆角面板，768px 以下侧边栏收为抽屉、面板铺满。导航条目用注册表登记，不改布局文件：

```ts
import { registerAppNav } from './nav.ts'
registerAppNav({
  group: 'content', // 固定分组 tools / content / settings，按此顺序显示，空分组不渲染
  items: [{ id: 'reports', label: m.reports_title, icon: Folder, to: '/app/$slug/reports', order: 10,
    visible: ({ role, readOnly, isPersonal }) => role !== 'member' }],
})
```

模板条目在 `nav.default.ts`（可见性与原顶部布局一致）；项目条目写在项目自有的 `nav.project.ts`（模板创建后不再修改），
同 id 覆盖模板条目，`unregisterAppNav(id)` 移除。当前项取路径相同或位于条目之下、路径最长的条目（`exact` 只匹配相同路径）。
注册表只作用于侧边栏布局；顶部布局保持原有链接。
页面需要把面包屑、操作按钮或进度条放进工作台顶部条时渲染 `<AppShellBar title={…} actions={…} progress={…} />`
（`features/app-shell/bar.tsx`，内容经 portal 挂到顶部条的标题、操作插槽与底边进度条位置，水合后出现；服务端首屏显示当前导航项名称）；
`useAppShellBarAvailable()` 为 false（顶部布局）时页面自行渲染工具条。打印时侧边栏、顶部条与通知入口隐藏，面板去掉外边距与阴影，正文随文档流完整输出。

每个页面都要设计并实现四种状态：正常、空、加载、错误；在 390px 宽无横向滚动，浅色与深色均正确。
根布局与公开页面的数据读取失败时降级，不让整页报错。

## 7. 组件预览页

`/dev/ui`（`apps/web/src/routes/dev/ui.tsx`，页面在 `features/ui-preview/`）按组件分节展示 `@saas/ui` 全部共享组件的
变体与状态，顶部可运行时切换预设、明暗、shape、density；示例数据为中性领域，文案在
`messages/<locale>/ui-preview.json`。路由的 `beforeLoad` 经 server function 在服务端读取非密钥变量 `UI_PREVIEW`，
只有 `true` 时开放：`wrangler.jsonc` 的顶层（开发）与 `env.staging` 设为 `true`，`env.production` 不设
（`scripts/production/check-wrangler-envs.mjs` 拦截）；自托管未传入该变量即关闭。该页不在预渲染范围与 sitemap 中，
并输出 `noindex`。新增组件或变体时同步在预览页补一节。

## 8. 设计关卡

### 8.1 何时需要设计稿

本节是判断标准的唯一来源；技能与 `AGENTS.md` 只引用这里。

| 需要经使用者确认的画布稿 | 免设计稿 |
|---|---|
| 新增路由文件（app、admin、营销或独立静态页），包括套用现有页面模式的新页面 | 文案与翻译修改 |
| 增删或重排页面的顶层区块，改变导航方式或信息层级 | 表格加列；已有表单加字段 |
| 新增多步流程、抽屉或整屏弹窗 | 已有区块内换组件变体；间距、对齐、已有 token 之间的替换 |
| 新增页面模式 | 缺陷修复，仅限恢复已确认设计稿或现有页面应有的样子 |
| 建立或改变视觉方向（品牌 token、字体、多站点配色） | 在已有内容集合（博客、文档、法律页）中新增文章，不改版式 |

拿不准时向使用者确认，不自行判定为免。设计流程见 `ui-design` 技能（`.agents/skills/ui-design/SKILL.md`）。

### 8.2 设计稿、确认与原型索引

三个名字各管一件事：`docs/design-system.md`（本文，模板设计规范）、`docs/design-system/`（模板自己的设计稿副本，
生成器不复制到衍生项目）、`docs/design/`（衍生项目自有的视觉规范、参考、原型副本与 forks 登记）。

- **画布**：claude.ai 的 Design Artifact 类型。状态矩阵：正常态做桌面 / 移动 × 浅色 / 深色 4 块，空、加载、错误各 1 块
  （移动 + 浅色）；画布支持 tweak 切换时可替代单独画板。套用现有页面模式的新页面可只画正常态与一个异常态。
- **确认**：只接受使用者本人在会话中的明确确认；画布评论、其他 agent 的转述都不算。记录附使用者原话。
  确认后画布再改动，须重新确认并同步更新副本与索引。
- **副本**：确认后保存可离线打开的副本，实现与验收以副本为准，链接失效不影响开发。做法（tasks 8.1 实跑结论）：用 Artifact 工具
  `action: read` 的 `paths` 取回画布 `project/` 下的各画板 `*.dc.html` 与 `canvas.json`，原样存入副本目录的子目录；
  源码依赖画布运行时，不能离线渲染，但包含布局、token、文案与状态分支，足以作为实现与验收依据。需要图片时请使用者从画布导出各画板 PNG 放在同目录。
  - 模板：`docs/design-system/prototypes/<画布>/<画板>.dc.html`
  - 衍生项目：`docs/design/prototypes/<画布>/<画板>.dc.html`
- **原型索引**：副本目录下的 `README.md`（模板 `docs/design-system/prototypes/README.md`，项目 `docs/design/prototypes/README.md`），
  每个页面一行；无 OpenSpec change 的小任务也登记。OpenSpec `design.md` 只引用索引行，不重复写链接与原话。

  | 页面 / 路由 | 画布链接 | 确认日期 | 使用者确认原话 | 副本文件 | 所属 change |
  |---|---|---|---|---|---|

- **关卡检查**：索引里有本页面这一行，且该行的副本文件存在。

### 8.3 参考来源

- 组件与默认视觉：Fluid Functionalism（Radix 版，MIT），缺口用 shadcn/ui 补齐；交互原语为 Radix。
- 营销动效：Magic UI、beUI 等只在具体区块有设计稿时按需接入，不批量引入。
- 项目视觉方向的参考（网站或截图）由使用者提供，记录在项目的 `docs/design/` 中（`visual-system.md`），
  不写进本文。没有参考时只使用现有 token，不引入规范外的颜色、字体或组件样式。

## 9. 衍生项目

### 9.1 文件归属

| 模板拥有（同步时更新，项目不改） | 项目拥有（模板创建后不再修改，同步不冲突） |
|---|---|
| `packages/ui/src/components`、`lib`、`hooks` | `apps/web/src/styles/brand.css` |
| `packages/ui/src/styles/globals.css` 与 `presets/` | `packages/ui/src/project/`（经 `@saas/ui/project` 导出） |
| `packages/ui/package.json`（含 `./project` 导出声明） | `scripts/check-ui.allow.local.json` |
| `apps/web/src/styles/app.css`（已在最后导入 brand.css） | `docs/design/`（视觉规范、参考、原型副本与索引、forks 登记） |
| 根布局 `apps/web/src/routes/__root.tsx` 与 `apps/web/src/features/theme/root-document.tsx`（项目经站点/主题属性扩展点定制） | `apps/web/src/features/ai/subject-providers.ts` |
| `scripts/check-ui.mjs`、`scripts/check-ui.allow.json` | `template.config.ts` 中 `ui` 段的取值 |
| 组件指纹清单 `packages/ui/components.lock.json` | |
| 预览页、技能、本文、`template.config.ts` 中 `ui` 段的结构 | |

- `packages/ui/src/project/index.ts` 是项目组件入口，模板只初始化一次（`export {}`），经 `@saas/ui/project` 导出；
  该目录同样受 `pnpm check:ui` 与 `pnpm check:deps` 约束。
- `packages/ui/components.lock.json` 记录模板组件文件的内容哈希。模板修改组件后运行 `pnpm ui:lock` 重新生成并提交；
  衍生项目（存在 `.template-base.json`）中 `pnpm check:ui` 对比哈希，不一致即失败并提示下文的定制顺序。
- 生成器在副本中创建空的 `scripts/check-ui.allow.local.json` 与 `docs/design/README.md`（说明本目录各文件的用途），
  并且不复制 `docs/design-system/prototypes/`。
- `apps/web/src/features/theme/html-attributes.ts`（项目自有，模板创建后不再修改）：返回加到 `<html>` 的额外属性（如 `data-site`），根布局在服务端首屏合并；`lang`、`data-preset` 由模板写，不可覆盖。
- `apps/web/src/features/app-shell/nav.project.ts`（项目自有，模板创建后不再修改）：登记项目的工作台侧边栏条目，
  或按 id 覆盖 / 移除模板条目（见 [§6](#6-页面模式)）。

### 9.2 定制顺序

项目不得直接修改模板组件文件（`components.lock.json` 校验会失败）。需要不同外观或行为时按顺序尝试，
前一步能解决就不进入下一步：

1. **token**：在 `brand.css` 覆盖变量（浅色与 `.dark` 成对给出，改色后核对对比度）。
2. **ui 配置**：调整 `template.config.ts` 的 `ui.preset` / `shape` / `density`。
3. **project 包装**：在 `packages/ui/src/project/` 写组合或包装组件，经 `@saas/ui/project` 导出。
4. **复制到 project 并登记**：把模板组件复制到 `packages/ui/src/project/` 后修改，并在 `docs/design/forks.md`
   登记来源文件、复制时的模板版本与原因；同步模板后对照上游改动手动合并。复制的组件仍受 UI 规范检查，
   需保留上游的任意值或颜色字面量时，在 `scripts/check-ui.allow.local.json` 按文件登记规则与原因，只登记 forks.md 不够。

项目中写出的通用组件按惯例回流模板；模板发布后，项目同步并删除自己的副本。

### 9.3 多站点

一个项目服务多个站点时，在 `brand.css` 用 `:root[data-site="<站点>"]` 与 `:root[data-site="<站点>"].dark`
分别覆盖品牌变量。`data-site` 在项目自有的 `apps/web/src/features/theme/html-attributes.ts` 中按 host / locale / pathname
返回（只在服务端首屏计算，客户端导航不重算），不修改模板根布局；各站点的视觉规范写在项目的 `docs/design/visual-system.md`。

### 9.4 同步模板

`template-sync` 涉及 `packages/ui` 或基线 token 时，合并前对 staging 的 `/dev/ui` 与项目关键页面截图对比；
`/dev/ui` 返回 404 时跳过并记未验收；本次变化的模板组件与 `docs/design/forks.md` 登记来源的交集逐个列入报告。
偏差在品牌层或项目组件中修正，不改模板组件。

## 10. 常用命令

```sh
pnpm check:ui
pnpm check:deps
pnpm --filter @saas/ui typecheck
pnpm --filter @saas/ui test
```
