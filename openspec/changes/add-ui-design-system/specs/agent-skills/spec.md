# Spec Delta

## MODIFIED Requirements

### Requirement: 双目录技能入口
系统 SHALL 提供 quick-start、deploy-cloudflare、deploy-selfhost、new-page、new-module、new-static-page、add-ai-model、security-scan、template-sync、ui-design；每个技能 SHALL 有 name/description 和可执行步骤、真实命令、验收条件、常见故障，两处目录内容 MUST 完全一致。

#### Scenario: 两种 agent 使用同一技能
- **WHEN** 使用者分别读取 `.agents/skills` 与 `.claude/skills` 下同名技能
- **THEN** 获得逐字节一致的指导，且引用能在项目中解析

## ADDED Requirements

### Requirement: 页面开发前的设计关卡
新增页面或较大布局改动 SHALL 先由 ui-design 技能基于设计规范与使用者提供的参考产出设计稿，覆盖桌面与移动、浅色与深色、空、加载与错误状态，并取得使用者对该设计稿的明确确认后才开始实现。文案、小样式调整与缺陷修复 SHALL 免于此关卡。页面技能 MUST 在开发前检查已确认设计稿的链接。

#### Scenario: 未确认设计稿就要求开发新页面
- **WHEN** 使用者调用 new-page 新增页面，但没有已确认的设计稿
- **THEN** 技能先进入 ui-design 产出设计稿并请求确认，不创建路由或组件文件

#### Scenario: 修改按钮文案
- **WHEN** 使用者只要求修改现有页面的按钮文案
- **THEN** 技能直接修改，不要求设计稿

### Requirement: 设计参考优先于自由发挥
ui-design 技能 SHALL 在建立新的视觉方向前向使用者索取参考（网站或截图），并把采用的参考记录进设计规范；没有参考时 SHALL 只使用现有设计规范，MUST NOT 引入规范外的颜色、字体或组件样式。实现 SHALL 只使用共享组件包与设计 token，缺少组件时先补充组件再实现页面。

#### Scenario: 设计稿需要规范外的颜色
- **WHEN** 设计过程中需要现有 token 之外的颜色
- **THEN** 技能提出 token 变更并等待使用者确认，不在页面中写死颜色

### Requirement: 设计稿副本留存
经确认的设计稿 SHALL 以可离线打开的副本保存在项目的设计目录中，并与原链接一同写入该需求的规划文档；实现与验收 SHALL 以副本为准，链接失效时 MUST NOT 影响开发。

#### Scenario: 设计稿链接不可访问
- **WHEN** 并行 worker 无法打开设计稿链接
- **THEN** worker 读取仓库中的设计稿副本继续实现

### Requirement: 衍生项目视觉方向与同步回归
ui-design 技能 SHALL 支持衍生项目基于模板基线建立项目视觉方向，产出项目品牌 token 与视觉规范文档，可包含多站点配色。template-sync 技能在同步涉及共享组件或基线 token 时 SHALL 在合并前对组件预览页与项目关键页面截图对比，偏差 SHALL 通过 token 或项目组件修正，MUST NOT 修改模板组件。

#### Scenario: 模板升级改变按钮圆角
- **WHEN** 同步分支中的模板更新导致项目按钮圆角与项目视觉规范不符
- **THEN** 同步报告列出截图差异，修正写入项目品牌 token 或项目组件，模板组件文件保持不变

#### Scenario: 新项目建立视觉方向
- **WHEN** 使用者为一个新衍生项目提供两个参考网站
- **THEN** 技能在模板基线上产出项目品牌 token、视觉规范文档与设计系统镜像，经确认后写入项目自有文件
