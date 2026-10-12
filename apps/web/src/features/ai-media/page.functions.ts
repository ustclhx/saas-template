import { dbModelStore, listAvailableModels } from '@saas/ai'
import { file, scoped } from '@saas/db'
import { getEntitlements } from '@saas/entitlements'
import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'

export const getMediaSubmitPage = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(z.object({ slug: z.string().min(1).max(64) }))
  .handler(async ({ context }) => {
    const runtime = getWebRuntime()
    const entitlements = await getEntitlements(context.db, context.workspace.id, {
      pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
    })
    const available = await listAvailableModels(
      {
        store: dbModelStore(context.db),
        cache: runtime.cache,
        workersAi: runtime.ai?.available ? runtime.ai.value.workersAi.available : false,
      },
      entitlements,
    )
    const models = available
      .filter(
        (model) =>
          (model.kind === 'image' && templateConfig.ai.image) ||
          (model.kind === 'video' && templateConfig.ai.video),
      )
      .map(({ key, kind, pricing, paramsSchema }) => ({
        key,
        kind,
        pricing,
        // JSON 字符串保留完整 schema，同时满足 Server Function 的可序列化类型约束。
        paramsSchema: paramsSchema === null ? null : JSON.stringify(paramsSchema),
      }))
    const files = await scoped(context.db, context.workspace.id)
      .select(file, {
        fields: { id: file.id, mime: file.mime, size: file.size, status: file.status },
        where: and(eq(file.status, 'ready'), isNull(file.deletedAt)) as SQL,
      })
      .orderBy(desc(file.id))
    return {
      workspaceId: context.workspace.id,
      workspaceSlug: context.workspace.slug,
      readOnly: context.workspaceReadOnly,
      models,
      files,
    }
  })
