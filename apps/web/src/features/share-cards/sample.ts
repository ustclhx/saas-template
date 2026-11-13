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
const samples: ReadonlyMap<string, ShareResolution<SampleShareData>> = new Map([
  [
    sampleShareToken,
    {
      workspaceId: 'sample-workspace',
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

/** 仅测试与 /dev/ui 显式调用；生产注册入口不导入本模块。 */
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
