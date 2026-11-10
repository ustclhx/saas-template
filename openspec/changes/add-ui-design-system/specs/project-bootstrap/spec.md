# Spec Delta

## ADDED Requirements

### Requirement: 主题预设选择
生成器 SHALL 接受 `--theme <预设名>`，省略时使用中性基线；非法预设名 MUST 被拒绝并列出可用预设。所选预设 SHALL 写入生成项目的模板配置与基准记录参数，生成项目 SHALL 包含项目自有的品牌 token 文件，供后续调整品牌而不修改基线 token。

#### Scenario: 指定主题预设
- **WHEN** 使用者以 `--theme blue` 生成项目
- **THEN** 生成项目的模板配置选择 blue 预设，`.template-base.json` 记录该参数，项目包含品牌 token 文件且能通过类型检查与单元测试

#### Scenario: 非法预设
- **WHEN** 使用者传入不存在的预设名
- **THEN** 生成器退出并列出可用预设，不写入输出目录
