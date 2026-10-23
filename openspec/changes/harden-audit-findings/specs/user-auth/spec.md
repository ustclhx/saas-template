# Spec Delta

## MODIFIED Requirements

### Requirement: 认证入口防刷
注册、登录、发送验证码、找回密码 SHALL 在启用 Turnstile 时校验其令牌，并 SHALL 按 IP 与邮箱维度限流；校验验证码、用验证码验证邮箱、用验证码或令牌重置密码的接口 SHALL 同样按 IP 与邮箱维度限流（不要求 Turnstile）。超过限流时 MUST 返回 429 且不执行发送邮件、校验验证码等副作用。应用未使用的验证码独立校验接口 MUST 被禁用。同一验证码的错误尝试次数上限 MUST 在并发请求下仍然有效。

#### Scenario: Turnstile 令牌缺失
- **WHEN** 启用 Turnstile 时，注册请求不带令牌或令牌无效
- **THEN** 请求被拒绝，不创建用户

#### Scenario: 频繁发送验证码
- **WHEN** 同一邮箱在短时间内连续请求发送验证码超过限额
- **THEN** 后续请求返回 429，不再发送邮件

#### Scenario: 并发爆破重置验证码
- **WHEN** 攻击者为受害者邮箱触发找回密码后，从多个 IP 并发提交大量错误验证码
- **THEN** 超过限流的请求返回 429，累计有效尝试不超过验证码的尝试上限，验证码随后失效

#### Scenario: 独立校验接口已禁用
- **WHEN** 请求 `/api/auth/email-otp/check-verification-otp`
- **THEN** 返回 404，不读取或修改验证码
