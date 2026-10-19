# Tasks

## 1. 实现

- [x] 1.1 `createChatStream` 静默满间隔发出 keepalive 片段，真实输出重置计时，结束/失败/取消清理定时器；UI 流序列化为 transient `data-keepalive`。
- [x] 1.2 OpenAI 兼容流把 keepalive 写成 SSE 注释 `: keepalive`，提取 `completionEventStream`。

## 2. 验证与文档

- [x] 2.1 fake timers 单元测试：隐藏 reasoning 超过间隔产生心跳、真实输出重置、结束/取消/失败后无残留定时器、首片段先于上游 token、官方 OpenAI SDK 解析含注释的流。
- [x] 2.2 文档注明 Cloudflare 约 100 秒边缘读超时与心跳行为（`docs/06-ai.md`、`docs/runbooks/selfhost-proxy.md`）。
- [ ] 2.3 staging >100 秒实测（S1′：direct 出口、专用 `heartbeat-test` 隐藏 reasoning）：2026-10-20 配置预检确认 `x-text.thinking=true` 仅声明支持能力，不能覆盖模板 `thinking.default=off` / `userToggle=false`；现有后台无法只为该模型开启 thinking，按验收约束停止，不改代码绕过。隐藏 reasoning 已支持；未创建模型、修改套餐或发送收费请求，只读核对专用模型及套餐授权均不存在。尚无真实流式样本，不能认证心跳通过或定位超时链路。证据见 `saas-template-evidence:staging-acceptance/2026-10-19/stream-heartbeat/followup-2026-10-20.md`，原准备记录保留在同目录；通过实测后再勾选。
