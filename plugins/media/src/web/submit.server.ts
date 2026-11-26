import { type AvailableModel, dbModelStore, listAvailableModels } from '@saas/ai'
import { type Database, file, scoped } from '@saas/db'
import { getEntitlements } from '@saas/entitlements'
import { readFaultAccess } from '@web/features/ai/fault-access.ts'
import { getWebRuntime } from '@web/server/runtime.ts'
import { templateConfig } from '@web/server/template-config.ts'
import type { ResolvedWorkspace } from '@web/server/workspace-context.ts'
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm'

export { submitWorkspaceMedia, type WorkspaceMediaDeps } from './media-tasks.ts'
export { getFileMediaHttpDeps } from './runtime.ts'

type SubmitOptionsContext = Pick<ResolvedWorkspace, 'workspace'> & {
  db: Database
  workspaceReadOnly: boolean
}

/** 生成页共用空间的套餐选模与已确认文件查询，调用方可收窄模型列表。 */
export async function getWorkspaceMediaSubmitOptions(
  { db, workspace, workspaceReadOnly }: SubmitOptionsContext,
  headers: Headers,
  acceptsModel?: (model: AvailableModel) => boolean,
) {
  const runtime = getWebRuntime()
  const entitlements = await getEntitlements(db, workspace.id, {
    pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
  })
  const available = await listAvailableModels(
    {
      store: dbModelStore(db),
      cache: runtime.cache,
      workersAi: runtime.ai?.available ? runtime.ai.value.workersAi.available : false,
      faultAccess: await readFaultAccess({
        auth: runtime.auth,
        db,
        headers,
        env: runtime.ai?.available ? runtime.ai.value.config : {},
      }),
    },
    entitlements,
  )
  const models = available
    .filter(
      (model) =>
        model.kind !== 'text' &&
        templateConfig.ai[model.kind] &&
        (!acceptsModel || acceptsModel(model)),
    )
    .map(({ key, displayName, kind, pricing, paramsSchema }) => ({
      key,
      displayName,
      kind,
      pricing,
      // JSON 字符串保留完整 schema，同时满足 Server Function 的可序列化类型约束。
      paramsSchema: paramsSchema === null ? null : JSON.stringify(paramsSchema),
    }))
  const files = await scoped(db, workspace.id)
    .select(file, {
      fields: { id: file.id, mime: file.mime, size: file.size, status: file.status },
      where: and(eq(file.status, 'ready'), isNull(file.deletedAt)) as SQL,
    })
    .orderBy(desc(file.id))
  return {
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    readOnly: workspaceReadOnly,
    models,
    files,
  }
}
