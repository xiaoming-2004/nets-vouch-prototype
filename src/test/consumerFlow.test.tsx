import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import App from '../App'

async function finishConsent(user: ReturnType<typeof userEvent.setup>, basicMode = false) {
  expect(screen.getByRole('heading', { name: 'Set up Vouch AI' })).toBeInTheDocument()
  if (basicMode) await user.click(screen.getByRole('button', { name: /NETS activity patterns/ }))
  await user.click(screen.getByRole('button', { name: 'Save and continue' }))
}

describe('connected Darren and Felicia MVP', () => {
  beforeEach(() => window.localStorage.clear())

  it('supports Basic Mode, proactive matching and one adjusted recommendation', async () => {
    const user = userEvent.setup()
    render(<App />)
    await finishConsent(user, true)
    expect(screen.getByRole('heading', { name: 'Hi Darren' })).toBeInTheDocument()
    expect(screen.getByText('Transaction analysis is off')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open today’s lunch recommendation' }))
    expect(screen.getByRole('heading', { name: 'One lunch option' })).toBeInTheDocument()
    expect(screen.getByText("Felicia's Chicken Rice")).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Not for me' }))
    await user.click(screen.getByRole('button', { name: /Too far/ }))
    expect(screen.getByText('Chicken Porridge')).toBeInTheDocument()
    expect(screen.getByText(/Too far\. Here is a better fit/)).toBeInTheDocument()
  })

  it('completes recommendation → full-price payment → merchant preparation → collection → optional Vouch', async () => {
    const user = userEvent.setup()
    render(<App />)
    await finishConsent(user)
    await user.click(screen.getByRole('button', { name: 'Open today’s lunch recommendation' }))
    await user.click(screen.getByRole('button', { name: 'Accept and pay' }))
    expect(screen.getByText('You pay the full $7.50. Cashback is recorded separately after an eligible NETS confirmation.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pay $7.50 with NETS' }))
    expect(screen.getByRole('button', { name: 'Processing…' })).toBeDisabled()
    expect(await screen.findByRole('heading', { name: 'Order sent to Felicia' }, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.getAllByText('$0.50 cashback earned')).not.toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'View Felicia’s side' }))
    expect(screen.getByText('$7.50 · Paid with NETS')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start preparing' }))
    await user.click(screen.getByRole('button', { name: 'Mark ready' }))
    await user.click(screen.getByRole('button', { name: 'Return to Darren' }))
    expect(screen.getByRole('heading', { name: 'Ready for collection' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'I collected my order' }))
    expect(screen.getByRole('heading', { name: 'Worth a Vouch?' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Vouch — one tap' }))
    expect(screen.getByRole('heading', { name: 'Hi Darren' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'My Vouches' }))
    expect(screen.getByRole('heading', { name: "Felicia's Chicken Rice" })).toBeInTheDocument()
  }, 12000)

  it('updates Felicia’s attributed campaign results exactly once', async () => {
    const user = userEvent.setup()
    render(<App />)
    await finishConsent(user)
    await user.click(screen.getByRole('button', { name: 'Open today’s lunch recommendation' }))
    await user.click(screen.getByRole('button', { name: 'Accept and pay' }))
    await user.click(screen.getByRole('button', { name: 'Pay $7.50 with NETS' }))
    await screen.findByRole('heading', { name: 'Order sent to Felicia' }, { timeout: 2000 })
    await user.click(screen.getByRole('button', { name: 'View Felicia’s side' }))
    await user.click(screen.getByRole('tab', { name: 'Results' }))
    const panel = screen.getByRole('heading', { name: 'Campaign results' }).closest('section')
    expect(panel).not.toBeNull()
    expect(within(panel!).getByText('20')).toBeInTheDocument()
    expect(within(panel!).getByText('8')).toBeInTheDocument()
    expect(within(panel!).getByText('7')).toBeInTheDocument()
    expect(within(panel!).getByText('$3.50')).toBeInTheDocument()
    expect(within(panel!).getByText('35%')).toBeInTheDocument()
    expect(within(panel!).getByText(/Attribution, not proven incrementality/)).toBeInTheDocument()
  })

  it('retains Scan-to-Pay, Profile and transaction history', async () => {
    const user = userEvent.setup()
    render(<App />)
    await finishConsent(user)
    await user.click(screen.getByRole('button', { name: /Scan to Pay/ }))
    await user.click(screen.getByRole('button', { name: 'Simulate scanning Café ABC QR code' }))
    expect(await screen.findByRole('heading', { name: 'Payment Review' }, { timeout: 2000 })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pay $8.50' }))
    expect(await screen.findByRole('heading', { name: 'Payment Successful' }, { timeout: 2000 })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('button', { name: 'Profile' }))
    expect(screen.getByRole('heading', { name: 'Past Transactions' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View Café ABC transaction, $8.50, Successful' })).toBeInTheDocument()
  })

  it('provides keyboard-operable settings and an accessible dismissible demo dialog', async () => {
    const user = userEvent.setup()
    render(<App />)
    const setting = screen.getByRole('button', { name: /NETS activity patterns/ })
    setting.focus()
    await user.keyboard('{Enter}')
    expect(setting).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: 'Open demo navigator' }))
    expect(screen.getByRole('dialog', { name: 'Choose a view' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Choose a view' })).not.toBeInTheDocument()
  })
})
