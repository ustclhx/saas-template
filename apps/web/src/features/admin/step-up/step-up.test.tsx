// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { baseLocale, overwriteGetLocale } from '../../../paraglide/runtime.js'
import { stepUpRequiredError } from './check.ts'
import { isStepUpCancelled, stepUpRequiredMethods } from './client.ts'
import {
  StepUpProvider,
  StepUpRescueBanner,
  StepUpVerifiedChip,
  useStepUpCall,
} from './step-up-provider.tsx'

Reflect.deleteProperty(Element.prototype, 'animate')

const api = vi.hoisted(() => ({ status: vi.fn(), send: vi.fn(), verify: vi.fn() }))
vi.mock('./step-up.functions.ts', () => ({
  getStepUpStatus: api.status,
  sendStepUpCode: api.send,
  verifyStepUp: api.verify,
}))

type Methods = string[]
/** 浏览器端实际收到的错误：只有 message，可用方式由弹窗读取状态得到 */
const required = (_methods: Methods) => new Error('Re-verify your identity to continue')

function status(methods: Methods, extra: Record<string, unknown> = {}) {
  return {
    verified: null,
    methods,
    rescueMode: false,
    lockedUntil: null,
    email: 'ad***@example.com',
    code: null,
    ...extra,
  }
}

/** 模拟后台表单：填写金额后提交，敏感调用经 useStepUpCall */
function AdjustForm({
  action,
}: {
  action: (input: { data: { amount: string } }) => Promise<string>
}) {
  const [amount, setAmount] = useState('')
  const [result, setResult] = useState('')
  const call = useStepUpCall(action, { action: 'Credit adjustment' })
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void call({ data: { amount } }).then((value) =>
          setResult(isStepUpCancelled(value) ? 'cancelled' : value),
        )
      }}
    >
      <label>
        Amount
        <input value={amount} onChange={(event) => setAmount(event.target.value)} />
      </label>
      <button type="submit">Adjust</button>
      <output>{result}</output>
    </form>
  )
}

function renderForm(action: (input: { data: { amount: string } }) => Promise<string>) {
  return render(
    <StepUpProvider status={null}>
      <AdjustForm action={action} />
    </StepUpProvider>,
  )
}

/** Radix 标签在 mousedown（主键）时切换 */
function pickTab(tab: HTMLElement) {
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false })
}

async function submitAmount(value: string) {
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: 'Adjust' }))
  return screen.findByRole('dialog', { name: "Confirm it's you" })
}

beforeEach(() => {
  overwriteGetLocale(() => baseLocale)
  api.status.mockReset()
  api.send.mockReset()
  api.verify.mockReset()
})
afterEach(cleanup)

describe('stepUpRequiredMethods', () => {
  it('只识别 STEP_UP_REQUIRED，并过滤未知方式', () => {
    expect(
      stepUpRequiredMethods(
        Object.assign(new Error('x'), {
          code: 'STEP_UP_REQUIRED',
          publicDetails: { methods: ['email_otp', 'nope', 'password'] },
        }),
      ),
    ).toEqual(['email_otp', 'password'])
    expect(stepUpRequiredMethods(Object.assign(new Error('x'), { code: 'OTHER' }))).toBeUndefined()
    expect(stepUpRequiredMethods(new Error('plain'))).toBeUndefined()
    // 经 Server Function 传回浏览器的错误只有 message（$TSR/Error 序列化）
    expect(stepUpRequiredMethods(new Error('Re-verify your identity to continue'))).toEqual([])
    expect(stepUpRequiredMethods(stepUpRequiredError(['totp']))).toEqual(['totp'])
    // 服务端只带 details（未公开 publicDetails）时同样可读
    expect(
      stepUpRequiredMethods({ code: 'STEP_UP_REQUIRED', details: { methods: ['totp'] } }),
    ).toEqual(['totp'])
  })
})

describe('useStepUpCall', () => {
  it('被要求验证时弹窗，通过后用同一份参数重试一次并交回结果', async () => {
    api.status.mockResolvedValue(status(['email_otp', 'password']))
    api.verify.mockResolvedValue({
      ok: true,
      method: 'password',
      expiresAt: new Date().toISOString(),
    })
    const action = vi
      .fn()
      .mockRejectedValueOnce(required(['email_otp', 'password']))
      .mockResolvedValue('applied')
    renderForm(action)
    const dialog = await submitAmount('500')
    expect(dialog.textContent).toContain('“Credit adjustment” is a sensitive action.')
    pickTab(await screen.findByRole('tab', { name: 'Password' }))
    fireEvent.change(screen.getByLabelText('Account password'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify and continue' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('applied'))
    expect(api.verify).toHaveBeenCalledWith({ data: { method: 'password', password: 'secret' } })
    expect(action).toHaveBeenCalledTimes(2)
    // 重试使用的就是第一次的参数对象
    expect(action.mock.calls[1]?.[0]).toBe(action.mock.calls[0]?.[0])
    expect(action.mock.calls[1]?.[0]).toEqual({ data: { amount: '500' } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('取消验证时返回取消状态，操作不再执行，表单内容保留', async () => {
    api.status.mockResolvedValue(status(['email_otp']))
    const action = vi.fn().mockRejectedValue(required(['email_otp']))
    renderForm(action)
    await submitAmount('42')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('cancelled'))
    expect(action).toHaveBeenCalledTimes(1)
    expect(api.verify).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('42')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('其他错误原样抛出，不弹窗', async () => {
    const action = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'OTHER' }))
    let caught: unknown
    function Probe() {
      const call = useStepUpCall(action)
      return (
        <button
          type="button"
          onClick={() => void call().catch((error: unknown) => (caught = error))}
        >
          Go
        </button>
      )
    }
    render(
      <StepUpProvider status={null}>
        <Probe />
      </StepUpProvider>,
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    })
    await waitFor(() => expect(caught).toBeInstanceOf(Error))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('StepUpDialog 各方式表单', () => {
  it('两步验证账号：验证器 6 位输入，切换到备用码', async () => {
    api.status.mockResolvedValue(status(['totp', 'backup_code']))
    api.verify.mockResolvedValue({
      ok: false,
      error: 'STEP_UP_INVALID',
      details: { method: 'totp', reason: 'replayed' },
    })
    renderForm(vi.fn().mockRejectedValue(required(['totp', 'backup_code'])))
    await submitAmount('1')
    const code = screen.getByLabelText('6-digit code from your authenticator')
    expect(code.getAttribute('autocomplete')).toBe('one-time-code')
    // 粘贴带空格的验证码：只保留数字
    fireEvent.change(code, { target: { value: '123 456' } })
    expect((code as HTMLInputElement).value).toBe('123456')
    fireEvent.click(screen.getByRole('button', { name: 'Verify and continue' }))
    expect(
      await screen.findByText(
        'That code was just used. Wait for your authenticator to show the next one.',
      ),
    ).toBeTruthy()
    expect(api.verify).toHaveBeenCalledWith({ data: { method: 'totp', code: '123456' } })
    pickTab(screen.getByRole('tab', { name: 'Backup code' }))
    expect(screen.getByLabelText('Backup code')).toBeTruthy()
    expect(screen.getByText('Each backup code works once.')).toBeTruthy()
  })

  it('邮箱验证码：发送后显示收件地址与重发倒计时，错误显示剩余次数', async () => {
    api.status.mockResolvedValue(status(['email_otp', 'password']))
    const resendAt = new Date(Date.now() + 60_000).toISOString()
    api.send.mockResolvedValue({
      ok: true,
      method: 'email_otp',
      email: 'ad***@example.com',
      expiresAt: resendAt,
      resendAt,
    })
    api.verify.mockResolvedValue({
      ok: false,
      error: 'STEP_UP_INVALID',
      details: { method: 'email_otp', attemptsRemaining: 2 },
    })
    renderForm(vi.fn().mockRejectedValue(required(['email_otp', 'password'])))
    await submitAmount('1')
    expect(await screen.findByText('The code will be sent to ad***@example.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    expect(await screen.findByText('Sent to ad***@example.com, valid for 10 minutes')).toBeTruthy()
    expect(api.send).toHaveBeenCalledWith({ data: { method: 'email_otp' } })
    const resend = screen.getByRole('button', { name: /Resend in \d+s/ }) as HTMLButtonElement
    expect(resend.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Email code'), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify and continue' }))
    expect(await screen.findByText('That code is incorrect. 2 attempts left.')).toBeTruthy()
  })

  it('锁定时显示解锁时间并禁用提交', async () => {
    api.status.mockResolvedValue(
      status(['email_otp', 'password'], {
        lockedUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
      }),
    )
    renderForm(vi.fn().mockRejectedValue(required(['email_otp', 'password'])))
    await submitAmount('1')
    expect(await screen.findByText('Too many attempts, temporarily locked')).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Verify and continue' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('救援模式默认选邮箱验证码（救援）并显示说明；没有可用方式时给出应急说明', async () => {
    api.status.mockResolvedValue(status(['totp', 'backup_code', 'rescue'], { rescueMode: true }))
    renderForm(vi.fn().mockRejectedValue(required(['totp', 'backup_code', 'rescue'])))
    await submitAmount('1')
    const rescue = await screen.findByRole('tab', { name: 'Email code (rescue)' })
    expect(rescue.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText(/Rescue mode: your email is on the bootstrap list/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    await waitFor(() => expect(api.send).toHaveBeenCalledWith({ data: { method: 'rescue' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    api.status.mockResolvedValue(status([]))
    fireEvent.click(screen.getByRole('button', { name: 'Adjust' }))
    expect(await screen.findByText('No verification method available')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Verify and continue' })).toBeNull()
  })
})

describe('后台顶部状态', () => {
  it('显示验证剩余分钟与救援警示条；未验证、未开启救援时都不显示', async () => {
    const expiresAt = new Date(Date.now() + 8 * 60_000 - 1000).toISOString()
    const { unmount } = render(
      <StepUpProvider status={{ verified: { method: 'password', expiresAt }, rescueMode: true }}>
        <StepUpRescueBanner />
        <StepUpVerifiedChip />
      </StepUpProvider>,
    )
    expect(await screen.findByText('Verified, 8 min left')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Rescue mode is on')
    unmount()
    render(
      <StepUpProvider status={{ verified: null, rescueMode: false }}>
        <StepUpRescueBanner />
        <StepUpVerifiedChip />
      </StepUpProvider>,
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/Verified,/)).toBeNull()
  })
})
