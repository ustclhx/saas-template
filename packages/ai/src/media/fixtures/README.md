# fal.ai 夹具来源

**待替换为录制**：`fal.documented.json` 全部依据下列官方文档构造，不能作为 3.2 的真实联通验收证据。

- [Queue](https://fal.ai/docs/documentation/model-apis/inference/queue)：提交、三种状态、失败状态与取消响应。
- [Webhooks](https://fal.ai/docs/documentation/model-apis/inference/webhooks)：OK / ERROR / payload_error、gateway_request_id 与验签。
- [FLUX schnell](https://fal.ai/models/fal-ai/flux/schnell/api)、[Wan turbo](https://fal.ai/models/fal-ai/wan/v2.2-a14b/text-to-video/turbo/api)：图片及视频输出。

测试生成临时 Ed25519 密钥与签名，验证协议、原始请求体完整性与公钥缓存；不声称这些签名来自 fal。真实录制时替换提交、状态、结果、取消和回调，记录日期、模型、HTTP 状态与取得方式，删除密钥、账号 ID、输入隐私与带 token 的地址。删除账号 ID 或修改原始请求体会使真实签名失效，应将脱敏 payload 测试与使用临时密钥重新签名的协议测试分开。

`fal.jwks.recorded.json` 是 2026-10-09 从公开 JWKS 端点真实录制的公钥响应（无需 API key，不含账号信息），用于覆盖实际公钥编码并拒绝本地临时签名；它不替代真实生成响应和回调录制，也不用于线上信任根。实际响应的 `x` 是带 `=` 填充的 Base64url，解析同时接受 JWK 常见的无填充格式。

缺少 FAL_KEY 时保留 3.2 未勾选。拿到凭据后仅跑最便宜图片模型，视频仅提交并立即取消；若录制回调需要公网地址，先在 Orca 卡片询问协调者，不自行部署回调入口。
