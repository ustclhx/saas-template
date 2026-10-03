# runtime-config Specification

## Purpose

定义模板配置、运行时设置与环境变量如何加载和校验，以及三者各管各的内容、互不覆盖的规则，确保配置错误在启动时暴露而不是在线上请求中暴露。

## Requirements

### Requirement: 环境变量启动校验
`apps/web` 与 `apps/jobs` 在处理第一个请求或事件之前 SHALL 按 schema 校验所需的环境变量与绑定；任一必需项缺失或格式非法时 MUST 拒绝服务并报告缺失项名称，且 MUST NOT 在错误信息中输出密钥的值。

#### Scenario: 缺少必需项
- **WHEN** 部署的 Worker 缺少必需的 `HYPERDRIVE` 绑定
- **THEN** 任何请求都返回 5xx，日志中列出缺失项名称 `HYPERDRIVE`，且不包含任何密钥或连接串的值

#### Scenario: 配置齐全
- **WHEN** 所有必需的环境变量与绑定都存在且格式合法
- **THEN** Worker 正常处理请求

### Requirement: 模板配置类型化默认值
模板配置（`template.config.ts`）SHALL 对每个未显式设置的选项提供默认值，并 MUST 在构建期对非法取值（如未知的登录方式或计费方式）报类型错误。

#### Scenario: 省略可选项
- **WHEN** 模板配置中省略 `billing.overage`
- **THEN** 运行时读取到文档约定的默认额度

#### Scenario: 非法取值
- **WHEN** 模板配置把 `ai.defaultPricingMode.video` 设为未定义的计费方式
- **THEN** 类型检查失败，构建不能通过

### Requirement: 运行时设置回退到代码默认值
运行时设置（`setting` 表）中缺少某一项时，系统 SHALL 使用代码中为该项定义的默认值，MUST NOT 去读取环境变量或模板配置作为替代。

#### Scenario: 设置项不存在
- **WHEN** `setting` 表中没有「注册开关」这一项
- **THEN** 系统使用代码默认值（允许注册），行为与该项显式设为默认值时一致
