import { sampleShareCardLayout } from './layout.tsx'
import { registerShareCard } from './registry.ts'
import type { ShareCardDefinition, ShareResolution } from './types.ts'

export interface SampleShareData {
  title: string
  description: string
  /** 右上角标签，可省略。 */
  label?: string
  /** 底部元信息，可省略。 */
  meta?: string
}

export const sampleShareToken = 'sample_preview_token_00000000000000000000000'
export const SAMPLE_SHARE_WORKSPACE_ID = 'sample-workspace'
const samples = new Map<string, ShareResolution<SampleShareData>>([
  [
    sampleShareToken,
    {
      workspaceId: SAMPLE_SHARE_WORKSPACE_ID,
      sharedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: null,
      data: {
        title: 'Project summary',
        description: 'A short summary of the latest project.',
        label: 'Report',
        meta: '5 findings · 3 risks',
      },
    },
  ],
])

/**
 * e2e 与 staging 验收夹具用：在内存中登记一条新的示例分享（同一隔离区内有效），返回其令牌。
 * 每次测试使用新令牌，避免上一轮写入的撤销标记影响本轮。
 */
export function addSampleShare(
  token: string,
  data: SampleShareData,
  expiresAt: Date | null = null,
) {
  samples.set(token, {
    workspaceId: SAMPLE_SHARE_WORKSPACE_ID,
    sharedAt: new Date(),
    expiresAt,
    data,
  })
  return token
}

/**
 * /dev/ui 分享卡片预览的固定数据（与设计稿副本 share-cards/Card.dc.html 的变体一致）。
 * `default` 是构建期默认分享图，只有标题。
 */
export const SAMPLE_SHARE_PREVIEWS = {
  zh: {
    label: '报告摘要',
    title: '2026 年第三季度用户调研要点',
    description: '新用户留存提升 12%，主要来自引导流程简化；移动端满意度仍低于桌面端。',
    meta: '5 条结论 · 3 个风险',
  },
  en: {
    label: 'Report',
    title: 'Q3 2026 user research highlights',
    description:
      'Retention for new users rose 12%, driven by a simpler onboarding flow. Mobile satisfaction still trails desktop.',
    meta: '5 findings · 3 risks',
  },
  long: {
    label: '报告摘要',
    title:
      '面向中小团队的跨部门协作流程梳理：从需求收集、优先级评估到交付复盘的完整实践记录与改进建议',
    description:
      '梳理了需求从收集到复盘的 7 个环节，指出评估阶段信息缺失是延期的首要原因，并给出三项可在两周内落地的改进。整理过程中还对比了四个团队的做法。',
    meta: '7 个环节 · 3 项建议',
  },
  default: { title: '定价与套餐', description: '' },
} as const satisfies Record<string, SampleShareData>

export type SampleSharePreview = keyof typeof SAMPLE_SHARE_PREVIEWS

/**
 * 在测试、开发与开放 /dev/ui 的环境（`UI_PREVIEW=true`，即 staging）中由 `registerPreviewShareCards`
 * 登记；生产不设该变量，从不登记。项目注册入口 share-cards.project.ts 不导入本模块。
 */
export function registerSampleShareCard(
  render: ShareCardDefinition<SampleShareData>['render'] = sampleShareCardLayout,
) {
  return registerShareCard<SampleShareData>({
    type: 'sample',
    version: 1,
    resolve: async (token) => samples.get(token) ?? null,
    digest: (data) => {
      // 示例仅需稳定的展示摘要；访问权限始终由随机令牌与 resolve 控制。
      let hash = 2166136261
      for (const char of JSON.stringify([data.title, data.description, data.label, data.meta])) {
        hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
      }
      return (hash >>> 0).toString(16).padStart(8, '0')
    },
    render,
    alt: (data) => data.title,
    page: (data) => ({ title: data.title, description: data.description }),
  })
}
