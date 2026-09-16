import { createInitialState } from './demoReducer'
import type { DemoState } from './types'

export const STORAGE_KEY = 'nets-vouch-ai-demo:v1'

export function loadDemoState(storage: Pick<Storage, 'getItem'>): DemoState {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return createInitialState()
    const parsed = JSON.parse(raw) as Partial<DemoState>
    if (parsed.version !== 1) return createInitialState()
    const fallback = createInitialState()
    return {
      ...fallback,
      ...parsed,
      settings: { ...fallback.settings, ...parsed.settings },
      campaign: { ...fallback.campaign, ...parsed.campaign },
      metrics: { ...fallback.metrics, ...parsed.metrics },
      payment: { ...fallback.payment, ...parsed.payment },
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : fallback.transactions,
      vouches: Array.isArray(parsed.vouches) ? parsed.vouches : fallback.vouches,
    }
  } catch {
    return createInitialState()
  }
}

export function saveDemoState(storage: Pick<Storage, 'setItem'>, state: DemoState) {
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...state, notice: null, navigatorOpen: false, restartArmed: false, payment: state.payment.status === 'processing' ? { ...state.payment, status: 'idle' } : state.payment }))
}

export function clearDemoState(storage: Pick<Storage, 'removeItem'>) { storage.removeItem(STORAGE_KEY) }
