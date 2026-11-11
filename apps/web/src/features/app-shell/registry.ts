// 导航注册入口：先登记模板条目，再登记项目条目（同 id 覆盖模板条目）。布局只导入本文件。
import './nav.default.ts'
import './nav.project.ts'

export { activeAppNavId, resolveAppNav } from './nav.ts'
