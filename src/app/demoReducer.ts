import { isConsumerScreen } from './navigation'
import type { ConsumerScreen, DemoAction, DemoState } from './types'

export const initialState: DemoState = {
  activeScreen: 'demo-home',
  consumerScreen: 'payment-success',
  history: [],
  supportingReturnScreen: 'demo-home',
  selectedTag: null,
  currentAuthor: 'Jia',
  cycleNumber: 1,
  offerStatus: 'available',
  campaignStatus: 'draft',
  navigatorOpen: false,
  notice: null,
  isPaying: false,
  hasStarted: false,
  restartArmed: false,
}

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

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'START_OR_RESUME':
      return {
        ...state,
        activeScreen: state.hasStarted ? state.consumerScreen : 'payment-success',
        consumerScreen: state.hasStarted ? state.consumerScreen : 'payment-success',
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
      const previous = history.pop() ?? 'demo-home'
      return {
        ...state,
        activeScreen: previous,
        consumerScreen: isConsumerScreen(previous) ? previous : state.consumerScreen,
        history,
        notice: null,
      }
    }
    case 'GO_HOME':
      return {
        ...state,
        activeScreen: 'demo-home',
        history: [],
        navigatorOpen: false,
        notice: action.notice ?? null,
      }
    case 'SELECT_TAG':
      return { ...state, selectedTag: action.tag, notice: `${action.tag.replaceAll('-', ' ')} selected` }
    case 'SKIP_VOUCH':
      return {
        ...state,
        activeScreen: 'payment-success',
        consumerScreen: 'payment-success',
        history: [],
        notice: 'Vouch skipped — payment remains complete',
      }
    case 'CLAIM_OFFER':
      return state.offerStatus === 'available'
        ? { ...navigate(state, 'offer-claimed'), offerStatus: 'claimed', notice: 'Offer saved' }
        : state
    case 'USE_OFFER':
      return state.offerStatus === 'claimed' ? navigate(state, 'use-offer') : state
    case 'BEGIN_PAYMENT':
      return state.offerStatus === 'claimed'
        ? { ...state, isPaying: true, notice: 'Processing simulated NETS payment' }
        : state
    case 'COMPLETE_PAYMENT':
      return state.offerStatus === 'claimed'
        ? {
            ...navigate({ ...state, isPaying: false }, 'redemption-success'),
            offerStatus: 'redeemed',
            notice: 'Payment successful. Offer redeemed.',
          }
        : state
    case 'CREATE_NEXT_VOUCH':
      return {
        ...navigate(state, 'create-vouch'),
        currentAuthor: 'Darren',
        cycleNumber: state.cycleNumber + 1,
        selectedTag: null,
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
        supportingReturnScreen: isConsumerScreen(state.activeScreen)
          ? state.activeScreen
          : state.activeScreen === 'demo-home'
            ? 'demo-home'
            : state.supportingReturnScreen,
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
        notice: state.supportingReturnScreen === 'demo-home' ? null : 'Consumer journey resumed',
      }
    case 'SUPPORT_BACK':
      return state.activeScreen === 'merchant-campaign' && state.history.at(-1) === 'business-logic'
        ? { ...state, activeScreen: 'business-logic', history: [] }
        : { ...state, activeScreen: 'demo-home', history: [], notice: null }
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
      return { ...initialState, notice: 'Demo restarted' }
    default:
      return state
  }
}
