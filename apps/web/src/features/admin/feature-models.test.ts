import type { Database } from '@saas/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { changedFeatureModelEntries } from './feature-models.ts'

const state = vi.hoisted(() => ({ settings: {} as Record<string, string> }))
vi.mock('@saas/ai', () => ({
  featureModels: {
    'report.summary': { kind: 'text' },
    'report.detail': { kind: 'text', inherit: ['report.summary'] },
  },
  resolveFeatureModel: vi.fn(),
}))
vi.mock('@saas/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@saas/db')>()),
  dbSettingStore: () => ({}),
  getSettingValue: async (_ctx: unknown, key: string) => state.settings[key] ?? '',
}))

const db = {} as Database

beforeEach(() => {
  state.settings = { 'ai.model.report.summary': 'general-text' }
})

describe('changedFeatureModelEntries', () => {
  it('只返回有变化的功能设置键', async () => {
    await expect(
      changedFeatureModelEntries(db, { 'report.summary': 'general-text', 'report.detail': '' }),
    ).resolves.toEqual([])
    await expect(
      changedFeatureModelEntries(db, { 'report.summary': '', 'report.detail': 'general-text' }),
    ).resolves.toEqual([
      ['ai.model.report.summary', ''],
      ['ai.model.report.detail', 'general-text'],
    ])
  })

  it('拒绝未登记的功能', async () => {
    await expect(changedFeatureModelEntries(db, { unknown: '' })).rejects.toMatchObject({
      code: 'UNKNOWN_FEATURE_MODEL',
    })
  })
})
