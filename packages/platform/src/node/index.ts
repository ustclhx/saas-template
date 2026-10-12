import type {
  Capability,
  JsonValue,
  QueueProducer,
  Scheduler,
  TaskHealth,
  TransactionalEnqueue,
  Workflow,
} from '../index.ts'

/** B 装配前只有显式缺失状态；不创建内存队列或本地定时器。 */
export function unavailableTaskCapabilities<T = unknown, P extends JsonValue = JsonValue>() {
  return {
    queue: { available: false } as Capability<QueueProducer<T>>,
    transactionalEnqueue: { available: false } as Capability<TransactionalEnqueue<T>>,
    workflow: { available: false } as Capability<Workflow<P>>,
    scheduler: { available: false } as Capability<Scheduler>,
    health: {
      queue: async () => ({ status: 'unavailable' }),
      scheduler: async () => ({ status: 'unavailable', lastCronAt: null }),
    } satisfies TaskHealth,
  }
}

export * from './background.ts'
export * from './cache.ts'
export * from './request.ts'
