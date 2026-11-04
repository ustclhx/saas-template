## MODIFIED Requirements

### Requirement: 分析脚本归属门禁
门禁 SHALL 校验页面中的分析脚本 site 与实例地址等于当前环境配置；配置了站点映射时，期望的 site 按被检查地址的访问域名在映射中查找，未登记时取环境默认 site。期望的 site 为空时页面 MUST NOT 出现分析脚本或站点映射。

#### Scenario: 生产脚本进入 staging
- **WHEN** staging 页面注入了生产 site 的脚本
- **THEN** 门禁失败

#### Scenario: 多站页面带了他站映射
- **WHEN** 检查 `https://arcanumber.com/`，页面给出的站点映射把 `arcanumber.com` 指向 `ganjiday.com`
- **THEN** 门禁失败

### Requirement: 静态配置检查
`pnpm check` SHALL 拒绝 staging 与生产共用 `APP_URL`、`PLAUSIBLE_DOMAIN` 或站点映射中任一 site 的配置，并拒绝同一环境的 web 与 jobs 站点变量（含站点映射）不一致的配置，以及无法解析的站点映射。

#### Scenario: staging 复用生产域名
- **WHEN** `env.staging.vars.APP_URL` 等于 `env.production.vars.APP_URL`
- **THEN** 检查失败

#### Scenario: staging 映射到生产 site
- **WHEN** staging 的站点映射中有一个 site 与生产的映射或默认 site 相同
- **THEN** 检查失败

#### Scenario: 映射格式错误
- **WHEN** 站点映射中某一项缺少 `=` 或域名为空
- **THEN** 检查失败
