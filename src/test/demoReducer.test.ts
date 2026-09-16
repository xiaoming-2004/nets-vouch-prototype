import { describe, expect, it } from 'vitest'
import { createInitialState, demoReducer } from '../app/demoReducer'
import { clearDemoState, loadDemoState, saveDemoState, STORAGE_KEY } from '../app/persistence'
import type { DemoState } from '../app/types'

function personalisedState(transactionAnalysis = true) {
  return demoReducer(createInitialState(), {
    type: 'SAVE_SETTINGS',
    settings: { recommendations: true, transactionAnalysis, location: true, notifications: true },
  })
}

function acceptedState() {
  let state = personalisedState()
  state = demoReducer(state, { type: 'OPEN_RECOMMENDATION' })
  return demoReducer(state, { type: 'ACCEPT_RECOMMENDATION' })
}

function paidState() {
  let state = acceptedState()
  state = demoReducer(state, { type: 'BEGIN_AI_PAYMENT' })
  return demoReducer(state, { type: 'COMPLETE_AI_PAYMENT' })
}

describe('NETS Vouch AI reducer', () => {
  it('starts at consent and creates independent retained histories', () => {
    const first = createInitialState()
    const second = createInitialState()
    expect(first.activeScreen).toBe('personalisation')
    expect(first.campaign.status).toBe('active')
    expect(first.transactions).toHaveLength(2)
    expect(first.vouches).toHaveLength(1)
    expect(first.transactions).not.toBe(second.transactions)
  })

  it('supports Basic Mode without transaction analysis', () => {
    const state = personalisedState(false)
    expect(state.activeScreen).toBe('main-menu')
    expect(state.settings).toMatchObject({ completed: true, transactionAnalysis: false })
    expect(state.notice).toBe('Basic Mode enabled')
  })

  it('counts a proactive recommendation once and learns one rejection reason', () => {
    let state = personalisedState()
    state = demoReducer(state, { type: 'OPEN_RECOMMENDATION' })
    expect(state.metrics.recommendations).toBe(20)
    state = demoReducer(state, { type: 'BACK' })
    state = demoReducer(state, { type: 'OPEN_RECOMMENDATION' })
    expect(state.metrics.recommendations).toBe(20)
    state = demoReducer(state, { type: 'REJECT_RECOMMENDATION' })
    state = demoReducer(state, { type: 'SELECT_REJECTION_REASON', reason: 'too-far' })
    expect(state.recommendationId).toBe('felicia-porridge')
    expect(state.rejectionReason).toBe('too-far')
  })

  it('charges full price, records cashback separately, and updates metrics once', () => {
    const pending = acceptedState()
    expect(pending.order).toMatchObject({ id: '#104', amount: 7.5, status: 'pending-payment' })
    expect(pending.metrics.accepted).toBe(8)
    let state = demoReducer(pending, { type: 'BEGIN_AI_PAYMENT' })
    state = demoReducer(state, { type: 'COMPLETE_AI_PAYMENT' })
    expect(state.payment).toEqual({ status: 'confirmed', amount: 7.5, cashbackEarned: .5, eligible: true })
    expect(state.order?.status).toBe('paid')
    expect(state.transactions[0]).toMatchObject({ displayAmount: '$7.50', merchantName: "Felicia's Chicken Rice" })
    expect(state.metrics).toMatchObject({ accepted: 8, attributedPayments: 7, cashbackCost: 3.5 })
    expect(demoReducer(state, { type: 'COMPLETE_AI_PAYMENT' })).toEqual(state)
  })

  it('guards merchant preparation, readiness, collection and Vouch creation', () => {
    const paid = paidState()
    expect(demoReducer(paid, { type: 'START_PREPARING' })).toEqual(paid)
    expect(demoReducer(paid, { type: 'MARK_COLLECTED' })).toEqual(paid)
    expect(demoReducer(paid, { type: 'CREATE_VOUCH' })).toEqual(paid)

    let state = demoReducer(paid, { type: 'SWITCH_PERSONA', persona: 'felicia' })
    state = demoReducer(state, { type: 'START_PREPARING' })
    expect(state.order?.status).toBe('preparing')
    state = demoReducer(state, { type: 'MARK_READY' })
    expect(state.order?.status).toBe('ready')
    state = demoReducer(state, { type: 'SWITCH_PERSONA', persona: 'darren' })
    expect(state.activeScreen).toBe('collection-ready')
    state = demoReducer(state, { type: 'MARK_COLLECTED' })
    expect(state.order?.status).toBe('collected')
    const completed = demoReducer(state, { type: 'CREATE_VOUCH' })
    expect(completed.activeScreen).toBe('main-menu')
    expect(completed.vouches[0]).toMatchObject({ transactionId: 'tx-order-104', merchantName: "Felicia's Chicken Rice" })
  })

  it('lets Felicia edit and republish a capped campaign', () => {
    let state = demoReducer(personalisedState(), { type: 'SWITCH_PERSONA', persona: 'felicia' })
    state = demoReducer(state, { type: 'UPDATE_CAMPAIGN', values: { cashback: .75, dailyCap: 10 } })
    expect(state.campaign).toMatchObject({ status: 'draft', cashback: .75, dailyCap: 10, maximumDailyCost: 7.5 })
    state = demoReducer(state, { type: 'PUBLISH_CAMPAIGN' })
    expect(state.campaign.status).toBe('active')
  })

  it('preserves Scan-to-Pay and makes its payment idempotent', () => {
    let state = demoReducer(personalisedState(), { type: 'OPEN_SCAN' })
    state = demoReducer(state, { type: 'SIMULATE_SCAN' })
    state = demoReducer(state, { type: 'COMPLETE_SCAN' })
    state = demoReducer(state, { type: 'BEGIN_SCAN_PAYMENT' })
    const paid = demoReducer(state, { type: 'COMPLETE_SCAN_PAYMENT' })
    expect(paid.activeScreen).toBe('payment-success')
    expect(paid.transactions[0]).toMatchObject({ merchantName: 'Café ABC', displayAmount: '$8.50' })
    expect(demoReducer(paid, { type: 'COMPLETE_SCAN_PAYMENT' })).toEqual(paid)
  })
})

class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
  removeItem(key: string) { this.data.delete(key) }
}

describe('versioned local persistence', () => {
  it('hydrates saved state and resets in-flight processing', () => {
    const storage = new MemoryStorage()
    const processing: DemoState = { ...acceptedState(), payment: { status: 'processing', amount: 7.5, cashbackEarned: 0, eligible: false } }
    saveDemoState(storage, processing)
    const hydrated = loadDemoState(storage)
    expect(hydrated.order?.status).toBe('pending-payment')
    expect(hydrated.payment.status).toBe('idle')
  })

  it('falls back for old versions or malformed JSON and clears restart data', () => {
    const storage = new MemoryStorage()
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 99, activeScreen: 'merchant' }))
    expect(loadDemoState(storage).activeScreen).toBe('personalisation')
    storage.setItem(STORAGE_KEY, '{broken')
    expect(loadDemoState(storage).activeScreen).toBe('personalisation')
    clearDemoState(storage)
    expect(storage.getItem(STORAGE_KEY)).toBeNull()
  })
})
