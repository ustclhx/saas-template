import { log } from '@saas/shared/log'

/** 目标入口注入观测实现；业务不加载任何 Sentry 平台 SDK。 */
export interface JobObserver {
  tagContext(): void
  captureException(error: unknown): void
}

/** Node 暂以共享日志记录固定错误类型，不输出外部异常中的凭据或内容。 */
export const logJobObserver: JobObserver = {
  tagContext() {},
  captureException(error) {
    log.error('jobs.exception', { errorType: error instanceof Error ? error.name : typeof error })
  },
}
