## ADDED Requirements

### Requirement: KV 写入临时错误重试
Cloudflare 目标的 KV 写入与删除遇到网络连接中断或平台内部错误时 SHALL 以带抖动的指数退避重试，最多 3 次；同键写入过快（429）时 SHALL 按平台文档建议以不短于 1 秒起始的指数退避单独重试，最多 2 次，两类分别计数；参数错误 MUST NOT 重试。重试耗尽时 SHALL 返回 `CACHE_UNAVAILABLE`（503）。Node 目标的共享缓存 SHALL 保持快速失败，不增加重试。

#### Scenario: KV 网络中断后成功
- **WHEN** 会话写入 KV 时第一次遇到网络连接中断，第二次成功
- **THEN** 登录请求成功

#### Scenario: 同键写入过快后成功
- **WHEN** 同一键 1 秒内第二次写入返回 429，约 1 秒后重试成功
- **THEN** 写入成功

#### Scenario: 同键限流持续
- **WHEN** 同一键的写入连续返回 429
- **THEN** 最多重试 2 次后返回 `CACHE_UNAVAILABLE`
