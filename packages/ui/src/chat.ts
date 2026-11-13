// `@saas/ui/chat` 子路径入口（openspec add-ai-chat-components design D3）：对话组件依赖 react-markdown 等较重的库，
// 不放进 `@saas/ui` 主入口，只被对话路由与 SubjectChat 所在页面引用，首页包不受影响。
export {
  ChatMarkdown,
  type ChatMarkdownLabels,
  type ChatMarkdownProps,
} from './components/chat-markdown.tsx'
