## ADDED Requirements

### Requirement: 中性填充与品牌强调色分离
共享组件中表达「中性」的填充（如灰色实心徽标）SHALL 使用专门的中性填充 token，MUST NOT 使用品牌层可改写的强调色 token；中性填充上的文字与底色对比度 SHALL 不低于 4.5:1。

#### Scenario: 品牌层改写强调色
- **WHEN** 衍生项目在 `brand.css` 把 `--accent` 设为品牌主色
- **THEN** 灰色实心 Badge 的底色仍为中性填充，文字对比度不变

#### Scenario: 默认主题外观不变
- **WHEN** 模板使用默认主题渲染灰色实心 Badge
- **THEN** 底色与改动前相同

### Requirement: 选择框不撑开所在列
Select 触发器及其外层包装 SHALL 允许收缩到所在列宽度以内，长选项文字 SHALL 截断而不撑开 grid 或 flex 列。

#### Scenario: 窄列中的长选项
- **WHEN** 表单列宽小于选中项文字宽度
- **THEN** 触发器不超出列宽，文字截断显示
