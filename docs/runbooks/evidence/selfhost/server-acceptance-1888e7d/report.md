# 新加坡服务器验收：1888e7d

本次使用获授权的 `product-res-ecs`、`selfhost.ezarouter.cc` 与三个 selfhost 专用 R2 桶。
正式发布 SHA 为 `1888e7d165b0b87784e7d16a4c39709a9bc063e3`，来源是
[selfhost-publish 38924583361](https://github.com/ustclhx/saas-template/actions/runs/38924583361)。
分支已基于包含 #237 的 main；服务器只消费该 run 的原始 release bundle 和固定 digest，未构建业务镜像。

| 分配项 | 本批结果 | 证据 |
| --- | --- | --- |
| foundation 7.4 | 通过：真实受信 ACME 签发；同正式 Caddy 镜像、独立 staging 状态实际续期；恢复原入口后证书指纹一致 | [签发及 health](deploy-acme.json)、[续期](acme-renewal.json)；既有自带证书/XFF 证据见 selfhost-a7 runbook |
| storage-observability 1.7 | 通过：真实 R2 业务/SDK、条件上传、短期附件下载、配额与授权、清理重试、未知长度 multipart copier | [业务及 SDK](storage.json) |
| storage-observability 1.7 浏览器 | 通过：真实 Chromium 从应用 origin 发起 OPTIONS/PUT/GET/HEAD，响应头可见，未授权 origin 被拒 | [浏览器](browser.json) |
| R2 token 隔离 | 三个独立 bucket-scoped object read/write token 各自本桶成功、六次跨桶访问均 403 | [权限矩阵](permissions.json) |
| delivery 7.1、7.2、7.3；job-engine 6.4 | 正式部署已成功；长时任务、资源预算、主/仅副本 PITR 与真实整机 reboot 继续验收，未提前勾选 | 后续批次追加 |
| foundation 9.4、delivery 7.4 | 完整矩阵与协调者签收待后续批次 | 未提前勾选 |

存储夹具通过实际 auth handler 创建合成测试身份及有效会话，公网认证保护未改变。
实际对象的匿名请求返回 R2 的 `400 InvalidArgument`，未返回对象内容；允许 origin 的预检是 204。
不把本地兼容端点的特定状态码套用到 R2。测试过程中修正了夹具的带凭据跨源请求和预检状态码预期，最终实际浏览器链路通过。

范围遵守已合并的 R2 用户决定：主备份与副本位于同一 Cloudflare 账号、不同桶、不同受限 token，
失去供应商独立性，存在账号级共同故障风险。未宣称第二供应商或独立账号容灾。
本次不验收真实邮件、OAuth/Turnstile 凭据、支付、AI 调用或首管理员；这些集成尚未配置。
生产 Cloudflare 与 staging 未修改；既有其他服务的容器、数据、卷及镜像均保留。

本批本地验证：`pnpm check`（既有 4 条 warning）、`pnpm typecheck`（14/14，缓存命中）、
备份 Python 单测 24 项及 foundation/storage-observability 的 OpenSpec strict validate 通过。
证据只保留状态、时间、版本、证书公开元数据与固定测试结果，不包含凭据、连接串、会话或预签名 URL。
