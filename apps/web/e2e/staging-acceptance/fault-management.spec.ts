import { createHash } from 'node:crypto'
import type { Page, Route } from '@playwright/test'
import { FAULT_MODELS, type FaultModelDefinition } from './fault-definitions.ts'
import {
  cleanupFaultModels,
  type FaultCleanupResult,
  readFaultModel,
  withFaultModels,
} from './fault-models.ts'
import { prepareFaultReadiness } from './fault-readiness.ts'
import { runMediaFaultScenario } from './fault-support.ts'
import { createAcceptanceModel } from './models.ts'
import { expect, local, login, query, runId, sqlLiteral, test } from './support.ts'

function ownedModel(label: string, index = 0): FaultModelDefinition {
  const base = FAULT_MODELS[index]
  if (!base) throw new Error('Missing fault model definition')
  const identity = createHash('sha256').update(`${runId}:${label}`).digest('hex').slice(0, 12)
  return { ...base, key: `acceptance-fault-${base.mode}-${identity}` }
}

async function disabled(model: FaultModelDefinition) {
  const row = await readFaultModel(model)
  expect(row?.enabled, 'Prepared model must be disabled after any failure').toBe(false)
  return row
}

async function captureFailure(run: () => Promise<unknown>) {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('Expected the fault run to fail')
}

test.beforeEach(async ({ page }) => {
  if (!local) throw new Error('Fault management negative tests require the isolated local config')
  await login(page, 'admin')
})

test('partial preparation failure disables models prepared before the rejected create', async ({
  page,
}) => {
  const first = ownedModel('partial-first')
  const invalid = { ...ownedModel('partial-rejected', 1), providerModelId: 'invalid-fixture-model' }
  let cleanup: FaultCleanupResult[] = []
  let sceneRan = false
  try {
    const failure = await captureFailure(() =>
      withFaultModels(
        page,
        [first, invalid],
        async () => {
          sceneRan = true
        },
        async (results) => {
          cleanup = results
        },
      ),
    )
    expect(failure).toBeInstanceOf(Error)
    expect(sceneRan).toBe(false)
    await disabled(first)
    expect(await readFaultModel(invalid)).toBeUndefined()
    expect(cleanup.find((result) => result.key === first.key)?.status).toBe('disabled')
  } finally {
    await cleanupFaultModels(page, [first])
  }
})

test('scene failure preserves its error and disables every prepared model', async ({ page }) => {
  const models = [ownedModel('scene-first'), ownedModel('scene-second', 1)]
  const sceneError = new Error('Intentional local scene failure')
  let cleanup: FaultCleanupResult[] = []
  try {
    const failure = await captureFailure(() =>
      withFaultModels(
        page,
        models,
        async () => {
          throw sceneError
        },
        async (results) => {
          cleanup = results
        },
      ),
    )
    expect(failure).toBe(sceneError)
    for (const model of models) await disabled(model)
    expect(cleanup.map((result) => result.status)).toEqual(['disabled', 'disabled'])
    expect(cleanup.every((result) => result.auditIds.length > 0)).toBe(true)
  } finally {
    await cleanupFaultModels(page, models)
  }
})

test('one failed Disable RPC still cleans other models and reports both errors', async ({
  page,
}) => {
  const models = [ownedModel('cleanup-first'), ownedModel('cleanup-second', 1)]
  let rejectedId = ''
  let rejected = false
  let cleanup: FaultCleanupResult[] = []
  const sceneError = new Error('Intentional scene failure before cleanup')
  const intercept = async (route: Route) => {
    const request = route.request()
    const body = request.postData() ?? ''
    // Seroval 将布尔值编码为类型标签；目标 ID 在此阶段只由 Disable RPC 提交。
    if (request.method() === 'POST' && rejectedId && body.includes(rejectedId)) {
      rejected = true
      await route.abort('failed')
    } else await route.continue()
  }
  await page.route('**/*', intercept)
  try {
    const failure = await captureFailure(() =>
      withFaultModels(
        page,
        models,
        async () => {
          rejectedId = (await readFaultModel(models[0] as FaultModelDefinition))?.id ?? ''
          throw sceneError
        },
        async (results) => {
          cleanup = results
        },
      ),
    )
    expect(rejected).toBe(true)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toContain(sceneError)
    expect(cleanup.map((result) => result.status)).toEqual(['failed', 'disabled'])
    expect(cleanup[0]?.id).toBe(rejectedId)
    expect((await readFaultModel(models[0] as FaultModelDefinition))?.enabled).toBe(true)
    await disabled(models[1] as FaultModelDefinition)
  } finally {
    await page.unroute('**/*', intercept)
    await cleanupFaultModels(page, models)
  }
})

test('same key configuration conflict is neither overwritten nor added to cleanup', async ({
  page,
}) => {
  const first = ownedModel('conflict-first')
  const expected = ownedModel('conflict-existing', 1)
  const conflict = {
    ...expected,
    pricing: { mode: 'per_call', credits: 4, chargeOn: 'success' },
  } satisfies FaultModelDefinition
  let cleanup: FaultCleanupResult[] = []
  try {
    const old = await readFaultModel(conflict)
    if (!old) await createAcceptanceModel(page, conflict, true)
    const before = await readFaultModel(conflict)
    const failure = await captureFailure(() =>
      withFaultModels(
        page,
        [first, expected],
        async () => {},
        async (results) => {
          cleanup = results
        },
      ),
    )
    expect((failure as Error).message).toMatch(/^Fault model configuration conflict/)
    expect(await readFaultModel(conflict)).toEqual(before)
    expect(cleanup.map((result) => result.key)).toEqual([first.key])
    await disabled(first)
  } finally {
    await cleanupFaultModels(page, [first, conflict])
  }
})

test('repeated same run reuses one business task and Enable does not rewrite model config', async ({
  page,
}) => {
  test.setTimeout(360_000)
  const model = FAULT_MODELS[0] as FaultModelDefinition
  const run = async (current: Page) => {
    const workspace = await prepareFaultReadiness(current)
    return runMediaFaultScenario(current, workspace, model)
  }
  const first = await withFaultModels(page, [model], () => run(page))
  const disabledBefore = await disabled(model)
  const before = await query<{ id: string }>(`select id from audit_log where
    target_id=${sqlLiteral(disabledBefore?.id ?? '')} and action='ai.model_updated' order by id`)
  const second = await withFaultModels(page, [model], () => run(page))
  expect(second.resourceId).toBe(first.resourceId)
  expect(second.reused).toBe(true)
  const resources = await query<{ id: string }>(`select id from ai_task
    where id=${sqlLiteral(first.resourceId)}`)
  expect(resources).toHaveLength(1)
  const after = await query<{ id: string }>(`select id from audit_log where
    target_id=${sqlLiteral(disabledBefore?.id ?? '')} and action='ai.model_updated' order by id`)
  expect(after).toEqual(before)
  expect(await disabled(model)).toEqual(disabledBefore)
})
