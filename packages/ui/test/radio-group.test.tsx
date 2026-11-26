import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RadioGroup, RadioItem } from '../src/index.ts'

// happy-dom 的 Web Animations 在取消时抛出未处理的 AbortError；与其他测试一样让 motion 走 JS 动画
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => cleanup())

const REASONS = [
  { value: 'sexual', label: '色情低俗' },
  { value: 'violence', label: '暴力血腥' },
  { value: 'copyright', label: '侵犯版权' },
]

function Reasons({ initial, onChange }: { initial: string; onChange?: (value: string) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <form aria-label="举报">
      <span id="reason-legend">原因</span>
      <RadioGroup
        aria-labelledby="reason-legend"
        name="reason"
        value={value}
        onValueChange={(next) => {
          setValue(next)
          onChange?.(next)
        }}
      >
        {REASONS.map((reason, index) => (
          <RadioItem key={reason.value} index={index} value={reason.value} label={reason.label} />
        ))}
      </RadioGroup>
    </form>
  )
}

describe('RadioGroup（Fluid radix/radio-group）', () => {
  it('radiogroup 带可见标题作为名称，行是 radio，aria-checked 与 roving tabindex 跟随 value', () => {
    render(<Reasons initial="copyright" />)
    const group = screen.getByRole('radiogroup', { name: '原因' })
    // 隐藏的 Radix Item 对辅助技术不可见，每个选项只播报一次
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect(group.getAttribute('tabindex')).toBe('-1')
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true'])
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '-1', '0'])
    expect(screen.getByRole('radio', { name: '侵犯版权' })).toBe(radios[2])
  })

  it('点击与方向键改变选中项（经 onValueChange），表单提交 value', () => {
    const onChange = vi.fn()
    render(<Reasons initial="copyright" onChange={onChange} />)
    const form = screen.getByRole('form', { name: '举报' }) as HTMLFormElement
    expect(new FormData(form).get('reason')).toBe('copyright')

    fireEvent.click(screen.getByRole('radio', { name: '色情低俗' }))
    expect(onChange).toHaveBeenLastCalledWith('sexual')
    expect(screen.getByRole('radio', { name: '色情低俗' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(new FormData(form).get('reason')).toBe('sexual')

    const first = screen.getByRole('radio', { name: '色情低俗' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith('violence')
    const second = screen.getByRole('radio', { name: '暴力血腥' })
    expect(document.activeElement).toBe(second)
    expect(second.getAttribute('tabindex')).toBe('0')
    expect(first.getAttribute('tabindex')).toBe('-1')

    // 两端循环
    fireEvent.keyDown(first, { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith('copyright')
  })

  it('无选中项时第一行是 Tab 停靠点；selectedIndex 与逐项 onSelect 模式可用', () => {
    const onSelect = vi.fn()
    render(
      <RadioGroup aria-label="排序" selectedIndex={-1}>
        <RadioItem index={0} label="最新" onSelect={onSelect} />
        <RadioItem index={1} label="最热" />
      </RadioGroup>,
    )
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1'])
    fireEvent.keyDown(radios[0] as HTMLElement, { key: ' ' })
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('未选中圆圈用 --control-border', () => {
    render(<Reasons initial="copyright" />)
    expect(screen.getByRole('radio', { name: '暴力血腥' }).innerHTML).toContain(
      'border-control-border',
    )
  })

  it('SSR 渲染不抛错', () => {
    const html = renderToString(<Reasons initial="violence" />)
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('aria-checked="true"')
  })
})
