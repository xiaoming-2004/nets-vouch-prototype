import { initialTransactions, initialVouches, merchant, merchants, recommendations } from '../data/mockData'
import type { DemoAction, DemoState, Order, ScreenId, TransactionRecord, VouchRecord } from './types'

export function createInitialState(): DemoState {
  return {
    version: 1, activeScreen: 'personalisation', history: [], persona: 'darren', merchantTab: 'setup', navigatorOpen: false, restartArmed: false, notice: null,
    settings: { completed: false, recommendations: true, transactionAnalysis: true, location: true, notifications: true },
    recommendationId: 'felicia-chicken-rice', recommendationCounted: false, rejectionReason: null,
    campaign: { status: 'active', cashback: 0.5, minimumSpend: 7, window: '11:30 AM–1:30 PM', dailyCap: 20, maximumDailyCost: 10 },
    metrics: { recommendations: 19, accepted: 7, attributedPayments: 6, cashbackCost: 3 },
    order: null, payment: { status: 'idle', amount: 0, cashbackEarned: 0, eligible: false }, cashbackRecorded: false, vouchUnlocked: false, mealCompleted: false,
    isScanning: false, scannedMerchantId: null, currentTransactionId: null, selectedTransactionId: null,
    transactions: initialTransactions.map((item) => ({ ...item })), vouches: initialVouches.map((item) => ({ ...item })), profileTab: 'transactions', transactionSequence: 0, vouchSequence: 0,
  }
}

export const initialState = createInitialState()

function navigate(state: DemoState, screen: ScreenId): DemoState {
  return { ...state, activeScreen: screen, history: [...state.history, state.activeScreen], notice: null, navigatorOpen: false }
}

function home(state: DemoState, notice: string | null = null): DemoState {
  return { ...state, activeScreen: 'main-menu', history: [], persona: 'darren', navigatorOpen: false, restartArmed: false, notice, isScanning: false }
}

function screenForDarren(state: DemoState): ScreenId {
  if (state.order?.status === 'ready') return 'collection-ready'
  if (state.order && ['paid', 'preparing'].includes(state.order.status)) return 'order-status'
  return 'main-menu'
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'SAVE_SETTINGS': return { ...state, settings: { ...action.settings, completed: true }, activeScreen: 'main-menu', history: [], notice: action.settings.transactionAnalysis ? 'Personalised recommendations enabled' : 'Basic Mode enabled' }
    case 'OPEN_SETTINGS': return navigate(state, 'personalisation')
    case 'OPEN_RECOMMENDATION': {
      if (!state.settings.recommendations || state.campaign.status !== 'active') return { ...state, notice: state.settings.recommendations ? 'No active participating offer' : 'Recommendations are turned off' }
      return { ...navigate(state, 'recommendation'), recommendationCounted: true, metrics: state.recommendationCounted ? state.metrics : { ...state.metrics, recommendations: state.metrics.recommendations + 1 } }
    }
    case 'REJECT_RECOMMENDATION': return navigate(state, 'rejection')
    case 'SELECT_REJECTION_REASON': return { ...state, rejectionReason: action.reason, recommendationId: 'felicia-porridge', activeScreen: 'recommendation', history: [...state.history, 'rejection'], notice: 'Recommendation adjusted' }
    case 'ACCEPT_RECOMMENDATION': {
      if (state.order || !state.settings.recommendations || state.campaign.status !== 'active') return state
      const item = recommendations[state.recommendationId]
      const order: Order = { id: '#104', recommendationId: item.id, merchantId: item.merchantId, merchantName: item.merchantName, itemName: item.itemName, amount: item.price, displayAmount: item.displayPrice, status: 'pending-payment' }
      return { ...navigate(state, 'consumer-payment'), order, metrics: { ...state.metrics, accepted: state.metrics.accepted + 1 } }
    }
    case 'BEGIN_AI_PAYMENT': return state.order?.status === 'pending-payment' && state.payment.status === 'idle' ? { ...state, payment: { ...state.payment, status: 'processing' }, notice: 'Processing simulated NETS payment' } : state
    case 'COMPLETE_AI_PAYMENT': {
      if (!state.order || state.order.status !== 'pending-payment' || state.payment.status !== 'processing') return state
      const transaction: TransactionRecord = { id: 'tx-order-104', merchantId: state.order.merchantId, merchantName: state.order.merchantName, outlet: merchants.felicia.outlet, date: '2 Sep 2026', time: 'Just now', amount: state.order.amount, displayAmount: state.order.displayAmount, status: 'Successful', paymentMethod: 'NETS', vouchCreated: false }
      return { ...state, activeScreen: 'order-status', history: [...state.history, 'consumer-payment'], order: { ...state.order, status: 'paid' }, payment: { status: 'confirmed', amount: state.order.amount, cashbackEarned: state.campaign.cashback, eligible: true }, cashbackRecorded: true, vouchUnlocked: true, transactions: [transaction, ...state.transactions], currentTransactionId: transaction.id, metrics: { ...state.metrics, attributedPayments: state.metrics.attributedPayments + 1, cashbackCost: state.metrics.cashbackCost + state.campaign.cashback }, notice: '$0.50 cashback earned' }
    }
    case 'START_PREPARING': return state.persona === 'felicia' && state.order?.status === 'paid' ? { ...state, order: { ...state.order, status: 'preparing' }, notice: 'Order #104 is preparing' } : state
    case 'MARK_READY': return state.persona === 'felicia' && state.order?.status === 'preparing' ? { ...state, order: { ...state.order, status: 'ready' }, notice: 'Darren has been notified' } : state
    case 'MARK_COLLECTED': return state.persona === 'darren' && state.order?.status === 'ready' ? { ...state, order: { ...state.order, status: 'collected' }, activeScreen: 'post-meal-vouch', history: [...state.history, 'collection-ready'], mealCompleted: true, notice: 'Order collected · After lunch' } : state
    case 'COMPLETE_MEAL': return state.order?.status === 'collected' ? { ...state, mealCompleted: true, activeScreen: 'post-meal-vouch' } : state
    case 'CREATE_VOUCH': {
      if (!state.vouchUnlocked || !state.mealCompleted || state.order?.status !== 'collected' || !state.currentTransactionId) return state
      if (state.vouches.some((item) => item.transactionId === state.currentTransactionId)) return home(state, 'Vouch already saved')
      const vouch: VouchRecord = { id: `vouch-${state.vouchSequence + 1}`, transactionId: state.currentTransactionId, merchantId: state.order.merchantId, merchantName: state.order.merchantName, tag: 'worth-it', date: '2 Sep 2026', status: 'Completed' }
      return home({ ...state, vouches: [vouch, ...state.vouches], vouchSequence: state.vouchSequence + 1, transactions: state.transactions.map((item) => item.id === state.currentTransactionId ? { ...item, vouchCreated: true } : item) }, 'Payment-Verified Vouch saved')
    }
    case 'SKIP_VOUCH': return home(state, 'Vouch skipped')
    case 'SWITCH_PERSONA': return action.persona === 'felicia' ? { ...state, persona: 'felicia', activeScreen: 'merchant', history: [], merchantTab: state.order ? 'orders' : 'setup', navigatorOpen: false, notice: null } : { ...state, persona: 'darren', activeScreen: screenForDarren(state), history: [], navigatorOpen: false, notice: null }
    case 'SET_MERCHANT_TAB': return state.persona === 'felicia' ? { ...state, merchantTab: action.tab, notice: null } : state
    case 'UPDATE_CAMPAIGN': {
      if (state.persona !== 'felicia') return state
      const cashback = action.values.cashback ?? state.campaign.cashback
      const dailyCap = action.values.dailyCap ?? state.campaign.dailyCap
      return { ...state, campaign: { ...state.campaign, ...action.values, status: 'draft', maximumDailyCost: cashback * dailyCap }, notice: 'Offer changes saved as draft' }
    }
    case 'PUBLISH_CAMPAIGN': return state.campaign.status === 'draft' ? { ...state, campaign: { ...state.campaign, status: 'active' }, notice: 'Illustrative campaign published' } : state
    case 'BACK': { const history = [...state.history]; return { ...state, activeScreen: history.pop() ?? 'main-menu', history, notice: null, isScanning: false } }
    case 'GO_HOME': return home(state, action.notice ?? null)
    case 'OPEN_SCAN': return { ...navigate(state, 'scanner'), isScanning: false, scannedMerchantId: null }
    case 'SIMULATE_SCAN': return state.activeScreen === 'scanner' && !state.isScanning ? { ...state, isScanning: true, notice: 'Scanning fictional Café ABC QR code' } : state
    case 'COMPLETE_SCAN': return state.activeScreen === 'scanner' && state.isScanning ? { ...state, activeScreen: 'payment-review', history: [...state.history, 'scanner'], isScanning: false, scannedMerchantId: merchant.id, notice: 'QR scanned successfully' } : state
    case 'BEGIN_SCAN_PAYMENT': return state.activeScreen === 'payment-review' && state.scannedMerchantId === merchant.id && state.payment.status !== 'processing' ? { ...state, payment: { ...state.payment, status: 'processing' }, notice: 'Processing simulated NETS payment' } : state
    case 'COMPLETE_SCAN_PAYMENT': {
      if (state.activeScreen !== 'payment-review' || state.payment.status !== 'processing') return state
      const sequence = state.transactionSequence + 1
      const transaction: TransactionRecord = { id: `tx-scan-${sequence}`, merchantId: merchant.id, merchantName: merchant.name, outlet: merchant.outlet, date: '2 Sep 2026', time: 'Just now', amount: 8.5, displayAmount: '$8.50', status: 'Successful', paymentMethod: 'NETS', vouchCreated: false }
      return { ...state, activeScreen: 'payment-success', history: [...state.history, 'payment-review'], transactions: [transaction, ...state.transactions], selectedTransactionId: transaction.id, currentTransactionId: transaction.id, transactionSequence: sequence, payment: { status: 'idle', amount: 0, cashbackEarned: 0, eligible: false }, notice: 'Payment successful' }
    }
    case 'OPEN_PROFILE': return { ...state, activeScreen: 'profile', history: [], profileTab: action.tab ?? 'transactions', persona: 'darren', navigatorOpen: false, notice: null }
    case 'SELECT_TRANSACTION': return state.transactions.some((item) => item.id === action.transactionId) ? { ...navigate(state, 'transaction-detail'), selectedTransactionId: action.transactionId } : state
    case 'OPEN_NAVIGATOR': return { ...state, navigatorOpen: true, restartArmed: false }
    case 'CLOSE_NAVIGATOR': return { ...state, navigatorOpen: false, restartArmed: false }
    case 'SHOW_NOTICE': return { ...state, notice: action.notice }
    case 'CLEAR_NOTICE': return { ...state, notice: null }
    case 'ARM_RESTART': return { ...state, restartArmed: true, notice: 'Press Restart again to reset the demo' }
    case 'RESTART': return { ...createInitialState(), notice: 'Demo restarted' }
    default: return state
  }
}
