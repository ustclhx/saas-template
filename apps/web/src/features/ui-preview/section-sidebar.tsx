import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInset,
  type SidebarLabels,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@saas/ui'
import { useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { FolderIcon, HomeIcon, InboxIcon, SettingsIcon } from './icons.tsx'
import { PreviewSection, Specimen } from './layout.tsx'
import { SAMPLE_PROJECTS } from './sample-data.ts'

/** 侧边栏组件本身（分组、当前项、折叠、移动抽屉）；工作台页面布局属于 tasks 8.3 */
export function SidebarSection() {
  const [open, setOpen] = useState(true)
  const [active, setActive] = useState('home')
  const labels: SidebarLabels = {
    title: m.ui_preview_navigation(),
    expand: m.ui_preview_sidebar_expand(),
    collapse: m.ui_preview_sidebar_collapse(),
    rail: m.ui_preview_sidebar_rail(),
    railResize: m.ui_preview_sidebar_rail_resize(),
    railCollapse: m.ui_preview_sidebar_rail_collapse(),
  }
  const nav = [
    { id: 'home', label: m.ui_preview_nav_home(), icon: HomeIcon },
    { id: 'inbox', label: m.ui_preview_nav_inbox(), icon: InboxIcon, badge: '3' },
    { id: 'settings', label: m.ui_preview_nav_settings(), icon: SettingsIcon },
  ]
  return (
    <PreviewSection id="sidebar" title="Sidebar" description={m.ui_preview_sidebar_desc()}>
      <Specimen label={m.ui_preview_default()} wide className="block p-0">
        <div className="relative h-96 overflow-hidden rounded-xl">
          <SidebarProvider labels={labels} open={open} onOpenChange={setOpen}>
            <Sidebar collapsible="icon">
              <SidebarContent>
                <SidebarGroup>
                  <SidebarGroupLabel>{m.ui_preview_workspace()}</SidebarGroupLabel>
                  <SidebarMenu>
                    {nav.map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          icon={item.icon}
                          isActive={active === item.id}
                          tooltip={item.label}
                          onClick={() => setActive(item.id)}
                        >
                          {item.label}
                        </SidebarMenuButton>
                        {item.badge ? <SidebarMenuBadge>{item.badge}</SidebarMenuBadge> : null}
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroup>
                <SidebarGroup>
                  <SidebarGroupLabel>{m.ui_preview_projects()}</SidebarGroupLabel>
                  <SidebarMenu>
                    {SAMPLE_PROJECTS.slice(0, 4).map((project) => (
                      <SidebarMenuItem key={project.id}>
                        <SidebarMenuButton
                          icon={FolderIcon}
                          isActive={active === project.id}
                          tooltip={project.name}
                          onClick={() => setActive(project.id)}
                        >
                          {project.name}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroup>
              </SidebarContent>
            </Sidebar>
            <SidebarInset>
              <div className="flex flex-col gap-2 p-4">
                <SidebarTrigger />
                <p className="text-body text-muted-foreground">{m.ui_preview_sidebar_desc()}</p>
              </div>
            </SidebarInset>
          </SidebarProvider>
        </div>
      </Specimen>
    </PreviewSection>
  )
}
