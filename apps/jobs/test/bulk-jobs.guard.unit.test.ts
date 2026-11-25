// 批量删除 / 群发任务守卫（openspec add-ops-safeguards D1、tasks 1.5）：从实际注册的任务枚举，
// 与 docs/bulk-jobs.md 登记表双向核对，并核对各环境 wrangler crons 与 CRON_TASK_GROUPS 一致。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BulkJobSafety } from '@saas/shared/bulk-job'
import { defineBulkJob } from '@saas/shared/bulk-job'
import { describe, expect, it, vi } from 'vitest'

// 插件 jobs 入口导出 Workflow / Durable Object 类，node 中以空实现替代 Cloudflare 运行时模块
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {},
  env: {},
}))
vi.mock('cloudflare:workflows', () => ({ NonRetryableError: class extends Error {} }))

const { AI_PURGE_MAX_BATCHES, DELETION_CLEANUP_CAP, EXPIRED_WORKSPACE_CAP } = await import(
  '@saas/auth'
)
const { PERSONAL_SHARE_CARDS_WORKSPACE_CAP } = await import('@saas/auth')
const { FILES_CLEANUP_OBJECT_CAP, FILES_CLEANUP_WORKSPACE_CAP } = await import('@saas/storage')
const { AGENT_RETENTION_MIN_MS } = await import('../../../plugins/agents/src/core/lifecycle.ts')
const { BILLING_JOBS } = await import('../src/billing.ts')
const { CORE_JOBS, CORE_TASK_GROUP_JOBS, NON_CRON_BULK_JOBS } = await import(
  '../src/bulk-job-registry.ts'
)
const { CRON_TASK_GROUPS, PLUGIN_CRON_GROUPS } = await import('../src/handlers.ts')
const cloudflarePlugins = (await import('../src/plugins.gen.ts')).default
const nodePlugins = (await import('../src/plugins.node.gen.ts')).default

const root = fileURLToPath(new URL('../../..', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8')

interface Enumerated {
  id: string
  safety: BulkJobSafety
  source: string
}

/** 按 profile 展开每个触发器实际会运行的任务：核心任务（含子任务）、计费子任务与插件 cron */
function scheduledJobs(): Enumerated[] {
  const jobs = new Map<string, Enumerated>()
  const add = (job: Enumerated) => {
    const existing = jobs.get(job.id)
    if (existing && existing.safety !== job.safety)
      throw new Error(`Duplicate bulk job id with different safety: ${job.id}`)
    jobs.set(job.id, job)
  }
  for (const groups of Object.values(CRON_TASK_GROUPS))
    for (const taskGroups of groups.values())
      for (const group of taskGroups) {
        const core = CORE_TASK_GROUP_JOBS[group]
        if (!core) throw new Error(`Task group without core jobs: ${group}`)
        for (const id of core) {
          const job = CORE_JOBS[id]
          add({ id: job.id, safety: job.safety, source: 'core' })
          for (const child of 'children' in job ? job.children : [])
            add({ id: child.id, safety: child.safety, source: `core:${job.id}` })
          if (id === 'billing')
            for (const billing of BILLING_JOBS.filter((entry) => entry.cron === group))
              add({ id: billing.id, safety: billing.safety, source: 'billing' })
        }
        const pluginGroup = PLUGIN_CRON_GROUPS.get(group)
        for (const plugin of [...cloudflarePlugins, ...nodePlugins])
          for (const task of plugin.entry?.crons ?? [])
            if (task.group === pluginGroup)
              add({ id: task.id, safety: task.safety, source: `plugin:${plugin.id}` })
      }
  return [...jobs.values()]
}

function registryRows() {
  const doc = read('docs/bulk-jobs.md')
  const section = doc.slice(doc.indexOf('## 登记表'), doc.indexOf('## 不在守卫范围的删除'))
  return section
    .split('\n')
    .filter((line) => /^\| `[^`]+` \|/.test(line))
    .map((line) => {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
      return {
        id: cells[0]?.replaceAll('`', '') ?? '',
        cells,
        cap: Number(/^(\d+)/.exec(cells[3] ?? '')?.[1]),
        location: /`([^`]+)`/.exec(cells[5] ?? '')?.[1] ?? '',
      }
    })
}

describe('bulk job registry guard', () => {
  const enumerated = scheduledJobs()
  const guarded = [
    ...enumerated.filter((job) => job.safety.kind !== 'none'),
    ...NON_CRON_BULK_JOBS.map((job) => ({ ...job, source: 'non-cron' })),
  ]
  const rows = registryRows()

  it('每个任务的防护声明合法：涉及删除 / 群发的任务有正整数上限、顺序与时间防护', () => {
    expect(enumerated.length).toBeGreaterThan(10)
    for (const job of [...enumerated, ...NON_CRON_BULK_JOBS])
      expect(() => defineBulkJob({ ...job, run: async () => undefined }), job.id).not.toThrow()
  })

  it('登记表与实际注册的任务双向一致：任务 ID、每轮上限与代码位置', () => {
    expect(rows.map((row) => row.id).sort()).toEqual(guarded.map((job) => job.id).sort())
    for (const row of rows) {
      const job = guarded.find((entry) => entry.id === row.id)
      if (!job || job.safety.kind === 'none') throw new Error(`Unregistered row: ${row.id}`)
      expect(row.cells, row.id).toHaveLength(6)
      expect(row.cap, row.id).toBe(job.safety.cap)
      expect(existsSync(join(root, row.location)), `${row.id}: ${row.location}`).toBe(true)
    }
  })

  it('登记的上限与各 package 实际使用的常量一致', () => {
    const cap = (id: string) => {
      const job = guarded.find((entry) => entry.id === id)
      return job && job.safety.kind !== 'none' ? job.safety.cap : undefined
    }
    expect(cap('deletion-cleanup')).toBe(DELETION_CLEANUP_CAP)
    expect(cap('files-cleanup')).toBe(FILES_CLEANUP_OBJECT_CAP)
    expect(rows.find((row) => row.id === 'files-cleanup')?.cells[3]).toContain(
      `≤${FILES_CLEANUP_WORKSPACE_CAP} 个空间`,
    )
    expect(cap('personal-share-cards-cleanup')).toBe(PERSONAL_SHARE_CARDS_WORKSPACE_CAP)
    expect(cap('workspace-cleanup')).toBe(EXPIRED_WORKSPACE_CAP)
    expect(cap('deleted-user-ai-cleanup')).toBe(AI_PURGE_MAX_BATCHES)
    // jobs 不允许依赖 platform 的 node 适配器入口（check:deps），这里读源码中的常量
    const nodeCap = /NODE_QUEUE_CLEANUP_BATCH_CAP = (\d+)/.exec(
      read('packages/platform/src/node/job-maintenance.ts'),
    )?.[1]
    expect(cap('node-queue-cleanup')).toBe(Number(nodeCap))
    expect(AGENT_RETENTION_MIN_MS).toBe(86_400_000)
  })

  it('各环境 wrangler crons 与 CRON_TASK_GROUPS 一致', () => {
    const config = JSON.parse(
      read('apps/jobs/wrangler.jsonc').replace(
        /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
        (_match, string: string | undefined) => string ?? '',
      ),
    ) as {
      triggers?: { crons?: string[] }
      vars?: { CRON_PROFILE?: string }
      env?: Record<string, { triggers?: { crons?: string[] }; vars?: { CRON_PROFILE?: string } }>
    }
    const environments = [['default', config], ...Object.entries(config.env ?? {})] as const
    expect(environments.length).toBeGreaterThan(1)
    for (const [name, environment] of environments) {
      const profile = (environment.vars?.CRON_PROFILE ?? 'default') as keyof typeof CRON_TASK_GROUPS
      const groups = CRON_TASK_GROUPS[profile]
      expect(groups, `${name}: ${profile}`).toBeDefined()
      expect([...(environment.triggers?.crons ?? [])].sort(), name).toEqual(
        [...groups.keys()].sort(),
      )
    }
    // 每个任务组都有核心任务定义，反之亦然
    const used = new Set(
      Object.values(CRON_TASK_GROUPS).flatMap((groups) => [...groups.values()].flat()),
    )
    expect([...used].sort()).toEqual(Object.keys(CORE_TASK_GROUP_JOBS).sort())
  })
})
