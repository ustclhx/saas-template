import { useSyncExternalStore } from 'react'

// 与 Tailwind md 断点一致（同通知铃铛）；服务端与水合首帧按桌面渲染
const DESKTOP_QUERY = '(min-width: 48rem)'

function subscribe(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** 桌面宽度：新建对话在桌面为居中弹窗，手机为底部面板（设计稿 List / ListMobile） */
export function useDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  )
}
