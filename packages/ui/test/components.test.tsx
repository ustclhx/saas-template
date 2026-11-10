import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Checkbox,
  Input,
  Switch,
  Textarea,
  Tooltip,
  UiRoot,
} from '../src/index.ts'

// Radix 的弹层依赖这些浏览器 API，happy-dom 未实现
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
// happy-dom 的 Web Animations 在卸载时抛出 AbortError；去掉后 motion 退回到 JS 驱动的动画
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => {
  cleanup()
})

/** 键盘激活按钮：浏览器在 Space 抬起 / Enter 按下时派发 click，happy-dom 不模拟这一步 */
function pressKey(el: HTMLElement, key: ' ' | 'Enter') {
  const down = fireEvent.keyDown(el, { key })
  if (key === 'Enter' && down) fireEvent.click(el)
  const up = fireEvent.keyUp(el, { key })
  if (key === ' ' && down && up) fireEvent.click(el)
}

describe('Input / Textarea（Fluid input、textarea）', () => {
  it('与 Select 触发器同一套高度、边框、字号与 2px 焦点环，跟随 density', () => {
    const html = renderToString(
      <>
        <Input aria-label="Name" />
        <UiRoot density="compact" shape="pill">
          <Input aria-label="Compact" />
          <Textarea aria-label="Notes" />
        </UiRoot>
      </>,
    )
    const [input, compact, textarea] = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1])
    expect(input).toContain('h-9')
    expect(input).toContain('border-border')
    expect(input).toContain('text-[length:var(--fs-body')
    expect(input).toContain('focus-visible:outline-offset-2')
    expect(compact).toContain('h-7')
    expect(compact).toContain('rounded-[20px]')
    // 多行文本框在 pill 形状下退到合并圆角，避免整块变成胶囊
    expect(textarea).toContain('rounded-2xl')
    expect(textarea).toContain('field-sizing-content')
  })

  it('保持原生属性与受控输入；size 只接受尺寸阶梯', () => {
    const onChange = vi.fn()
    render(
      <>
        <Input aria-label="Email" type="email" defaultValue="a@example.com" onChange={onChange} />
        <Textarea aria-label="Bio" size="compact" aria-invalid />
      </>,
    )
    const input = screen.getByRole('textbox', { name: 'Email' })
    input.focus()
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'b@example.com' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    const textarea = screen.getByRole('textbox', { name: 'Bio' })
    expect(textarea.className).toContain('min-h-[64px]')
    expect(textarea.getAttribute('aria-invalid')).toBe('true')
  })
})

describe('Checkbox（Fluid radix/checkbox）', () => {
  it('点击与 Space 切换，Enter 不切换（留给表单提交），不确定态报告 mixed', () => {
    const onCheckedChange = vi.fn()
    render(
      <>
        <Checkbox aria-label="Agree" onCheckedChange={onCheckedChange} />
        <Checkbox aria-label="All" indeterminate />
      </>,
    )
    const box = screen.getByRole('checkbox', { name: 'Agree' })
    expect(box.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(box)
    expect(onCheckedChange).toHaveBeenLastCalledWith(true)
    expect(box.getAttribute('aria-checked')).toBe('true')

    box.focus()
    pressKey(box, ' ')
    expect(onCheckedChange).toHaveBeenLastCalledWith(false)
    pressKey(box, 'Enter')
    expect(onCheckedChange).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('checkbox', { name: 'All' }).getAttribute('aria-checked')).toBe('mixed')
  })

  it('静止边框用 --control-border，焦点环为 2px 描边加间隙', () => {
    const html = renderToString(<Checkbox aria-label="Agree" defaultChecked />)
    expect(html).toContain('border-control-border')
    expect(html).toContain('focus-visible:outline-offset-2')
    expect(html).toContain('aria-checked="true"')
  })
})

describe('Switch（Fluid radix/switch）', () => {
  function Controlled({ onToggle }: { onToggle?: () => void }) {
    const [on, setOn] = useState(false)
    return (
      <Switch
        label="Email alerts"
        checked={on}
        onToggle={() => {
          setOn((v) => !v)
          onToggle?.()
        }}
      />
    )
  }

  it('点击开关或整行各切换一次；键盘 Space / Enter 切换', () => {
    const onToggle = vi.fn()
    render(<Controlled onToggle={onToggle} />)
    const control = screen.getByRole('switch', { name: 'Email alerts' })
    expect(control.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(control)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(control.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByText('Email alerts'))
    expect(onToggle).toHaveBeenCalledTimes(2)
    expect(control.getAttribute('aria-checked')).toBe('false')

    control.focus()
    expect(document.activeElement).toBe(control)
    pressKey(control, ' ')
    expect(control.getAttribute('aria-checked')).toBe('true')
    pressKey(control, 'Enter')
    expect(control.getAttribute('aria-checked')).toBe('false')
  })

  it('关闭态轨道用 --control-border，开启态用强调色；禁用时不响应', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<Switch label="Beta" checked={false} onToggle={onToggle} />)
    const control = screen.getByRole('switch', { name: 'Beta' })
    expect(control.getAttribute('style')).toContain('var(--control-border)')
    rerender(<Switch label="Beta" checked onToggle={onToggle} />)
    expect(control.getAttribute('style')).toContain('var(--fluid-accent)')
    rerender(<Switch label="Beta" checked disabled onToggle={onToggle} />)
    fireEvent.click(control)
    expect(onToggle).not.toHaveBeenCalled()
  })
})

describe('Badge（Fluid badge）', () => {
  it('solid 用色值与页面背景混出的淡底，文字保持正文色；dot 的圆点对读屏隐藏', () => {
    const html = renderToString(
      <>
        <Badge>Draft</Badge>
        <Badge color="green">Active</Badge>
        <Badge variant="dot" color="red">
          Failed
        </Badge>
      </>,
    )
    expect(html).toContain('background-color:var(--accent);color:var(--foreground)')
    expect(html).toContain(
      'color:var(--foreground);background-color:color-mix(in srgb, var(--badge-green) 15%, var(--background))',
    )
    expect(html).toMatch(
      /<span aria-hidden="true" class="shrink-0 rounded-full" style="[^"]*var\(--badge-red\)/,
    )
    // 组件内不写死颜色
    expect(html).not.toMatch(/#[0-9a-f]{6}/i)
  })

  it('跟随 density 与旧尺寸别名', () => {
    const html = renderToString(
      <UiRoot density="compact">
        <Badge>A</Badge>
        <Badge size="lg">B</Badge>
      </UiRoot>,
    )
    const [compact, large] = [...html.matchAll(/class="([^"]*inline-flex[^"]*)"/g)].map((m) => m[1])
    expect(compact).toContain('h-5')
    expect(large).toContain('h-6')
  })
})

describe('Tooltip（Fluid radix/tooltip）', () => {
  it('服务端只输出触发器', () => {
    const html = renderToString(
      <Tooltip content="Copy link">
        <Button>Copy</Button>
      </Tooltip>,
    )
    expect(html).toContain('>Copy</button>')
    expect(html).not.toContain('Copy link')
  })

  it('键盘聚焦打开并关联到触发器，Escape 关闭', async () => {
    render(
      <Tooltip content="Copy link">
        <Button>Copy</Button>
      </Tooltip>,
    )
    const trigger = screen.getByRole('button', { name: 'Copy' })
    act(() => trigger.focus())
    fireEvent.focus(trigger)
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toBe('Copy link')
    expect(trigger.getAttribute('aria-describedby')).toBe(tip.id)

    fireEvent.keyDown(trigger, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  })
})

describe('AlertDialog（shadcn 结构 + Fluid dialog 外观）', () => {
  function Confirm({ onConfirm, onCancel }: { onConfirm?: () => void; onCancel?: () => void }) {
    return (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive">Delete</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除项目？</AlertDialogTitle>
            <AlertDialogDescription>此操作无法撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel {...(onCancel && { onClick: onCancel })}>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" {...(onConfirm && { onClick: onConfirm })}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  it('打开时焦点落在取消按钮，Escape 关闭后焦点回到触发器；没有任何英文默认文案', async () => {
    render(<Confirm />)
    const trigger = screen.getByRole('button', { name: 'Delete' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(dialog.textContent).toBe('删除项目？此操作无法撤销。取消删除')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' })),
    )

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('确认按钮执行回调并关闭', async () => {
    const onConfirm = vi.fn()
    render(<Confirm onConfirm={onConfirm} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const confirm = await screen.findByRole('button', { name: '删除' })
    pressKey(confirm, 'Enter')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('没有 Trigger 的受控确认框（替换 confirm()）关闭后，焦点回到打开前的元素', async () => {
    function RowAction() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <Button onClick={() => setOpen(true)}>Revoke</Button>
          <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogContent>
              <AlertDialogTitle>撤销密钥？</AlertDialogTitle>
              <AlertDialogDescription>使用该密钥的请求会立即失败。</AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction>撤销</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )
    }
    render(<RowAction />)
    const opener = screen.getByRole('button', { name: 'Revoke' })
    opener.focus()
    fireEvent.click(opener)
    await screen.findByRole('alertdialog')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('点击遮罩不关闭', async () => {
    render(<Confirm />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.pointerDown(document.body)
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)))
    expect(dialog.isConnected).toBe(true)
  })
})
