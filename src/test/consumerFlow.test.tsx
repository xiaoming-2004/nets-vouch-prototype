import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from '../App'

describe('NETS Vouch consumer flow', () => {
  it('completes the story from Jia’s payment to Darren’s next Vouch', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Start journey' }))
    expect(screen.getByRole('heading', { name: 'Payment Successful' })).toBeInTheDocument()
    expect(screen.getByText('$8.50')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Vouch this place' }))
    const shareButton = screen.getByRole('button', { name: 'Share Vouch' })
    expect(shareButton).toBeDisabled()

    await user.click(screen.getByRole('radio', { name: 'Good Value' }))
    expect(shareButton).toBeEnabled()
    await user.click(shareButton)

    expect(screen.getByRole('dialog', { name: 'Share Vouch' })).toBeInTheDocument()
    expect(screen.getByText('Good Value')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(screen.getByText('Demo link copied')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'WhatsApp' }))
    expect(screen.getByText('bro this place quite good HAHA')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'View in NETS' }))

    expect(screen.getByRole('heading', { name: 'A Vouch from a friend' })).toBeInTheDocument()
    expect(screen.getByText('Optional NETS Vouch Offer')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Claim Offer' }))

    expect(screen.getByRole('heading', { name: 'Offer saved' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'View Saved Offer' }))
    expect(screen.getByRole('heading', { name: 'My Offers' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Use Offer' }))
    expect(screen.getByText('Eligible NETS payment required')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pay with NETS' }))
    expect(screen.getByRole('heading', { name: 'Pay Café ABC' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Pay $7.80' }))
    expect(screen.getByRole('button', { name: 'Processing…' })).toBeDisabled()
    expect(await screen.findByRole('heading', { name: 'Payment Successful' }, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.getByText('Vouch Offer Redeemed')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Vouch Café ABC' }))
    expect(screen.getByRole('heading', { name: 'Worth sharing?' })).toBeInTheDocument()
    expect(screen.getByText('Darren can create the next Vouch.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Share Vouch' })).toBeDisabled()
  })

  it('opens supporting demos and resumes the same consumer screen', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Start journey' }))
    await user.click(screen.getByRole('button', { name: 'Vouch this place' }))
    await user.click(screen.getByRole('button', { name: 'Open demo navigator' }))
    await user.click(screen.getByRole('button', { name: /Business logic/i }))

    expect(screen.getByRole('heading', { name: 'How the loop can work' })).toBeInTheDocument()
    expect(screen.getByText('Illustrative published rates. Actual merchant fees vary.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('heading', { name: 'Create Vouch Offer' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Launch Campaign' }))
    expect(screen.getByText('Campaign launched for this demo')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close and resume journey' }))

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Worth sharing?' })).toBeInTheDocument())
  })

  it('closes dialogs from the keyboard, restores focus, and confirms restart', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Start journey' }))
    await user.click(screen.getByRole('button', { name: 'Vouch this place' }))
    await user.click(screen.getByRole('radio', { name: 'Vouch Pick' }))
    const shareButton = screen.getByRole('button', { name: 'Share Vouch' })
    await user.click(shareButton)

    expect(screen.getByRole('dialog', { name: 'Share Vouch' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share Vouch' })).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Open demo navigator' }))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Open demo navigator' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Open demo navigator' }))
    await user.click(screen.getByRole('button', { name: 'Restart demo' }))
    await user.click(screen.getByRole('button', { name: 'Restart now — clear all progress' }))
    expect(screen.getByRole('button', { name: 'Start journey' })).toBeInTheDocument()
  })
})
