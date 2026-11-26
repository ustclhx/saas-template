import { useSyncExternalStore } from 'react'

// 与 Tailwind md 断点一致；服务端与水合首帧按桌面渲染（同通知铃铛）。发布入口据此在 Dialog 与底部 Sheet 之间切换。
const DESKTOP_QUERY = '(min-width: 48rem)'

function subscribe(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export function useDesktop() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  )
}
