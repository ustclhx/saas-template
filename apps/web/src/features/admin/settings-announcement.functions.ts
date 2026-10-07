import { env } from 'cloudflare:workers'
import { createDb, dbSettingStore, getSetting } from '@saas/db'
import { log } from '@saas/shared/log'
import { createServerFn } from '@tanstack/react-start'

// 公开入口只返回公告，不暴露后台其余设置。
export const getAnnouncement = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    return await getSetting(
      { store: dbSettingStore(createDb(env.HYPERDRIVE)), cache: env.CACHE },
      'site.announcement',
    )
  } catch (error) {
    log.error('site.announcement_read_failed', { error })
    throw error
  }
})
