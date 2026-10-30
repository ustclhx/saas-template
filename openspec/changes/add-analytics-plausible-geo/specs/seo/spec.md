# Spec Delta

## ADDED Requirements

### Requirement: llms.txt
启用营销站时站点 SHALL 提供 `/llms.txt`，列出站点名称与公开、已发布页面，地址 MUST 属于当前环境 APP_URL。

#### Scenario: 读取 llms.txt
- **WHEN** 请求 `/llms.txt`
- **THEN** 返回 200 的纯文本，其中的链接都指向本站

#### Scenario: 不含私有路径
- **WHEN** 读取 `/llms.txt`
- **THEN** 不包含 `/app`、`/admin` 与 `/api`

### Requirement: IndexNow 提交
配置 IndexNow 密钥后，站点 SHALL 在 `/indexnow.txt` 公开该密钥，生产发布后 SHALL 提交站点地图中的本站地址；提交失败 MUST NOT 使发布失败。未配置时 `/indexnow.txt` MUST 返回 404，MUST NOT 提交。密钥 MUST NOT 写入仓库。

#### Scenario: 未配置密钥
- **WHEN** 没有配置 `INDEXNOW_KEY`
- **THEN** `/indexnow.txt` 返回 404，发布步骤跳过提交

#### Scenario: 提交失败
- **WHEN** IndexNow 服务返回错误
- **THEN** 记录警告，发布继续
