## MODIFIED Requirements

### Requirement: 一站一 Plausible site
每个环境 SHALL 使用自己的 Plausible site 与实例地址，由环境配置决定。一个部署按访问域名服务多个站点时，SHALL 能为每个访问域名配置各自的 site：页面事件按当前访问域名选择，未登记的域名退回环境默认 site，没有默认 site 时不统计。站点或实例未配置时 MUST NOT 注入脚本或发送服务端事件，首触归因仍 MUST 写库。

#### Scenario: staging 使用自己的 site
- **WHEN** staging 配置 `acme-staging`，生产配置 `acme`
- **THEN** staging 页面只注入 `acme-staging` 的脚本

#### Scenario: 未配置
- **WHEN** `PLAUSIBLE_DOMAIN` 为空且没有站点映射
- **THEN** 页面没有 Plausible 脚本

#### Scenario: 多站按访问域名上报
- **WHEN** 生产映射 `ganjiday.com` → `ganjiday.com`、`arcanumber.com` → `arcanumber.com`，访客打开 `https://arcanumber.com/` 的预渲染首页
- **THEN** 该页的页面事件只上报到 site `arcanumber.com`

#### Scenario: 未登记的访问域名
- **WHEN** 配置了站点映射但 `PLAUSIBLE_DOMAIN` 为空，访客经 workers.dev 预览地址访问
- **THEN** 页面不加载 Plausible 脚本，也不发送页面事件

#### Scenario: 单站项目不受影响
- **WHEN** 只配置 `PLAUSIBLE_DOMAIN=acme`，没有站点映射
- **THEN** 任何访问域名的页面都上报到 `acme`，行为与引入映射前一致

## ADDED Requirements

### Requirement: 服务端事件的站点归属
配置了站点映射时，`sign_up` SHALL 上报到注册请求访问域名对应的 site，付款事件 SHALL 上报到付款归属用户注册时访问域名对应的 site。事件 URL SHALL 使用该访问域名。注册域名未登记或没有记录时退回环境默认 site，没有默认 site 时 MUST NOT 发送，付款真相仍在数据库。

#### Scenario: 在西方站注册
- **WHEN** 用户经 `arcanumber.com` 完成注册
- **THEN** `sign_up` 上报到 site `arcanumber.com`，事件 URL 的主机名为 `arcanumber.com`

#### Scenario: 东方站用户付款
- **WHEN** 经 `ganjiday.com` 注册的用户完成一笔付款
- **THEN** `payment_success` 上报到 site `ganjiday.com`

#### Scenario: 注册域名缺失且无默认 site
- **WHEN** 付款归属用户没有注册域名记录，且 `PLAUSIBLE_DOMAIN` 为空
- **THEN** 不发送 `payment_success`，付款记录不受影响
