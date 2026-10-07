import { env } from 'cloudflare:workers'
import { createDb, dbSettingStore, getSetting } from '@saas/db'
import { log } from '@saas/shared/log'
import { createServerFn } from '@tanstack/react-start'

// 公开入口只返回公告，不暴露后台其余设置。
// 公告不是关键内容：读取失败（数据库不可达、构建期预渲染没有数据库）时按「无公告」处理，
// 不能让根布局的 loader 失败而导致所有页面 500（营销页须在数据库停止时仍可访问）。
export const getAnnouncement = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    return await getSetting(
      { store: dbSettingStore(createDb(env.HYPERDRIVE)), cache: env.CACHE },
      'site.announcement',
    )
  } catch (error) {
    log.warn('site.announcement_read_failed', { error })
    return ''
  }
})
