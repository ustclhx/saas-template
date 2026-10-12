# Storage 接口与 C 交接

业务从 `@saas/storage` 导入文件函数、`Storage` 和 `MediaOutputCopier`。中立入口不加载 Workers 模块，也不需要 Workers 全局类型。Cloudflare composition root 从 `@saas/storage/cloudflare` 导入两个工厂，每个请求或事件显式装配，再向业务注入。

```ts
const storage = createCloudflareStorage(env)
const copyOutput = createCloudflareMediaCopier(env.FILES)
await declareUpload(db, storage, input)
await persistMediaOutputs({ db, storage, copyOutput, task, result, limits })
```

`Storage` 提供四项操作：

- `head(key)` 返回 `{ size, mime }` 或 `null`；缺少 Content-Type 时 `mime` 为 `null`，上传确认按不匹配拒绝。
- `delete(key)` 幂等删除单个对象；失败必须传播，以保留数据库重试线索。
- `presignUpload(key, mime)` 返回 `{ uploadUrl, headers, expiresIn }`；Cloudflare 保留十分钟 PUT、签入 Content-Type 与 If-None-Match，已确认文件不可覆盖。
- `presignDownload(key, attachment?)` 返回 URL；Cloudflare 保留五分钟 GET，显式下载的 attachment 响应头参与签名。

`MediaOutputCopier(key, output, limits)` 返回实际存储的 `{ mime, size }`。C 的 adapter 负责禁重定向的 HTTPS 域名白名单下载、响应 MIME 匹配、实际字节限额和流释放，不能仅信任 Content-Length。对象写入失败应拒绝；`persistMediaOutputs` 负责 pending 记录、空间锁、最终配额确认、重放幂等与失败清理。Cloudflare copier 保留 FixedLengthStream 长度检查、未知长度的 5 MiB multipart 与 abort 清理。

`cleanupFiles` 仅要求 `Pick<Storage, 'delete'>`，原 R2 bucket 也结构兼容。分享 token 的授权、撤销和租户校验仍由业务函数执行。

Node 在 C 交付之前不装配存储或媒体复制能力，调用方在数据库写入/积分预扣前通过平台能力表明确拒绝。这里没有 S3 后端或假成功实现。`test/node-contracts.ts` 是无 Workers 声明的接入类型夹具；真实 S3/Node 媒体验收属于 C。

验证：`pnpm --filter @saas/storage typecheck` 与 `pnpm --filter @saas/storage test`。前者分别检查中立、Cloudflare、CF 测试和 Node 夹具；后者保留签名、文件/媒体 CF 集成，并在真实 Node 子进程加载 package 中立 export。集成需要本 worktree 或 CI 隔离数据库配置。
