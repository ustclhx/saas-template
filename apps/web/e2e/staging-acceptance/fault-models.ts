import { isDeepStrictEqual } from 'node:util'
import type { Page } from '@playwright/test'
import type { FaultModelDefinition } from './fault-definitions.ts'
import { createAcceptanceModel } from './models.ts'
import { expect, query, sqlLiteral } from './support.ts'

export interface FaultCleanupResult {
  key: string
  id?: string
  status: 'disabled' | 'already-disabled' | 'failed'
  auditIds: string[]
}

type ModelRow = Record<string, unknown> & { id: string; enabled: boolean }
type CleanupEntry = { expected: FaultModelDefinition; id?: string }

export async function readFaultModel(model: FaultModelDefinition) {
  if (!process.env.NEON_READONLY_URL)
    throw new Error('Fault model checks require NEON_READONLY_URL')
  const rows = await query<ModelRow>(`select id, key, kind, provider, provider_model_id, pricing,
    min_plan_features, params_schema, enabled, sort from ai_model
    where key=${sqlLiteral(model.key)}`)
  if (rows.length > 1) throw new Error('Fault model key is not unique')
  return rows[0]
}

function verifyConfiguration(row: ModelRow, expected: FaultModelDefinition) {
  const { id: _id, enabled: _enabled, ...configuration } = row
  if (
    !isDeepStrictEqual(configuration, {
      key: expected.key,
      kind: expected.kind,
      provider: expected.provider,
      provider_model_id: expected.providerModelId,
      pricing: expected.pricing,
      min_plan_features: [],
      params_schema: expected.paramsSchema,
      sort: expected.sort,
    })
  )
    // 配置可能包含内容；错误只保留可核验的资源 ID。
    throw new Error(`Fault model configuration conflict (resource ${row.id})`)
}

export async function faultModelEditor(page: Page, model: FaultModelDefinition, id: string) {
  // 后台默认每页 50 项，按同一 sort/key 顺序定位，不能假定专用模型在首页。
  const [position] = await query<{ rank: number }>(`select rank from (
    select id, (row_number() over (order by sort asc, key asc)-1)::int as rank from ai_model
    ) positions where id=${sqlLiteral(id)}`)
  if (!position) throw new Error(`Fault model not found (resource ${id})`)
  await page.goto(`/admin/models?order=sort&offset=${Math.floor(position.rank / 50) * 50}`)
  const editor = page.getByRole('article', { name: `Model ${model.key}`, exact: true })
  await expect(editor).toBeVisible()
  return editor
}

async function disabledAudits(id: string) {
  return query<{ id: string }>(`select id from audit_log
    where action='ai.model_disabled' and target_id=${sqlLiteral(id)} order by id`)
}

async function cleanupEntries(page: Page, entries: CleanupEntry[]): Promise<FaultCleanupResult[]> {
  const results: FaultCleanupResult[] = []
  for (const entry of entries) {
    const result: FaultCleanupResult = {
      key: entry.expected.key,
      ...(entry.id ? { id: entry.id } : {}),
      status: 'failed',
      auditIds: [],
    }
    results.push(result)
    try {
      const row = await readFaultModel(entry.expected)
      if (!row) {
        // 创建在写库前被拒绝时没有遗留资源，无需制造一次停用审计。
        if (entry.id) throw new Error('Prepared fault model disappeared')
        result.status = 'already-disabled'
        continue
      }
      result.id = row.id
      verifyConfiguration(row, entry.expected)
      if (entry.id && entry.id !== row.id) throw new Error('Prepared fault model identity changed')
      const before = await disabledAudits(row.id)
      result.auditIds = before.map((audit) => audit.id)
      if (!row.enabled) {
        result.status = 'already-disabled'
        continue
      }
      const editor = await faultModelEditor(page, entry.expected, row.id)
      await editor.getByRole('button', { name: 'Disable', exact: true }).click()
      await expect(editor.getByRole('status')).toHaveText('Saved.', { timeout: 5_000 })
      await expect.poll(async () => (await readFaultModel(entry.expected))?.enabled).toBe(false)
      const after = await disabledAudits(row.id)
      const oldIds = new Set(result.auditIds)
      if (!after.some((audit) => !oldIds.has(audit.id)))
        throw new Error('Fault model disable audit is missing')
      result.auditIds = after.map((audit) => audit.id)
      result.status = 'disabled'
    } catch {
      // 单项失败不能跳过其他资源；固定安全错误由调用方统一报告。
      result.status = 'failed'
    }
  }
  return results
}

// 供本地负面用例在撤掉 UI 故障后停用其自有且完整匹配的遗留模型。
export async function cleanupFaultModels(page: Page, models: readonly FaultModelDefinition[]) {
  const results = await cleanupEntries(
    page,
    models.map((expected) => ({ expected })),
  )
  assertCleanup(results)
  return results
}

function assertCleanup(results: FaultCleanupResult[]) {
  const failed = results.filter((result) => result.status === 'failed')
  if (failed.length)
    throw new Error(
      `Fault model cleanup failed (resources ${failed.map((result) => result.id ?? result.key).join(', ')})`,
    )
}

export async function withFaultModels<T>(
  page: Page,
  models: readonly FaultModelDefinition[],
  run: () => Promise<T>,
  onCleanup?: (results: FaultCleanupResult[]) => Promise<void>,
): Promise<T> {
  const entries: CleanupEntry[] = []
  let originalError: unknown
  let failed = false
  let value: T | undefined
  let cleanupError: AggregateError | undefined
  try {
    for (const model of models) {
      let row = await readFaultModel(model)
      if (row) verifyConfiguration(row, model)
      // 先核对已有资源，再登记 key；写入响应丢失时 finally 仍能只读恢复 ID。
      const entry: CleanupEntry = { expected: model, ...(row ? { id: row.id } : {}) }
      entries.push(entry)
      if (!row) {
        await createAcceptanceModel(page, model, true)
        row = await readFaultModel(model)
        if (!row) throw new Error('Created fault model could not be confirmed')
        entry.id = row.id
        verifyConfiguration(row, model)
      } else if (!row.enabled) {
        const editor = await faultModelEditor(page, model, row.id)
        await editor.getByRole('button', { name: 'Enable', exact: true }).click()
        await expect(editor.getByRole('status')).toHaveText('Saved.')
      }
      const ready = await readFaultModel(model)
      if (!ready) throw new Error('Prepared fault model could not be confirmed')
      verifyConfiguration(ready, model)
      if (!ready.enabled) throw new Error(`Fault model was not enabled (resource ${ready.id})`)
    }
    value = await run()
  } catch (error) {
    failed = true
    originalError = error
  } finally {
    const results = await cleanupEntries(page, entries)
    const errors: unknown[] = []
    try {
      assertCleanup(results)
    } catch (error) {
      errors.push(error)
    }
    try {
      await onCleanup?.(results)
    } catch (error) {
      errors.push(error)
    }
    if (errors.length)
      cleanupError = new AggregateError(
        [...(failed ? [originalError] : []), ...errors],
        `Fault run cleanup or evidence failed (resources ${results.map((result) => result.id ?? result.key).join(', ')})`,
      )
  }
  if (cleanupError) throw cleanupError
  if (failed) throw originalError
  return value as T
}
