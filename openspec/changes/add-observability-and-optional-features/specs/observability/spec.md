# Spec Delta

## Purpose

让运营者能发现并定位线上问题（错误、慢请求、异常业务事件），同时保证采集的数据不泄露密钥与用户隐私。

## ADDED Requirements

### Requirement: 错误上报
Web 与后台 Worker 中未处理的异常 SHALL 上报到错误追踪服务，并附带部署版本、请求 ID、空间 ID 与用户 ID（不含邮箱等个人信息），堆栈 SHALL 能映射回源码。

#### Scenario: 接口抛出未处理异常
- **WHEN** 某接口抛出未处理异常
- **THEN** 错误追踪中出现一条带版本、请求 ID 与可读源码堆栈的事件

### Requirement: 结构化日志
每个请求与后台任务 SHALL 输出 JSON 格式日志，包含请求 ID、空间 ID、用户 ID、路由或任务名、耗时与结果；同一请求触发的后台消息 SHALL 携带同一请求 ID。

#### Scenario: 追踪一次结账
- **WHEN** 运营者按请求 ID 检索日志
- **THEN** 能看到该结账请求以及由它投递的后续队列消息的日志

### Requirement: 敏感信息脱敏
日志与错误上报 MUST NOT 包含密钥、密码、令牌、完整的支付信息或 AI 对话内容。

#### Scenario: 携带令牌的请求出错
- **WHEN** 带有 Authorization 头的请求出错
- **THEN** 上报事件中该头部已被移除或打码

### Requirement: 流量统计
公开页面 SHALL 接入不使用 Cookie 的流量统计；产品分析 SHALL 默认关闭，只有在模板配置中显式开启时才加载对应脚本。

#### Scenario: 默认配置
- **WHEN** 站点使用默认配置
- **THEN** 页面只加载无 Cookie 的流量统计，不加载产品分析脚本
