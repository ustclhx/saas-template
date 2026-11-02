# Spec Delta

## ADDED Requirements

### Requirement: 分析站点注入
生成器 SHALL 接受 `--analytics plausible|off`（默认 `plausible`）、`--plausible-domain`（默认项目名）与 `--plausible-host`。生产 site MUST 为该值，staging MUST 加 `-staging` 后缀。清单 MUST 写明 site、目标、自定义属性的开通步骤和开关方式。

#### Scenario: 新词站默认
- **WHEN** 以 `--name acme --plausible-host https://p.example` 生成
- **THEN** 生产 site 为 `acme`，staging 为 `acme-staging`

#### Scenario: 长期词站关闭
- **WHEN** 以 `--analytics off` 生成
- **THEN** `features.analytics` 为 `false`，环境变量为空，清单不含 Plausible 步骤

### Requirement: staging 地址不沿用生产域名
生成器 MUST NOT 把生产域名写入 staging 的 APP_URL，默认 SHALL 写入 `https://staging.<域名>` 并由清单提示替换。

#### Scenario: 生成后的 staging 地址
- **WHEN** 以 `--domain acme.example` 生成
- **THEN** staging 的 APP_URL 为 `https://staging.acme.example`，生产为 `https://acme.example`

### Requirement: 搜索站长验证清单
`PROJECT_SETUP.md` SHALL 写明 Google Search Console 与 Bing Webmaster 的站点验证和提交 sitemap 步骤，以及发布前替换法律页模板声明与支持邮箱的提示。

#### Scenario: 读取清单
- **WHEN** 打开生成的 `PROJECT_SETUP.md`
- **THEN** 其中包含这两个平台的步骤和本站 sitemap 地址

### Requirement: 可选答案页
生成器 SHALL 接受 `--features guides` 开启答案页，默认关闭；开启时副本 MUST 包含可修改的示例页。

#### Scenario: 开启答案页
- **WHEN** 以 `--features blog,guides` 生成
- **THEN** `features.guides` 为 `true`，副本含示例内容
