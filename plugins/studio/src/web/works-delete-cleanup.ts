import { type DeletionContext, type DeletionStep, registerDeletionStep } from '@saas/auth'
import { type InvalidateStudioWork, invalidateStudioWork } from './work-invalidation.ts'

type DeletedWork = Parameters<InvalidateStudioWork>[0]

function studioDeletionStep(
  kind: Parameters<typeof registerDeletionStep>[0],
  invalidate: InvalidateStudioWork | undefined,
): DeletionStep {
  const pending = new WeakMap<DeletionContext, DeletedWork[]>()
  return {
    async execute(context, sql) {
      // 认证步骤拿到当前事务的原生 SQL。账号步骤是跨空间系统操作；
      // 删空间只清理认证事务已锁定的目标空间。文件保留仍由原有清理任务负责。
      const scope =
        kind === 'account'
          ? sql`w.workspace_id = ${context.actorUserId} or w.user_id = ${context.actorUserId} or t.user_id = ${context.actorUserId}`
          : sql`w.workspace_id in ${sql([...context.workspaceIds])}`
      const candidates = await sql<{ id: string }[]>`
        select w.id from file f
        join studio_work w on w.file_id = f.id and w.workspace_id = f.workspace_id
        join ai_task t on t.id = w.task_id and t.workspace_id = w.workspace_id
        where ${scope}
        order by f.id for update of f`
      if (candidates.length) {
        // 单参数支持作品很多的空间；连接关闭类型发现，由 PostgreSQL 解析 UUID 数组。
        const ids = sql`string_to_array(${candidates.map((row) => row.id).join(',')}, ',')::uuid[]`
        // 更新同时锁定作品，返回更新前的版本以失效旧地址。
        const works = await sql<DeletedWork[]>`
          update studio_work set version = version + 1 where id = any(${ids})
          returning id, slug, site, version - 1 as version`
        if (works.length) {
          await sql`delete from studio_work where id = any(${ids})`
          pending.set(context, works)
        }
      }
      if (kind === 'account')
        await sql`delete from studio_publication where user_id = ${context.actorUserId}`
    },
    async after(context) {
      const works = pending.get(context) ?? []
      pending.delete(context)
      for (const work of works) await invalidateStudioWork(work, invalidate)
    },
  }
}

export function registerStudioDeletionSteps(invalidate?: InvalidateStudioWork): () => void {
  const account = registerDeletionStep('account', studioDeletionStep('account', invalidate))
  const workspace = registerDeletionStep('workspace', studioDeletionStep('workspace', invalidate))
  return () => {
    account()
    workspace()
  }
}
