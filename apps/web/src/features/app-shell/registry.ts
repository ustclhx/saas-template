// 导航注册入口：先清空，再依次登记模板条目、启用插件的条目（plugins.gen.ts）与项目条目（同 id 后者覆盖前者）。
// 每次模块（含热更新）执行都从空注册表开始，不残留旧条目。布局只导入本文件。
import webPlugins from '../../plugins.gen.ts'
import { registerPluginAppNav } from '../plugins/extensions.ts'
import { registerDefaultAppNav } from './nav.default.ts'
import { registerProjectAppNav } from './nav.project.ts'
import { registerAppNav, resetAppNav } from './nav.ts'

resetAppNav()
registerDefaultAppNav()
registerPluginAppNav(webPlugins, registerAppNav)
registerProjectAppNav()

export { TEMPLATE_NAV_IDS } from './nav.default.ts'
export { activeAppNavId, resolveAppNav } from './nav.ts'
