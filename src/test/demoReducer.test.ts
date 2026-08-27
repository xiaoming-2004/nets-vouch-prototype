import { describe, expect, it } from 'vitest'
import { demoReducer, initialState } from '../app/demoReducer'

describe('demoReducer', () => {
  it('starts the consumer journey with no selected tag and an available offer', () => {
    const state = demoReducer(initialState, { type: 'START_OR_RESUME' })

    expect(state.activeScreen).toBe('payment-success')
    expect(state.selectedTag).toBeNull()
    expect(state.offerStatus).toBe('available')
    expect(state.hasStarted).toBe(true)
  })

  it('requires a tag before opening the share sheet', () => {
    const createState = demoReducer(
      demoReducer(initialState, { type: 'START_OR_RESUME' }),
      { type: 'NAVIGATE', screen: 'create-vouch' },
    )

    expect(demoReducer(createState, { type: 'NAVIGATE', screen: 'share-sheet' })).toEqual(createState)

    const selected = demoReducer(createState, { type: 'SELECT_TAG', tag: 'good-value' })
    expect(demoReducer(selected, { type: 'NAVIGATE', screen: 'share-sheet' }).activeScreen).toBe('share-sheet')
  })

  it('enforces claim, payment, redemption, and the next-Vouch cycle', () => {
    const detail = {
      ...initialState,
      activeScreen: 'vouch-detail' as const,
      consumerScreen: 'vouch-detail' as const,
      hasStarted: true,
      selectedTag: 'worth-it' as const,
    }
    const claimed = demoReducer(detail, { type: 'CLAIM_OFFER' })
    expect(claimed.offerStatus).toBe('claimed')
    expect(claimed.activeScreen).toBe('offer-claimed')

    const using = demoReducer(claimed, { type: 'USE_OFFER' })
    expect(using.activeScreen).toBe('use-offer')

    const paying = demoReducer(
      demoReducer(using, { type: 'NAVIGATE', screen: 'darren-payment' }),
      { type: 'BEGIN_PAYMENT' },
    )
    expect(paying.isPaying).toBe(true)

    const redeemed = demoReducer(paying, { type: 'COMPLETE_PAYMENT' })
    expect(redeemed.offerStatus).toBe('redeemed')
    expect(redeemed.activeScreen).toBe('redemption-success')
    expect(demoReducer(redeemed, { type: 'COMPLETE_PAYMENT' })).toEqual(redeemed)

    const nextVouch = demoReducer(redeemed, { type: 'CREATE_NEXT_VOUCH' })
    expect(nextVouch.currentAuthor).toBe('Darren')
    expect(nextVouch.cycleNumber).toBe(2)
    expect(nextVouch.selectedTag).toBeNull()
    expect(nextVouch.activeScreen).toBe('create-vouch')
  })

  it('preserves the consumer location while visiting supporting screens', () => {
    const journey = {
      ...initialState,
      activeScreen: 'vouch-detail' as const,
      consumerScreen: 'vouch-detail' as const,
      hasStarted: true,
    }
    const merchant = demoReducer(journey, { type: 'OPEN_SUPPORT', screen: 'merchant-campaign' })

    expect(merchant.supportingReturnScreen).toBe('vouch-detail')
    expect(demoReducer(merchant, { type: 'CLOSE_SUPPORT' }).activeScreen).toBe('vouch-detail')
  })

  it('requires confirmation before resetting all state', () => {
    const progressed = {
      ...initialState,
      hasStarted: true,
      offerStatus: 'claimed' as const,
    }
    const armed = demoReducer(progressed, { type: 'ARM_RESTART' })
    expect(armed.restartArmed).toBe(true)

    const restarted = demoReducer(armed, { type: 'RESTART' })
    expect(restarted.offerStatus).toBe('available')
    expect(restarted.hasStarted).toBe(false)
    expect(restarted.activeScreen).toBe('demo-home')
  })
})
