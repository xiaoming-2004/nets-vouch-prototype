import { useEffect, useReducer } from 'react'
import { demoReducer } from './app/demoReducer'
import { clearDemoState, loadDemoState, saveDemoState } from './app/persistence'
import { showsBottomNavigation } from './app/navigation'
import { rejectionLabels, recommendations } from './data/mockData'
import { BottomNavigation } from './components/BottomNavigation'
import { DemoNavigator } from './components/DemoNavigator'
import { FeedbackToast } from './components/FeedbackToast'
import { PhoneShell } from './components/PhoneShell'
import { MainMenuScreen } from './screens/MainMenuScreen'
import { PersonalisationScreen } from './screens/PersonalisationScreen'
import { RecommendationScreen } from './screens/RecommendationScreen'
import { RejectionScreen } from './screens/RejectionScreen'
import { ConsumerPaymentScreen } from './screens/ConsumerPaymentScreen'
import { CollectionReadyScreen, OrderStatusScreen } from './screens/OrderJourneyScreens'
import { PostMealVouchScreen } from './screens/PostMealVouchScreen'
import { MerchantWorkspaceScreen } from './screens/MerchantWorkspaceScreen'
import { PaymentReviewScreen } from './screens/PaymentReviewScreen'
import { PaymentSuccessScreen } from './screens/consumer/PaymentSuccessScreen'
import { ProfileScreen } from './screens/ProfileScreen'
import { ScanToPayScreen } from './screens/ScanToPayScreen'
import { TransactionDetailScreen } from './screens/TransactionDetailScreen'

function App() {
  const [state, dispatch] = useReducer(demoReducer, undefined, () => loadDemoState(window.localStorage))

  useEffect(() => { saveDemoState(window.localStorage, state) }, [state])
  useEffect(() => { document.querySelector<HTMLElement>('[data-screen-heading]')?.focus({ preventScroll: true }) }, [state.activeScreen, state.merchantTab])
  useEffect(() => { if (!state.notice) return; const timer = window.setTimeout(() => dispatch({ type: 'CLEAR_NOTICE' }), 2400); return () => window.clearTimeout(timer) }, [state.notice])
  useEffect(() => { if (!state.isScanning) return; const timer = window.setTimeout(() => dispatch({ type: 'COMPLETE_SCAN' }), 650); return () => window.clearTimeout(timer) }, [state.isScanning])
  useEffect(() => {
    if (state.payment.status !== 'processing') return
    const action = state.activeScreen === 'consumer-payment' ? 'COMPLETE_AI_PAYMENT' : 'COMPLETE_SCAN_PAYMENT'
    const timer = window.setTimeout(() => dispatch({ type: action }), 700)
    return () => window.clearTimeout(timer)
  }, [state.activeScreen, state.payment.status])

  const restart = () => { if (state.restartArmed) { clearDemoState(window.localStorage); dispatch({ type: 'RESTART' }) } else dispatch({ type: 'ARM_RESTART' }) }
  const selectedTransaction = state.transactions.find((item) => item.id === state.selectedTransactionId)
  const recommendation = recommendations[state.recommendationId]
  const rejectionNote = state.rejectionReason ? `${rejectionLabels[state.rejectionReason]}. Here is a better fit.` : undefined
  let screen = null

  switch (state.activeScreen) {
    case 'personalisation': screen = <PersonalisationScreen settings={state.settings} onSave={(settings) => dispatch({ type: 'SAVE_SETTINGS', settings })} />; break
    case 'main-menu': screen = <MainMenuScreen transactions={state.transactions} basicMode={!state.settings.transactionAnalysis} recommendationsEnabled={state.settings.recommendations} campaignActive={state.campaign.status === 'active'} orderReady={state.order?.status === 'ready'} onRecommendation={() => state.order?.status === 'ready' ? dispatch({ type: 'SWITCH_PERSONA', persona: 'darren' }) : dispatch({ type: 'OPEN_RECOMMENDATION' })} onSettings={() => dispatch({ type: 'OPEN_SETTINGS' })} onScan={() => dispatch({ type: 'OPEN_SCAN' })} onProfile={(tab) => dispatch({ type: 'OPEN_PROFILE', tab })} onTransaction={(transactionId) => dispatch({ type: 'SELECT_TRANSACTION', transactionId })} />; break
    case 'recommendation': screen = <RecommendationScreen recommendation={recommendation} basicMode={!state.settings.transactionAnalysis} rejectionNote={rejectionNote} onAccept={() => dispatch({ type: 'ACCEPT_RECOMMENDATION' })} onReject={() => dispatch({ type: 'REJECT_RECOMMENDATION' })} onBack={() => dispatch({ type: 'BACK' })} />; break
    case 'rejection': screen = <RejectionScreen onSelect={(reason) => dispatch({ type: 'SELECT_REJECTION_REASON', reason })} onBack={() => dispatch({ type: 'BACK' })} />; break
    case 'consumer-payment': if (state.order) screen = <ConsumerPaymentScreen order={state.order} status={state.payment.status} onPay={() => dispatch({ type: 'BEGIN_AI_PAYMENT' })} onBack={() => dispatch({ type: 'BACK' })} />; break
    case 'order-status': if (state.order) screen = <OrderStatusScreen order={state.order} onMerchant={() => dispatch({ type: 'SWITCH_PERSONA', persona: 'felicia' })} />; break
    case 'collection-ready': if (state.order) screen = <CollectionReadyScreen order={state.order} onCollected={() => dispatch({ type: 'MARK_COLLECTED' })} />; break
    case 'post-meal-vouch': if (state.order) screen = <PostMealVouchScreen order={state.order} onVouch={() => dispatch({ type: 'CREATE_VOUCH' })} onSkip={() => dispatch({ type: 'SKIP_VOUCH' })} />; break
    case 'merchant': screen = <MerchantWorkspaceScreen tab={state.merchantTab} campaign={state.campaign} metrics={state.metrics} order={state.order} onTab={(tab) => dispatch({ type: 'SET_MERCHANT_TAB', tab })} onUpdateCampaign={(values) => dispatch({ type: 'UPDATE_CAMPAIGN', values })} onPublish={() => dispatch({ type: 'PUBLISH_CAMPAIGN' })} onPreparing={() => dispatch({ type: 'START_PREPARING' })} onReady={() => dispatch({ type: 'MARK_READY' })} onDarren={() => dispatch({ type: 'SWITCH_PERSONA', persona: 'darren' })} />; break
    case 'scanner': screen = <ScanToPayScreen scanning={state.isScanning} onScan={() => dispatch({ type: 'SIMULATE_SCAN' })} onBack={() => dispatch({ type: 'GO_HOME' })} />; break
    case 'payment-review': screen = <PaymentReviewScreen isPaying={state.payment.status === 'processing'} onBack={() => dispatch({ type: 'BACK' })} onPay={() => dispatch({ type: 'BEGIN_SCAN_PAYMENT' })} onCancel={() => dispatch({ type: 'GO_HOME', notice: 'Payment cancelled' })} />; break
    case 'payment-success': screen = <PaymentSuccessScreen merchantName={selectedTransaction?.merchantName ?? 'Café ABC'} amount={selectedTransaction?.displayAmount ?? '$8.50'} onDone={() => dispatch({ type: 'GO_HOME', notice: 'Payment complete' })} />; break
    case 'profile': screen = <ProfileScreen activeTab={state.profileTab} transactions={state.transactions} vouches={state.vouches} onTab={(tab) => dispatch({ type: 'OPEN_PROFILE', tab })} onTransaction={(transactionId) => dispatch({ type: 'SELECT_TRANSACTION', transactionId })} onSettings={() => dispatch({ type: 'OPEN_SETTINGS' })} />; break
    case 'transaction-detail': if (selectedTransaction) screen = <TransactionDetailScreen transaction={selectedTransaction} onBack={() => dispatch({ type: 'BACK' })} onViewVouches={() => dispatch({ type: 'OPEN_PROFILE', tab: 'vouches' })} />; break
  }

  const bottomNav = showsBottomNavigation(state.activeScreen)
  return <PhoneShell onOpenDemo={() => dispatch({ type: 'OPEN_NAVIGATOR' })}>
    <div className={bottomNav ? 'phone-content' : 'phone-content phone-content--focused'}><div className="screen-transition" key={`${state.activeScreen}-${state.merchantTab}`}>{screen}</div>{bottomNav ? <BottomNavigation active={state.activeScreen === 'profile' ? 'profile' : 'home'} onHome={() => dispatch({ type: 'GO_HOME' })} onScan={() => dispatch({ type: 'OPEN_SCAN' })} onProfile={() => dispatch({ type: 'OPEN_PROFILE' })} /> : null}</div>
    <FeedbackToast notice={state.notice} />
    {state.navigatorOpen ? <DemoNavigator state={state} onClose={() => dispatch({ type: 'CLOSE_NAVIGATOR' })} onPersona={(persona) => dispatch({ type: 'SWITCH_PERSONA', persona })} onRestart={restart} /> : null}
  </PhoneShell>
}

export default App
