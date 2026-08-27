import { describe, expect, it } from 'vitest'
import { createInitialState, demoReducer } from '../app/demoReducer'

function createCafePayment() {
  let state = demoReducer(createInitialState(), { type: 'OPEN_SCAN' })
  state = demoReducer(state, { type: 'SIMULATE_SCAN' })
  state = demoReducer(state, { type: 'COMPLETE_SCAN' })
  state = demoReducer(state, { type: 'BEGIN_SCAN_PAYMENT' })
  return demoReducer(state, { type: 'COMPLETE_SCAN_PAYMENT' })
}

describe('demoReducer', () => {
  it('starts on the main menu with independent mock transaction and Vouch histories', () => {
    const first = createInitialState()
    const second = createInitialState()

    expect(first.activeScreen).toBe('main-menu')
    expect(first.transactions).toHaveLength(3)
    expect(first.vouches).toHaveLength(2)
    expect(first.offerStatus).toBe('available')
    expect(first.transactions).not.toBe(second.transactions)
    expect(first.vouches).not.toBe(second.vouches)
  })

  it('moves from scanning to review and creates one successful transaction on payment', () => {
    let state = demoReducer(createInitialState(), { type: 'OPEN_SCAN' })
    state = demoReducer(state, { type: 'SIMULATE_SCAN' })
    expect(state.isScanning).toBe(true)

    state = demoReducer(state, { type: 'COMPLETE_SCAN' })
    expect(state.activeScreen).toBe('payment-review')
    expect(state.scannedMerchantId).toBe('cafe-abc')

    state = demoReducer(state, { type: 'BEGIN_SCAN_PAYMENT' })
    const paid = demoReducer(state, { type: 'COMPLETE_SCAN_PAYMENT' })
    expect(paid.activeScreen).toBe('payment-success')
    expect(paid.transactions[0]).toMatchObject({ merchantName: 'Café ABC', displayAmount: '$8.50', vouchCreated: false })
    expect(paid.transactions).toHaveLength(4)

    expect(demoReducer(paid, { type: 'COMPLETE_SCAN_PAYMENT' })).toEqual(paid)
  })

  it('requires a tag, completes a Jia Vouch once, and exposes the optional Darren continuation', () => {
    let state = createCafePayment()
    const transactionId = state.currentTransactionId
    state = demoReducer(state, { type: 'START_VOUCH', transactionId, author: 'Jia' })

    expect(demoReducer(state, { type: 'NAVIGATE', screen: 'share-sheet' })).toEqual(state)
    state = demoReducer(state, { type: 'SELECT_TAG', tag: 'good-value' })
    state = demoReducer(state, { type: 'NAVIGATE', screen: 'share-sheet' })
    state = demoReducer(state, { type: 'COMPLETE_VOUCH', channel: 'WhatsApp' })

    expect(state.activeScreen).toBe('vouch-complete')
    expect(state.vouches[0]).toMatchObject({ merchantName: 'Café ABC', tag: 'good-value', status: 'Shared' })
    expect(state.transactions[0].vouchCreated).toBe(true)

    const darren = demoReducer(state, { type: 'CONTINUE_AS_DARREN' })
    expect(darren.activeScreen).toBe('whatsapp')
    expect(darren.currentPersona).toBe('Darren')
  })

  it('supports the transaction-detail fallback and resets to the original mock records', () => {
    let state = demoReducer(createInitialState(), { type: 'OPEN_PROFILE', tab: 'transactions' })
    state = demoReducer(state, { type: 'SELECT_TRANSACTION', transactionId: 'tx-hawker-001' })
    state = demoReducer(state, { type: 'START_VOUCH', transactionId: 'tx-hawker-001', author: 'Jia' })
    expect(state.activeScreen).toBe('create-vouch')
    expect(state.currentTransactionId).toBe('tx-hawker-001')

    const armed = demoReducer({ ...state, offerStatus: 'claimed', campaignStatus: 'launched' }, { type: 'ARM_RESTART' })
    const restarted = demoReducer(armed, { type: 'RESTART' })
    expect(restarted.activeScreen).toBe('main-menu')
    expect(restarted.transactions).toHaveLength(3)
    expect(restarted.vouches).toHaveLength(2)
    expect(restarted.offerStatus).toBe('available')
    expect(restarted.campaignStatus).toBe('draft')
  })

  it('preserves the existing offer, redemption, next-Vouch, and supporting-screen state rules', () => {
    const detail = {
      ...createInitialState(),
      activeScreen: 'vouch-detail' as const,
      consumerScreen: 'vouch-detail' as const,
      selectedTag: 'worth-it' as const,
      hasStarted: true,
    }
    const supporting = demoReducer(detail, { type: 'OPEN_SUPPORT', screen: 'business-logic' })
    expect(demoReducer(supporting, { type: 'CLOSE_SUPPORT' }).activeScreen).toBe('vouch-detail')

    const claimed = demoReducer(detail, { type: 'CLAIM_OFFER' })
    const using = demoReducer(claimed, { type: 'USE_OFFER' })
    const payment = demoReducer(demoReducer(using, { type: 'NAVIGATE', screen: 'darren-payment' }), { type: 'BEGIN_PAYMENT' })
    const redeemed = demoReducer(payment, { type: 'COMPLETE_PAYMENT' })

    expect(redeemed.offerStatus).toBe('redeemed')
    expect(redeemed.activeScreen).toBe('redemption-success')
    expect(demoReducer(redeemed, { type: 'USE_OFFER' })).toEqual(redeemed)

    const next = demoReducer(redeemed, { type: 'CREATE_NEXT_VOUCH' })
    expect(next).toMatchObject({ activeScreen: 'create-vouch', currentAuthor: 'Darren', currentPersona: 'Darren', cycleNumber: 2, selectedTag: null })
  })
})
