import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { getNotifications, readNotifications } from './notifications.functions.ts'

export type NotificationPage = Awaited<ReturnType<typeof getNotifications>>
export type NotificationRow = NotificationPage['rows'][number]

/** loading：还没有拿到第一页；error：最近一次读取失败（铃铛不显示角标） */
export type NotificationStatus = 'loading' | 'ready' | 'error'

export interface NotificationsState {
  slug: string
  status: NotificationStatus
  /** 第一页（offset 0）；loading 时为 null，出错时保留上一次的结果 */
  page: NotificationPage | null
  /** 重新读取第一页；showLoading 时先切到加载态（错误态的「重试」） */
  refresh: (options?: { showLoading?: boolean }) => Promise<void>
  /** 标为已读（不传 id 为全部），随后刷新第一页；返回服务端校验过的跳转链接 */
  markRead: (id?: string) => Promise<{ link: string | null }>
}

export const POLL_INTERVAL_MS = 30_000

const NotificationsContext = createContext<NotificationsState | null>(null)

/**
 * 工作台通知数据（评审清单 #90）：铃铛与首页通知区共用这一份第一页数据与 30 秒轮询，
 * 不各自请求。布局按空间渲染一次（key 为 slug）。
 */
export function NotificationsProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const [status, setStatus] = useState<NotificationStatus>('loading')
  const [page, setPage] = useState<NotificationPage | null>(null)
  // 并发的读取只采用最后发出的一次，避免较早的轮询结果覆盖标为已读后的新结果
  const requestRef = useRef(0)

  const refresh = useCallback(
    async (options?: { showLoading?: boolean }) => {
      const request = ++requestRef.current
      if (options?.showLoading) setStatus('loading')
      try {
        const next = await getNotifications({ data: { slug, offset: 0 } })
        if (request !== requestRef.current) return
        setPage(next)
        setStatus('ready')
      } catch {
        // 通知读取失败只降级入口，不阻止应用布局使用
        if (request === requestRef.current) setStatus('error')
      }
    },
    [slug],
  )

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const markRead = useCallback(
    async (id?: string) => {
      const { link } = await readNotifications({ data: { slug, ...(id ? { id } : {}) } })
      await refresh()
      return { link }
    },
    [slug, refresh],
  )

  const value = useMemo(
    () => ({ slug, status, page, refresh, markRead }),
    [slug, status, page, refresh, markRead],
  )
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
}

export function useNotifications(): NotificationsState {
  const value = useContext(NotificationsContext)
  if (!value) throw new Error('useNotifications must be used within NotificationsProvider')
  return value
}

/** 铃铛角标：未读为 0、加载中或出错时不显示；超过 99 显示 99+ */
export function badgeText(status: NotificationStatus, unread: number): string | null {
  if (status !== 'ready' || unread <= 0) return null
  return unread > 99 ? '99+' : String(unread)
}
