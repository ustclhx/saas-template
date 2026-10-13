import type { WorkflowStep as CloudflareStep, WorkflowStepConfig } from 'cloudflare:workers'
import { NonRetryableError as CloudflareNonRetryableError } from 'cloudflare:workflows'
import { AppError } from '@saas/shared'
import {
  type JsonValue,
  NonRetryableError,
  type WorkflowInstance as PlatformInstance,
  type Workflow as PlatformWorkflow,
  type WorkflowState,
  type WorkflowStep,
  type WorkflowStepEvent,
  type WorkflowStepOptions,
} from '../index.ts'

function normalizeState<R extends JsonValue>(state: InstanceStatus): WorkflowState<R> {
  if (state.status === 'unknown')
    throw new AppError('WORKFLOW_NOT_FOUND', 'Workflow instance not found', { status: 404 })
  const status =
    state.status === 'complete'
      ? 'completed'
      : state.status === 'errored'
        ? 'failed'
        : state.status === 'waitingForPause' || state.status === 'rollingBack'
          ? 'running'
          : state.status
  return {
    status,
    ...(state.output === undefined ? {} : { output: state.output as R }),
    ...(state.error === undefined ? {} : { error: state.error }),
  }
}

function adaptInstance<R extends JsonValue>(instance: WorkflowInstance): PlatformInstance<R> {
  return {
    id: instance.id,
    status: async () => normalizeState<R>(await instance.status()),
    async terminate() {
      try {
        await instance.terminate()
      } catch (error) {
        // 先查状态再 terminate 之间实例可能自行结束；CF 对终态实例抛
        // instance.cannot_terminate，而 Node（DBOS）对终态取消是空操作。复查确认已是
        // 终态才视为完成，否则原样抛出，不吞掉真实失败。
        const state = await instance.status().catch(() => null)
        if (state && ['complete', 'errored', 'terminated'].includes(state.status)) return
        throw error
      }
    },
    async sendEvent(event) {
      const { status } = normalizeState(await instance.status())
      if (status === 'completed' || status === 'failed' || status === 'terminated')
        throw new AppError('WORKFLOW_TERMINAL', 'Workflow instance is terminal', { status: 409 })
      // 状态检查与发送之间仍可能结束；绑定的错误原样传播，不吞掉竞态。
      await instance.sendEvent(event)
    },
  }
}

export function createCloudflareWorkflow<P extends JsonValue, R extends JsonValue = JsonValue>(
  binding: Pick<Workflow<P>, 'create' | 'get'>,
): PlatformWorkflow<P, R> {
  return {
    create: async (options) => adaptInstance<R>(await binding.create(options)),
    async get(id) {
      const instance = await binding.get(id)
      // CF get 可返回不存在的 handle；在中立边界明确拒绝缺失实例。
      normalizeState(await instance.status())
      return adaptInstance<R>(instance)
    },
  }
}

export function createCloudflareWorkflowStep(step: CloudflareStep): WorkflowStep {
  // Workers 的 Rpc.Serializable<JsonValue> 递归展开超过 TS 深度；此处只收窄 JSON 子集，
  // 不改变绑定调用或允许流/二进制跨步骤。保留 receiver，避免抽出原生方法丢失 this。
  const jsonStep = step as unknown as {
    do(name: string, callback: () => Promise<JsonValue>): Promise<JsonValue>
    do(
      name: string,
      config: WorkflowStepConfig,
      callback: () => Promise<JsonValue>,
    ): Promise<JsonValue>
    waitForEvent(
      name: string,
      options: { type: string; timeout: number },
    ): Promise<WorkflowStepEvent<JsonValue>>
  }
  async function run<T extends JsonValue>(callback: () => Promise<T>): Promise<JsonValue> {
    try {
      return await callback()
    } catch (error) {
      if (error instanceof NonRetryableError) throw new CloudflareNonRetryableError(error.message)
      throw error
    }
  }
  function doStep<T extends JsonValue>(name: string, callback: () => Promise<T>): Promise<T>
  function doStep<T extends JsonValue>(
    name: string,
    options: WorkflowStepOptions,
    callback: () => Promise<T>,
  ): Promise<T>
  function doStep<T extends JsonValue>(
    name: string,
    optionsOrCallback: WorkflowStepOptions | (() => Promise<T>),
    callback?: () => Promise<T>,
  ): Promise<T> {
    if (typeof optionsOrCallback === 'function')
      return jsonStep.do(name, () => run(optionsOrCallback)) as Promise<T>
    const { retries, timeoutMs } = optionsOrCallback
    const config = {
      ...(retries === undefined
        ? {}
        : {
            retries: {
              limit: retries.limit,
              delay: retries.delayMs,
              ...(retries.backoff === undefined ? {} : { backoff: retries.backoff }),
            },
          }),
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    }
    return jsonStep.do(name, config, () => run(callback as () => Promise<T>)) as Promise<T>
  }
  return {
    do: doStep,
    sleep: (name, durationMs) => step.sleep(name, durationMs),
    waitForEvent: <T extends JsonValue>(
      name: string,
      options: { type: string; timeoutMs: number },
    ) =>
      jsonStep.waitForEvent(name, {
        type: options.type,
        timeout: options.timeoutMs,
      }) as Promise<WorkflowStepEvent<T>>,
  }
}
