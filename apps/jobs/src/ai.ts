// 由目标入口显式注册，避免加载中立 handlers 时给关闭 AI 的 Node 项目安装处理器。
import { chatHoldSweeper } from '@saas/ai'
import { registerHoldSweeper } from '@saas/billing'
import templateConfig from '../../../template.config.ts'

export function registerAiHoldSweepers(features: { text: boolean }) {
  const dispose: (() => void)[] = []
  if (features.text)
    dispose.push(
      registerHoldSweeper(
        'ai_message',
        chatHoldSweeper({ overage: templateConfig.billing.overage }),
      ),
    )
  return () => {
    for (const unregister of dispose) unregister()
  }
}
