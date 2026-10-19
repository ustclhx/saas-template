# Tasks

## 1. 实现

- [x] 1.1 `createChatStream` 静默满间隔发出 keepalive 片段，真实输出重置计时，结束/失败/取消清理定时器；UI 流序列化为 transient `data-keepalive`。
- [x] 1.2 OpenAI 兼容流把 keepalive 写成 SSE 注释 `: keepalive`，提取 `completionEventStream`。

## 2. 验证与文档

- [x] 2.1 fake timers 单元测试：隐藏 reasoning 超过间隔产生心跳、真实输出重置、结束/取消/失败后无残留定时器、首片段先于上游 token、官方 OpenAI SDK 解析含注释的流。
- [x] 2.2 文档注明 Cloudflare 约 100 秒边缘读超时与心跳行为（`docs/06-ai.md`、`docs/runbooks/selfhost-proxy.md`）。
- [x] 2.3 >100 秒原生传输验收（经批准以临时探针替代 staging 真实推理样本）：2026-10-20 部署无绑定 `idle-probe-tmp`，对立即发头后静默 130 秒、每 25 秒 SSE 心跳、130 秒后才发头三个接口各取得两次有效样本，均 HTTP 200、无 524 或重置；心跳按期到达，但无心跳与延迟响应头同样成功，因此在该原生 Worker 自生成响应路径下属于附加保险，不能声称为避免 100 秒截止所必需。固定等待探针直接隔离下游空闲边界，不依赖模型思考时长；不认证真实 Provider、Gateway 或应用结算。未操作 staging 或模型；临时 Worker 已删除，并以只读 API 404/10007 确认不存在。含网络路径、逐字节时间线、初次 1042 路由异常及补跑的证据见 `saas-template-evidence:staging-acceptance/2026-10-19/stream-heartbeat/idle-probe-2026-10-20.md`。
