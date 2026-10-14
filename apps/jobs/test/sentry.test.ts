import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { env, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { instrumentWorkflowWithSentry } from '@sentry/cloudflare'
import { afterEach, expect, it, vi } from 'vitest'
import worker, { AiMediaWorkflow } from '../src/index.ts'
import { sentryOptions } from '../src/sentry.ts'
import * as mediaRunner from '../src/workflows/media-runner.ts'

afterEach(() => vi.restoreAllMocks())

function sentryEvents(send: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>) {
  return send.mock.calls
    .flatMap(([, init]) => String(init?.body).split('\n'))
    .map((line) => JSON.parse(line))
    .filter((line) => line.exception)
}

function workflowFixture() {
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))
  const ctx = createExecutionContext()
  // 原生 WorkflowEntrypoint 构造器不接受 SDK 的 ctx Proxy；夹具复用真实 run 与 SDK。
  class WorkflowFixture {
    constructor(
      _ctx: ExecutionContext,
      readonly env: Cloudflare.Env,
    ) {}
    run = AiMediaWorkflow.prototype.run
  }
  const Instrumented = instrumentWorkflowWithSentry(
    sentryOptions,
    WorkflowFixture as unknown as typeof AiMediaWorkflow,
  )
  const workflow = new Instrumented(ctx, {
    ...env,
    SENTRY_DSN: 'https://fixture@example.test/1',
    SENTRY_ENVIRONMENT: 'staging',
    APP_VERSION: 'fixture-commit-sha',
  })
  const event = {
    instanceId: 'workflow-fixture',
    payload: { taskId: 'task-fixture', requestId: 'workflow-request' },
    timestamp: new Date(),
  } as WorkflowEvent<{ taskId: string; requestId: string }>
  return { send, ctx, workflow, event }
}

it.each(['run', 'runner'] as const)(
  'reports a step failure once through the SDK when caught by %s',
  async (caughtBy) => {
    const { send, ctx, workflow, event } = workflowFixture()
    const original = new Error('fixture step failure')
    const wrapped = new Error('fixture engine wrapper')
    const step = {
      async do(
        _name: string,
        optionsOrCallback: unknown,
        maybeCallback?: (...args: unknown[]) => Promise<unknown>,
      ) {
        const callback = (maybeCallback ?? optionsOrCallback) as (
          ...args: unknown[]
        ) => Promise<unknown>
        try {
          return await callback({ attempt: 4, config: { retries: { limit: 3 } } })
        } catch {
          throw wrapped
        }
      },
    } as unknown as WorkflowStep
    vi.spyOn(mediaRunner, 'runMediaTask').mockImplementationOnce(async (_taskId, step, deps) => {
      try {
        const fail = async () => {
          throw original
        }
        return await (caughtBy === 'run'
          ? step.do('fixture-step', fail)
          : step.do('fixture-step', { retries: { limit: 3, delayMs: 1 } }, fail))
      } catch (error) {
        if (caughtBy === 'run') throw error
        deps.observer?.captureException(error)
        return { taskId: 'task-fixture', status: 'failed' }
      }
    })
    const run = workflow.run(event, step)
    if (caughtBy === 'run') await expect(run).rejects.toBe(wrapped)
    else await expect(run).resolves.toMatchObject({ status: 'failed' })
    await waitOnExecutionContext(ctx)
    expect(sentryEvents(send)).toHaveLength(1)
    expect(sentryEvents(send)[0]).toMatchObject({
      dist: 'jobs',
      release: 'fixture-commit-sha',
      tags: { requestId: 'workflow-request' },
      exception: { values: [{ mechanism: { type: 'auto.faas.cloudflare.workflow' } }] },
    })
  },
)

it('still reports a run error after a handled step failure', async () => {
  const { send, ctx, workflow, event } = workflowFixture()
  const outside = new Error('fixture outside step')
  const step = {
    do: async (_name: string, callback: () => Promise<unknown>) => callback(),
  } as unknown as WorkflowStep
  vi.spyOn(mediaRunner, 'runMediaTask').mockImplementationOnce(async (_taskId, step) => {
    await step
      .do('fixture-step', async () => {
        throw new Error('fixture handled step failure')
      })
      .catch(() => null)
    throw outside
  })
  await expect(workflow.run(event, step)).rejects.toBe(outside)
  await waitOnExecutionContext(ctx)
  expect(sentryEvents(send)).toHaveLength(2)
  expect(sentryEvents(send).at(-1)).toMatchObject({ tags: { requestId: 'workflow-request' } })
})

it('reports a step engine rejection when its callback never failed', async () => {
  const { send, ctx, workflow, event } = workflowFixture()
  const engineError = new Error('fixture engine validation failure')
  vi.spyOn(mediaRunner, 'runMediaTask').mockImplementationOnce(async (_taskId, step) =>
    step.do('invalid-step', async () => ({ taskId: 'task-fixture', status: 'failed' })),
  )
  await expect(
    workflow.run(event, {
      do: async () => {
        throw engineError
      },
    } as unknown as WorkflowStep),
  ).rejects.toBe(engineError)
  await waitOnExecutionContext(ctx)
  expect(sentryEvents(send)).toHaveLength(1)
})

it('reports an early step termination that the SDK does not capture', async () => {
  const { send, ctx, workflow, event } = workflowFixture()
  const wrapped = new Error('fixture early termination')
  const step = {
    async do(_name: string, _options: unknown, callback: (...args: unknown[]) => Promise<unknown>) {
      try {
        return await callback({ attempt: 1, config: { retries: { limit: 3 } } })
      } catch {
        throw wrapped
      }
    },
  } as unknown as WorkflowStep
  vi.spyOn(mediaRunner, 'runMediaTask').mockImplementationOnce(async (_taskId, step) =>
    step.do('fixture-step', { retries: { limit: 3, delayMs: 1 } }, async () => {
      throw new Error('fixture nonretryable failure')
    }),
  )
  await expect(workflow.run(event, step)).rejects.toBe(wrapped)
  await waitOnExecutionContext(ctx)
  expect(sentryEvents(send)).toHaveLength(1)
  expect(sentryEvents(send)[0].exception.values[0].mechanism.type).not.toBe(
    'auto.faas.cloudflare.workflow',
  )
})

it('captures an unhandled staging Cron error with release and request ID through the real SDK', async () => {
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))
  const ctx = createExecutionContext()
  await expect(
    worker.scheduled(
      createScheduledController({ cron: 'unknown-fixture-cron' }),
      {
        ...env,
        SENTRY_DSN: 'https://fixture@example.test/1',
        SENTRY_ENVIRONMENT: 'staging',
        APP_VERSION: 'fixture-commit-sha',
      },
      ctx,
    ),
  ).rejects.toThrow('Unknown cron')
  await waitOnExecutionContext(ctx)
  const bodies = send.mock.calls.map(([, init]) => String(init?.body)).join('\n')
  const event = bodies
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((line) => line.exception)
  expect(event).toMatchObject({
    release: 'fixture-commit-sha',
    environment: 'staging',
    tags: { requestId: expect.any(String) },
  })
})

it('does not initialize or send from the local handler even when a DSN is present', async () => {
  const send = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'))
  const ctx = createExecutionContext()
  await expect(
    worker.scheduled(
      createScheduledController({ cron: 'unknown-fixture-cron' }),
      {
        ...env,
        SENTRY_DSN: 'https://fixture@example.test/1',
        SENTRY_ENVIRONMENT: 'development',
      },
      ctx,
    ),
  ).rejects.toThrow('Unknown cron')
  await waitOnExecutionContext(ctx)
  expect(send).not.toHaveBeenCalled()
})
