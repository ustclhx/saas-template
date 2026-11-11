import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CreditEstimate } from '../src/components/credit-estimate.tsx'
import { DailyClaimNotice } from '../src/components/daily-claim-notice.tsx'
import { EmbeddedChat } from '../src/components/embedded-chat.tsx'
import { InsufficientCreditsDialog } from '../src/components/insufficient-credits-dialog.tsx'
import { LockedFeature } from '../src/components/locked-feature.tsx'
import { MessageFeedback, type MessageFeedbackValue } from '../src/components/message-feedback.tsx'
import { SuggestionChips } from '../src/components/suggestion-chips.tsx'

// 业务界面组件（openspec add-ui-design-system tasks 8.6）：渲染与交互。

Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

describe('SuggestionChips', () => {
  it('每个问题一个按钮，点击回调问题文字；为空时不渲染', () => {
    const onSelect = vi.fn()
    const { container, rerender } = render(
      <SuggestionChips
        label="推荐问题"
        suggestions={['总结要点', '列出风险']}
        onSelect={onSelect}
      />,
    )
    const group = screen.getByRole('group', { name: '推荐问题' })
    expect(group.querySelectorAll('button')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '列出风险' }))
    expect(onSelect).toHaveBeenCalledWith('列出风险')
    rerender(<SuggestionChips label="推荐问题" suggestions={[]} onSelect={onSelect} />)
    expect(container.innerHTML).toBe('')
  })

  it('showLabel 显示分组名并以它命名分组；disabled 时按钮不可用', () => {
    render(
      <SuggestionChips
        label="继续追问"
        showLabel
        disabled
        suggestions={['和上季度相比？']}
        onSelect={() => {}}
      />,
    )
    expect(screen.getByText('继续追问').tagName).toBe('SPAN')
    expect(screen.getByRole('group', { name: '继续追问' })).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: '和上季度相比？' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})

const feedbackLabels = {
  group: '评价这条回答',
  up: '有帮助',
  down: '没帮助',
  question: '这条回答哪里不满意？',
  comment: '补充说明（可选）',
  submit: '提交反馈',
  cancel: '取消',
  edit: '修改反馈',
  saved: '感谢反馈',
  failed: '保存失败',
}

/** 模拟调用方：保存成功后把新值传回组件 */
function FeedbackHarness({
  initial = null,
  save,
  reasons,
}: {
  initial?: MessageFeedbackValue | null
  save: (next: MessageFeedbackValue | null) => Promise<void>
  reasons?: { value: string; label: string }[]
}) {
  const [value, setValue] = useState(initial)
  return (
    <MessageFeedback
      value={value}
      labels={feedbackLabels}
      {...(reasons ? { reasons } : {})}
      onChange={async (next) => {
        await save(next)
        setValue(next)
      }}
    />
  )
}

describe('MessageFeedback', () => {
  it('点赞后再次点击即撤销（以 null 回调）', async () => {
    const save = vi.fn(async () => {})
    render(<FeedbackHarness save={save} />)
    const up = screen.getByRole('button', { name: '有帮助' })
    expect(up.getAttribute('aria-pressed')).toBe('false')
    await act(async () => fireEvent.click(up))
    expect(save).toHaveBeenLastCalledWith({ rating: 'up', comment: null })
    expect(up.getAttribute('aria-pressed')).toBe('true')
    await act(async () => fireEvent.click(up))
    expect(save).toHaveBeenLastCalledWith(null)
    expect(up.getAttribute('aria-pressed')).toBe('false')
  })

  it('点踩展开文字反馈，提交后收起并可再次修改', async () => {
    const save = vi.fn(async () => {})
    render(
      <FeedbackHarness
        save={save}
        reasons={[
          { value: 'inaccurate', label: '不准确' },
          { value: 'incomplete', label: '不完整' },
        ]}
      />,
    )
    const down = screen.getByRole('button', { name: '没帮助' })
    await act(async () => fireEvent.click(down))
    expect(save).toHaveBeenLastCalledWith({ rating: 'down', comment: null, reason: null })
    expect(down.getAttribute('aria-expanded')).toBe('true')
    const form = screen.getByRole('form', { name: '这条回答哪里不满意？' })
    fireEvent.click(screen.getByRole('button', { name: '不完整' }))
    expect(screen.getByRole('button', { name: '不完整' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(screen.getByLabelText('补充说明（可选）'), {
      target: { value: '  缺少第三章  ' },
    })
    await act(async () => fireEvent.submit(form))
    expect(save).toHaveBeenLastCalledWith({
      rating: 'down',
      comment: '缺少第三章',
      reason: 'incomplete',
    })
    expect(screen.queryByRole('form')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('感谢反馈')
    expect(document.activeElement).toBe(down)
    // 可修改：重新打开时带出已保存的内容
    fireEvent.click(screen.getByRole('button', { name: '修改反馈' }))
    expect((screen.getByLabelText('补充说明（可选）') as HTMLTextAreaElement).value).toBe(
      '缺少第三章',
    )
    expect(document.activeElement).toBe(screen.getByLabelText('补充说明（可选）'))
    // 取消不保存，焦点回到点踩按钮
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('form')).toBeNull()
    expect(save).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(down)
  })

  it('保存失败时回滚并提示', async () => {
    const save = vi.fn(async () => {
      throw new Error('network')
    })
    render(<FeedbackHarness initial={{ rating: 'up', comment: null }} save={save} />)
    const up = screen.getByRole('button', { name: '有帮助' })
    expect(up.getAttribute('aria-pressed')).toBe('true')
    await act(async () => fireEvent.click(up))
    expect(save).toHaveBeenCalledWith(null)
    expect(up.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('保存失败')
  })

  it('disabled 时评分按钮不可用', () => {
    render(<MessageFeedback value={null} labels={feedbackLabels} disabled onChange={() => {}} />)
    expect((screen.getByRole('button', { name: '有帮助' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: '没帮助' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})

const creditLabels = {
  title: '积分不足',
  description: '这次生成需要的积分超过了当前余额。',
  estimated: '本次预计消耗',
  available: '当前余额',
  credits: (n: number) => `${n} 积分`,
  shortfall: (n: number) => `还差 ${n} 积分。`,
  buyPacks: '购买积分包',
  subscribe: '订阅',
  close: '关闭',
}

function DialogHarness(props: { onBuyPacks: () => void; onSubscribe?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        发送
      </button>
      <InsufficientCreditsDialog
        open={open}
        onOpenChange={setOpen}
        estimatedCredits={30}
        availableCredits={10}
        labels={creditLabels}
        {...props}
      />
    </>
  )
}

describe('InsufficientCreditsDialog', () => {
  it('显示预计消耗、余额与差额，两个入口触发各自回调', () => {
    const onBuyPacks = vi.fn()
    const onSubscribe = vi.fn()
    render(<DialogHarness onBuyPacks={onBuyPacks} onSubscribe={onSubscribe} />)
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    const dialog = screen.getByRole('dialog', { name: '积分不足' })
    expect(dialog.textContent).toContain('本次预计消耗30 积分')
    expect(dialog.textContent).toContain('当前余额10 积分')
    expect(dialog.textContent).toContain('还差 20 积分。')
    fireEvent.click(screen.getByRole('button', { name: '购买积分包' }))
    fireEvent.click(screen.getByRole('button', { name: '订阅' }))
    expect(onBuyPacks).toHaveBeenCalledOnce()
    expect(onSubscribe).toHaveBeenCalledOnce()
  })

  it('焦点进入弹窗，Esc 关闭后回到打开前的元素；未传 onSubscribe 时不显示订阅', async () => {
    render(<DialogHarness onBuyPacks={() => {}} />)
    const opener = screen.getByRole('button', { name: '发送' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: '积分不足' })
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    expect(screen.queryByRole('button', { name: '订阅' })).toBeNull()
    fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
})

const chatLabels = { trigger: '就报告提问', title: '就这份报告提问', close: '关闭' }

function mockViewport(mobile: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: mobile,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
}

describe('EmbeddedChat', () => {
  it('桌面：悬浮按钮打开非模态侧面板，Esc 关闭后焦点回到悬浮按钮', async () => {
    mockViewport(false)
    render(
      <EmbeddedChat labels={chatLabels} footer={<span>本次约 2 积分</span>}>
        <p>对话内容</p>
      </EmbeddedChat>,
    )
    const fab = screen.getByRole('button', { name: '就报告提问' })
    expect(fab.getAttribute('aria-haspopup')).toBe('dialog')
    fab.focus()
    fireEvent.click(fab)
    const panel = screen.getByRole('dialog', { name: '就这份报告提问' })
    expect(panel.getAttribute('data-embedded-chat')).toBe('panel')
    expect(document.querySelector('[data-embedded-chat-overlay]')).toBeNull()
    expect(panel.textContent).toContain('对话内容')
    expect(panel.textContent).toContain('本次约 2 积分')
    // 打开时悬浮按钮隐藏
    expect(fab.className).toContain('invisible')
    // 点击页面其他位置不关闭
    fireEvent.pointerDown(document.body)
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(panel, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(fab)
  })

  it('手机：模态底部抽屉，关闭按钮关闭', async () => {
    mockViewport(true)
    const onOpenChange = vi.fn()
    render(
      <EmbeddedChat labels={chatLabels} onOpenChange={onOpenChange}>
        <p>对话内容</p>
      </EmbeddedChat>,
    )
    fireEvent.click(screen.getByRole('button', { name: '就报告提问' }))
    const sheet = screen.getByRole('dialog', { name: '就这份报告提问' })
    expect(sheet.getAttribute('data-embedded-chat')).toBe('sheet')
    // 模态：有遮罩，页面其余部分对读屏隐藏
    expect(document.querySelector('[data-embedded-chat-overlay]')).toBeTruthy()
    expect(
      document.querySelector('[data-embedded-chat-trigger]')?.closest('[aria-hidden="true"]'),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('服务端渲染只输出悬浮按钮', () => {
    const html = renderToString(
      <EmbeddedChat labels={chatLabels}>
        <p>对话内容</p>
      </EmbeddedChat>,
    )
    expect(html).toContain('就报告提问')
    expect(html).not.toContain('对话内容')
  })
})

describe('LockedFeature', () => {
  it('锁定态不可操作：点击被锁的控件只触发升级回调', () => {
    const onUpgrade = vi.fn()
    const run = vi.fn()
    render(
      <LockedFeature
        title="批量导出报告"
        description="升级后可用。"
        actionLabel="升级到专业版"
        badge="会员"
        onUpgrade={onUpgrade}
      >
        <button type="button" onClick={run}>
          导出全部
        </button>
      </LockedFeature>,
    )
    const region = screen.getByRole('region', { name: '批量导出报告' })
    expect(region.textContent).toContain('会员')
    const locked = region.querySelector('[data-locked-preview] button') as HTMLButtonElement
    fireEvent.click(locked)
    expect(run).not.toHaveBeenCalled()
    expect(onUpgrade).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '升级到专业版' }))
    expect(onUpgrade).toHaveBeenCalledTimes(2)
    expect(locked.closest('[inert]')).toBeTruthy()
  })
})

describe('DailyClaimNotice', () => {
  const labels = { claim: '领取 10 积分', claimed: '今日已领取', dismiss: '关闭提示' }

  it('可领取时显示领取按钮并回调；领取中按钮忙碌', () => {
    const onClaim = vi.fn()
    const { rerender } = render(
      <DailyClaimNotice
        status="available"
        title="今日登录奖励可领取"
        description="每天可领取 10 积分。"
        labels={labels}
        onClaim={onClaim}
      />,
    )
    expect(screen.getByRole('status', { name: '今日登录奖励可领取' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '领取 10 积分' }))
    expect(onClaim).toHaveBeenCalledOnce()
    rerender(
      <DailyClaimNotice
        status="pending"
        title="今日登录奖励可领取"
        description="每天可领取 10 积分。"
        labels={labels}
        onClaim={onClaim}
      />,
    )
    expect(screen.getByRole('button', { name: '领取 10 积分' }).getAttribute('aria-busy')).toBe(
      'true',
    )
  })

  it('已领取显示徽标、不显示领取按钮；错误时显示说明；可关闭', () => {
    const onDismiss = vi.fn()
    const { rerender } = render(
      <DailyClaimNotice
        status="claimed"
        title="已领取今日奖励"
        description="10 积分已到账。"
        labels={labels}
        onClaim={() => {}}
        onDismiss={onDismiss}
      />,
    )
    expect(screen.getByText('今日已领取')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '领取 10 积分' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }))
    expect(onDismiss).toHaveBeenCalledOnce()
    rerender(
      <DailyClaimNotice
        status="error"
        title="今日登录奖励可领取"
        description="每天可领取 10 积分。"
        error="领取失败，请重试。"
        labels={labels}
        onClaim={() => {}}
      />,
    )
    expect(screen.getByText('领取失败，请重试。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '领取 10 积分' })).toBeTruthy()
  })
})

describe('CreditEstimate', () => {
  it('显示预计消耗与余额，余额不足时标记；估算中显示占位', async () => {
    const { container, rerender } = render(
      <CreditEstimate estimate="本次约 3 积分" balance="余额 1,280" />,
    )
    expect(container.textContent).toBe('本次约 3 积分 · 余额 1,280')
    expect(container.firstElementChild?.hasAttribute('data-insufficient')).toBe(false)
    rerender(<CreditEstimate estimate="本次约 30 积分" balance="余额 10" insufficient />)
    expect(container.firstElementChild?.getAttribute('data-insufficient')).toBe('true')
    rerender(<CreditEstimate estimate={null} />)
    expect(container.textContent).toBe('')
    await wait(0)
  })
})
