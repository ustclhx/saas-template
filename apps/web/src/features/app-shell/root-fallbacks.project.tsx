// 项目自有：模板只创建本文件，之后不再修改（template-release 检查），template-sync 不会在这里冲突。
// 根路由与路由器默认的 404 / 兜底错误界面（__root.tsx、router.tsx）从这里取，分享页等未自带错误界面的路由同样使用。
// 换成项目品牌页面时改这两个导出即可，例如：
//
//   export { BrandNotFound as RootNotFound, BrandError as RootError } from '../brand/status-pages.tsx'
//
// 错误界面不要显示错误详情（可能含内部信息），并给出回到站内的链接（public-site-availability「兜底错误界面」）。
export {
  ErrorPage as RootError,
  NotFoundPage as RootNotFound,
} from '../marketing/not-found.tsx'
