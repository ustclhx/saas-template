// 审核分栏常量单独成文件：路由的 validateSearch 会随入口水合，不能为此导入审核页（DataTable）
export const STUDIO_REVIEW_QUEUES = ['pending', 'reported', 'hidden', 'removed'] as const
export type StudioReviewQueue = (typeof STUDIO_REVIEW_QUEUES)[number]

export const isStudioReviewQueue = (value: string | undefined): value is StudioReviewQueue =>
  (STUDIO_REVIEW_QUEUES as readonly string[]).includes(value ?? '')
