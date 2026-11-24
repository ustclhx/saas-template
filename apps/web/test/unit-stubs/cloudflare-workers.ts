// 单元测试（Node 环境）中 `cloudflare:workers` 的替身（`cloudflare:email` 见同目录）。
// 启用 agents 插件后，env.ts / server.ts 经 plugins.worker.gen.ts 导入插件 Worker 入口，
// 进而导入 agents SDK；SDK 在模块顶层继承这些类。Node 无法加载 `cloudflare:` 协议，
// 单元测试只需要模块能加载，不实例化 Durable Object。集成测试在 workerd 中运行，不使用本文件。
export class DurableObject {}
export class RpcTarget {}
export class WorkerEntrypoint {}
export class WorkflowEntrypoint {}
export const env = {}
export const exports = {}
export default { DurableObject, RpcTarget, WorkerEntrypoint, WorkflowEntrypoint, env, exports }
