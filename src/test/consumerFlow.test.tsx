import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from '../App'

async function payAtCafe(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Scan to Pay' }))
  expect(screen.getByRole('heading', { name: 'Scan to Pay' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Simulate scanning Café ABC QR code' }))
  expect(await screen.findByRole('heading', { name: 'Payment Review' }, { timeout: 2000 })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Pay $8.50' }))
  expect(screen.getByRole('button', { name: 'Processing…' })).toBeDisabled()
  expect(await screen.findByRole('heading', { name: 'Payment Successful' }, { timeout: 2000 })).toBeInTheDocument()
}

async function completeCafeVouch(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Vouch this place' }))
  const share = screen.getByRole('button', { name: 'Share Vouch' })
  expect(share).toBeDisabled()
  await user.click(screen.getByRole('radio', { name: 'Good Value' }))
  expect(share).toBeEnabled()
  await user.click(share)
  expect(screen.getByRole('dialog', { name: 'Share Vouch' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'WhatsApp' }))
  expect(screen.getByRole('heading', { name: 'Vouch shared' })).toBeInTheDocument()
}

describe('NETS Vouch scan, profile, and consumer flows', () => {
  it('starts on Main Menu and supports Scan → review → Pay → Done → Profile transaction history', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Hi Jia' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Scan to Pay' }))
    await user.click(screen.getByRole('button', { name: 'Simulate scanning Café ABC QR code' }))
    expect(await screen.findByRole('heading', { name: 'Payment Review' }, { timeout: 2000 })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('heading', { name: 'Hi Jia' })).toBeInTheDocument()

    await payAtCafe(user)
    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.getByRole('heading', { name: 'Hi Jia' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Profile' }))
    expect(screen.getByRole('heading', { name: 'Past Transactions' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View Café ABC transaction, $8.50, Successful' })).toBeInTheDocument()
  })

  it('returns home from Not now and saves a completed Vouch in Jia’s My Vouches', async () => {
    const user = userEvent.setup()
    render(<App />)
    await payAtCafe(user)

    await user.click(screen.getByRole('button', { name: 'Vouch this place' }))
    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.getByRole('heading', { name: 'Hi Jia' })).toBeInTheDocument()

    await payAtCafe(user)
    await completeCafeVouch(user)
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('button', { name: 'My Vouches' }))

    expect(screen.getByRole('tab', { name: /My Vouches/ })).toHaveAttribute('aria-selected', 'true')
    const cafeCard = screen.getByRole('heading', { name: 'Café ABC' }).closest('article')
    expect(cafeCard).not.toBeNull()
    expect(within(cafeCard!).getByText('Good Value')).toBeInTheDocument()
    expect(within(cafeCard!).getByText('Verified NETS Visit')).toBeInTheDocument()
  }, 10000)

  it('continues from Vouch completion through the preserved Darren offer and next-Vouch loop', async () => {
    const user = userEvent.setup()
    render(<App />)
    await payAtCafe(user)
    await completeCafeVouch(user)

    await user.click(screen.getByRole('button', { name: 'Continue demo as Darren' }))
    expect(screen.getByText('bro this place quite good HAHA')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'View in NETS' }))
    expect(screen.getByText('Optional NETS Vouch Offer')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Claim Offer' }))
    await user.click(screen.getByRole('button', { name: 'View Saved Offer' }))
    expect(screen.getByRole('heading', { name: 'Saved Offers' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Use Offer' }))
    await user.click(screen.getByRole('button', { name: 'Pay with NETS' }))
    await user.click(screen.getByRole('button', { name: 'Pay $7.80' }))

    expect(await screen.findByText('Vouch Offer Redeemed', {}, { timeout: 2000 })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Vouch Café ABC' }))
    expect(screen.getByText('Darren can create the next Vouch.')).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Worth It' }))
    await user.click(screen.getByRole('button', { name: 'Share Vouch' }))
    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(screen.getByRole('heading', { name: 'Vouch completed' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByRole('heading', { name: 'Hi Jia' })).toBeInTheDocument()
  }, 12000)

  it('supports Profile tabs, bottom navigation, and transaction-detail fallback Vouching', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Profile' }))
    await user.click(screen.getByRole('button', { name: 'Home' }))
    expect(screen.getByRole('heading', { name: 'Hi Jia' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Scan' }))
    expect(screen.getByRole('heading', { name: 'Scan to Pay' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Go back' }))
    await user.click(screen.getByRole('button', { name: 'Profile' }))
    const vouchesTab = screen.getByRole('tab', { name: /My Vouches/ })
    await user.click(vouchesTab)
    expect(vouchesTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'Toast & Co.' })).toBeInTheDocument()

    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: /Past Transactions/ })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('button', { name: 'View Hawker 88 transaction, $6.80, Successful' }))
    expect(screen.getByRole('heading', { name: 'Transaction Detail' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Vouch this merchant' }))
    expect(screen.getByRole('heading', { name: 'Vouch for Hawker 88' })).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Vouch Pick' }))
    await user.click(screen.getByRole('button', { name: 'Share Vouch' }))
    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('button', { name: 'Profile' }))
    await user.click(screen.getByRole('tab', { name: /My Vouches/ }))
    expect(screen.getByRole('heading', { name: 'Hawker 88' })).toBeInTheDocument()
  })

  it('keeps Saved Offers distinct, preserves supporting screens, and resets all demo records', async () => {
    const user = userEvent.setup()
    render(<App />)

    await payAtCafe(user)
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('button', { name: 'Saved Offers' }))
    expect(screen.getByRole('heading', { name: 'Saved Offers' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'No saved offers yet' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Go back' }))

    await user.click(screen.getByRole('button', { name: 'Profile' }))
    await user.click(screen.getByRole('button', { name: 'Open demo navigator' }))
    await user.click(screen.getByRole('button', { name: /Business logic/i }))
    expect(screen.getByText('Illustrative published rates. Actual merchant fees vary.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(screen.getByRole('button', { name: 'Launch Campaign' }))
    expect(screen.getByText('Campaign launched for this demo')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close and resume journey' }))
    expect(screen.getByRole('heading', { name: 'Jia' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open demo navigator' }))
    await user.click(screen.getByRole('button', { name: 'Restart demo' }))
    await user.click(screen.getByRole('button', { name: 'Restart now — clear all progress' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Hi Jia' })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Profile' }))
    expect(screen.getByRole('tab', { name: 'Past Transactions 3' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'My Vouches 2' })).toBeInTheDocument()
  })
})
