import { initialTransactions, initialVouches, merchant, payments } from '../data/mockData'
import { isConsumerScreen } from './navigation'
import type { ConsumerScreen, DemoAction, DemoState, TransactionRecord, VouchRecord } from './types'

const tagLabels = {
  'vouch-pick': 'Vouch Pick',
  'good-value': 'Good Value',
  'worth-it': 'Worth It',
  'good-hangout': 'Good Hangout',
} as const

export function createInitialState(): DemoState {
  return {
    activeScreen: 'main-menu',
    consumerScreen: 'scanner',
    history: [],
    supportingReturnScreen: 'main-menu',
    selectedTag: null,
    currentAuthor: 'Jia',
    currentPersona: 'Jia',
    cycleNumber: 1,
    offerStatus: 'available',
    campaignStatus: 'draft',
    navigatorOpen: false,
    notice: null,
    isScanning: false,
    isPaying: false,
    hasStarted: false,
    restartArmed: false,
    scannedMerchantId: null,
    currentTransactionId: null,
    selectedTransactionId: null,
    transactions: initialTransactions.map((transaction) => ({ ...transaction })),
    vouches: initialVouches.map((vouch) => ({ ...vouch })),
    profileTab: 'transactions',
    lastShareChannel: null,
    transactionSequence: 0,
    vouchSequence: 0,
  }
}

export const initialState: DemoState = createInitialState()

function navigate(state: DemoState, screen: ConsumerScreen): DemoState {
  return {
    ...state,
    activeScreen: screen,
    consumerScreen: screen,
    history: [...state.history, state.activeScreen],
    navigatorOpen: false,
    notice: null,
    hasStarted: true,
    restartArmed: false,
  }
}

function goHome(state: DemoState, notice: string | null = null): DemoState {
  return {
    ...state,
    activeScreen: 'main-menu',
    consumerScreen: 'scanner',
    history: [],
    navigatorOpen: false,
    notice,
    isScanning: false,
    isPaying: false,
    currentAuthor: 'Jia',
    currentPersona: 'Jia',
    cycleNumber: 1,
    restartArmed: false,
  }
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'START_OR_RESUME':
      return {
        ...state,
        activeScreen: state.hasStarted ? state.consumerScreen : 'scanner',
        consumerScreen: state.hasStarted ? state.consumerScreen : 'scanner',
        history: [],
        navigatorOpen: false,
        hasStarted: true,
        notice: null,
      }
    case 'NAVIGATE':
      if (action.screen === 'share-sheet' && !state.selectedTag) return state
      if ((action.screen === 'use-offer' || action.screen === 'darren-payment') && state.offerStatus !== 'claimed') return state
      if (action.screen === 'offer-claimed' && state.offerStatus === 'available') return state
      return navigate(state, action.screen)
    case 'BACK': {
      const history = [...state.history]
      const previous = history.pop() ?? 'main-menu'
      return {
        ...state,
        activeScreen: previous,
        consumerScreen: isConsumerScreen(previous) ? previous : state.consumerScreen,
        history,
        notice: null,
        isScanning: false,
        isPaying: false,
      }
    }
    case 'GO_HOME':
      return goHome(state, action.notice ?? null)
    case 'OPEN_SCAN':
      return {
        ...state,
        activeScreen: 'scanner',
        consumerScreen: 'scanner',
        history: [],
        selectedTag: null,
        currentAuthor: 'Jia',
        currentPersona: 'Jia',
        cycleNumber: 1,
        scannedMerchantId: null,
        currentTransactionId: null,
        selectedTransactionId: null,
        lastShareChannel: null,
        isScanning: false,
        isPaying: false,
        navigatorOpen: false,
        hasStarted: true,
        notice: null,
      }
    case 'SIMULATE_SCAN':
      return state.activeScreen === 'scanner' && !state.isScanning
        ? { ...state, isScanning: true, notice: 'Scanning fictional Café ABC QR code' }
        : state
    case 'COMPLETE_SCAN':
      return state.activeScreen === 'scanner' && state.isScanning
        ? {
            ...state,
            activeScreen: 'payment-review',
            consumerScreen: 'payment-review',
            history: [...state.history, 'scanner'],
            scannedMerchantId: merchant.id,
            isScanning: false,
            notice: 'QR scanned successfully',
          }
        : state
    case 'BEGIN_SCAN_PAYMENT':
      return state.activeScreen === 'payment-review' && state.scannedMerchantId === merchant.id && !state.isPaying
        ? { ...state, isPaying: true, notice: 'Processing simulated NETS payment' }
        : state
    case 'COMPLETE_SCAN_PAYMENT': {
      if (state.activeScreen !== 'payment-review' || !state.isPaying || state.scannedMerchantId !== merchant.id) return state
      const sequence = state.transactionSequence + 1
      const transaction: TransactionRecord = {
        id: `tx-scan-${sequence}`,
        merchantId: merchant.id,
        merchantName: merchant.name,
        outlet: merchant.outlet,
        date: '27 Aug 2026',
        time: 'Just now',
        amount: payments.jia.amount,
        displayAmount: payments.jia.displayAmount,
        status: 'Successful',
        paymentMethod: 'NETS',
        vouchCreated: false,
      }
      return {
        ...state,
        activeScreen: 'payment-success',
        consumerScreen: 'payment-success',
        history: [...state.history, 'payment-review'],
        transactions: [transaction, ...state.transactions],
        currentTransactionId: transaction.id,
        selectedTransactionId: transaction.id,
        currentAuthor: 'Jia',
        currentPersona: 'Jia',
        transactionSequence: sequence,
        isPaying: false,
        notice: 'Payment successful. Transaction saved.',
        hasStarted: true,
      }
    }
    case 'OPEN_PROFILE':
      return {
        ...state,
        activeScreen: 'profile',
        history: [],
        profileTab: action.tab ?? 'transactions',
        currentPersona: 'Jia',
        navigatorOpen: false,
        notice: null,
      }
    case 'OPEN_SAVED_OFFERS':
      return navigate(state, 'my-offers')
    case 'SELECT_TRANSACTION':
      return state.transactions.some((transaction) => transaction.id === action.transactionId)
        ? {
            ...state,
            activeScreen: 'transaction-detail',
            history: [...state.history, state.activeScreen],
            selectedTransactionId: action.transactionId,
            notice: null,
          }
        : state
    case 'START_VOUCH': {
      const transaction = action.transactionId
        ? state.transactions.find((item) => item.id === action.transactionId)
        : null
      if (action.transactionId && (!transaction || transaction.vouchCreated)) return state
      return {
        ...state,
        activeScreen: 'create-vouch',
        consumerScreen: 'create-vouch',
        history: [...state.history, state.activeScreen],
        currentTransactionId: action.transactionId,
        selectedTransactionId: action.transactionId,
        currentAuthor: action.author,
        currentPersona: action.author,
        cycleNumber: action.author === 'Jia' ? 1 : state.cycleNumber,
        selectedTag: null,
        lastShareChannel: null,
        hasStarted: true,
        notice: null,
      }
    }
    case 'SELECT_TAG':
      return { ...state, selectedTag: action.tag, notice: `${tagLabels[action.tag]} selected` }
    case 'SKIP_VOUCH':
      return goHome(state, 'Vouch skipped — payment remains complete')
    case 'COMPLETE_VOUCH': {
      if (state.activeScreen !== 'share-sheet' || !state.selectedTag) return state
      const transaction = state.currentTransactionId
        ? state.transactions.find((item) => item.id === state.currentTransactionId)
        : null
      const shouldSaveToJiaProfile = state.currentAuthor === 'Jia' && transaction && !transaction.vouchCreated
      const sequence = shouldSaveToJiaProfile ? state.vouchSequence + 1 : state.vouchSequence
      const vouch: VouchRecord | null = shouldSaveToJiaProfile
        ? {
            id: `vouch-new-${sequence}`,
            transactionId: transaction.id,
            merchantId: transaction.merchantId,
            merchantName: transaction.merchantName,
            tag: state.selectedTag,
            date: '27 Aug 2026',
            status: action.channel === 'Copy link' ? 'Completed' : 'Shared',
          }
        : null
      return {
        ...state,
        activeScreen: 'vouch-complete',
        consumerScreen: 'vouch-complete',
        history: [...state.history, 'share-sheet'],
        transactions: shouldSaveToJiaProfile
          ? state.transactions.map((item) => item.id === transaction.id ? { ...item, vouchCreated: true } : item)
          : state.transactions,
        vouches: vouch ? [vouch, ...state.vouches] : state.vouches,
        vouchSequence: sequence,
        lastShareChannel: action.channel,
        notice: action.channel === 'Copy link' ? 'Vouch completed and saved' : `Vouch shared via ${action.channel}`,
      }
    }
    case 'CONTINUE_AS_DARREN': {
      const sourceTransaction = state.currentTransactionId
        ? state.transactions.find((item) => item.id === state.currentTransactionId)
        : null
      return state.activeScreen === 'vouch-complete'
        && state.currentAuthor === 'Jia'
        && sourceTransaction?.merchantId === merchant.id
        ? {
            ...state,
            activeScreen: 'whatsapp',
            consumerScreen: 'whatsapp',
            history: [...state.history, 'vouch-complete'],
            currentPersona: 'Darren',
            notice: 'Continuing the demo as Darren',
          }
        : state
    }
    case 'CLAIM_OFFER':
      return state.offerStatus === 'available'
        ? { ...navigate(state, 'offer-claimed'), offerStatus: 'claimed', notice: 'Offer saved' }
        : state
    case 'USE_OFFER':
      return state.offerStatus === 'claimed' ? navigate(state, 'use-offer') : state
    case 'BEGIN_PAYMENT':
      return state.offerStatus === 'claimed' && !state.isPaying
        ? { ...state, isPaying: true, notice: 'Processing simulated NETS payment' }
        : state
    case 'COMPLETE_PAYMENT':
      return state.offerStatus === 'claimed' && state.isPaying
        ? {
            ...navigate({ ...state, isPaying: false }, 'redemption-success'),
            offerStatus: 'redeemed',
            currentPersona: 'Darren',
            notice: 'Payment successful. Offer redeemed.',
          }
        : state
    case 'CREATE_NEXT_VOUCH':
      return {
        ...navigate(state, 'create-vouch'),
        currentAuthor: 'Darren',
        currentPersona: 'Darren',
        currentTransactionId: null,
        selectedTransactionId: null,
        cycleNumber: state.cycleNumber + 1,
        selectedTag: null,
        lastShareChannel: null,
        notice: 'New verified visit — create the next Vouch',
      }
    case 'OPEN_NAVIGATOR':
      return { ...state, navigatorOpen: true, restartArmed: false }
    case 'CLOSE_NAVIGATOR':
      return { ...state, navigatorOpen: false, restartArmed: false }
    case 'OPEN_SUPPORT':
      return {
        ...state,
        activeScreen: action.screen,
        supportingReturnScreen: state.activeScreen,
        navigatorOpen: false,
        history: [],
        notice: null,
      }
    case 'CLOSE_SUPPORT':
      return {
        ...state,
        activeScreen: state.supportingReturnScreen,
        consumerScreen: isConsumerScreen(state.supportingReturnScreen)
          ? state.supportingReturnScreen
          : state.consumerScreen,
        history: [],
        notice: state.supportingReturnScreen === 'main-menu' ? null : 'Previous screen resumed',
      }
    case 'SUPPORT_BACK':
      return state.activeScreen === 'merchant-campaign' && state.history.at(-1) === 'business-logic'
        ? { ...state, activeScreen: 'business-logic', history: [] }
        : goHome(state)
    case 'SUPPORT_NEXT':
      return state.activeScreen === 'business-logic'
        ? { ...state, activeScreen: 'merchant-campaign', history: [...state.history, 'business-logic'] }
        : state
    case 'LAUNCH_CAMPAIGN':
      return state.campaignStatus === 'draft'
        ? { ...state, campaignStatus: 'launched', notice: 'Campaign launched for this demo' }
        : state
    case 'SHOW_NOTICE':
      return { ...state, notice: action.notice }
    case 'CLEAR_NOTICE':
      return { ...state, notice: null }
    case 'ARM_RESTART':
      return { ...state, restartArmed: true, notice: 'Press Restart again to reset the demo' }
    case 'RESTART':
      return { ...createInitialState(), notice: 'Demo restarted' }
    default:
      return state
  }
}
