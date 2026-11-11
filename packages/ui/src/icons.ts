// 业务页面的图标入口（`@saas/ui/icons`，tasks 4.2 审阅）：apps 不直接依赖 lucide-react（pnpm check:deps 拦截），
// 需要图标时从这里按名称导入，例如 `import { Folder } from '@saas/ui/icons'`，再传给组件的图标槽位
// （Button leadingIcon、SidebarMenuButton icon、TabsItem icon、CommandMenu 条目 icon 等）。
// 按名称导出、按需打包：只导入用到的图标，不会把整个图标库带进页面。
// 这里只登记模板页面用到的常用图标；项目需要更多时在 packages/ui/src/project/ 中按同样方式再导出。
export {
  ArrowLeft,
  ArrowRight,
  Bell,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock,
  CreditCard,
  Ellipsis,
  File,
  Folder,
  House,
  Inbox,
  Info,
  KeyRound,
  LogOut,
  Mail,
  MessageCircle,
  Package,
  Plus,
  Search,
  Settings,
  Sparkles,
  Trash2,
  User,
  Users,
  X,
} from 'lucide-react'
