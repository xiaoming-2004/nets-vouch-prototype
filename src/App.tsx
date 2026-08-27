import { useEffect, useReducer } from 'react'
import { demoReducer, initialState } from './app/demoReducer'
import { showsBottomNavigation } from './app/navigation'
import type { SupportingScreen } from './app/types'
import { BottomNavigation } from './components/BottomNavigation'
import { DemoNavigator } from './components/DemoNavigator'
import { FeedbackToast } from './components/FeedbackToast'
import { PhoneShell } from './components/PhoneShell'
import { merchant, payments } from './data/mockData'
import { MainMenuScreen } from './screens/MainMenuScreen'
import { PaymentReviewScreen } from './screens/PaymentReviewScreen'
import { ProfileScreen } from './screens/ProfileScreen'
import { ScanToPayScreen } from './screens/ScanToPayScreen'
import { TransactionDetailScreen } from './screens/TransactionDetailScreen'
import { BusinessLogicScreen } from './screens/supporting/BusinessLogicScreen'
import { MerchantCampaignScreen } from './screens/supporting/MerchantCampaignScreen'
import { CreateVouchScreen } from './screens/consumer/CreateVouchScreen'
import { DarrenPaymentScreen } from './screens/consumer/DarrenPaymentScreen'
import { MyOffersScreen } from './screens/consumer/MyOffersScreen'
import { OfferClaimedScreen } from './screens/consumer/OfferClaimedScreen'
import { PaymentSuccessScreen } from './screens/consumer/PaymentSuccessScreen'
import { RedemptionSuccessScreen } from './screens/consumer/RedemptionSuccessScreen'
import { ShareSheetScreen } from './screens/consumer/ShareSheetScreen'
import { UseOfferScreen } from './screens/consumer/UseOfferScreen'
import { VouchCompleteScreen } from './screens/consumer/VouchCompleteScreen'
import { VouchDetailScreen } from './screens/consumer/VouchDetailScreen'
import { WhatsAppScreen } from './screens/consumer/WhatsAppScreen'

function App() {
  const [state, dispatch] = useReducer(demoReducer, initialState)

  useEffect(() => {
    document.querySelector<HTMLElement>('[data-screen-heading]')?.focus({ preventScroll: true })
  }, [state.activeScreen])

  useEffect(() => {
    if (!state.notice) return
    const timer = window.setTimeout(() => dispatch({ type: 'CLEAR_NOTICE' }), 2400)
    return () => window.clearTimeout(timer)
  }, [state.notice])

  useEffect(() => {
    if (!state.isScanning) return
    const timer = window.setTimeout(() => dispatch({ type: 'COMPLETE_SCAN' }), 650)
    return () => window.clearTimeout(timer)
  }, [state.isScanning])

  useEffect(() => {
    if (!state.isPaying) return
    const completion = state.activeScreen === 'payment-review' ? 'COMPLETE_SCAN_PAYMENT' : 'COMPLETE_PAYMENT'
    const timer = window.setTimeout(() => dispatch({ type: completion }), 650)
    return () => window.clearTimeout(timer)
  }, [state.activeScreen, state.isPaying])

  const openSupport = (screen: SupportingScreen) => dispatch({ type: 'OPEN_SUPPORT', screen })
  const restart = () => dispatch({ type: state.restartArmed ? 'RESTART' : 'ARM_RESTART' })
  const back = () => dispatch({ type: 'BACK' })
  const closeShareSheet = () => {
    dispatch({ type: 'BACK' })
    window.setTimeout(() => document.querySelector<HTMLElement>('[data-share-trigger]')?.focus(), 0)
  }

  const selectedTag = state.selectedTag ?? 'vouch-pick'
  const currentTransaction = state.transactions.find((transaction) => transaction.id === state.currentTransactionId)
  const selectedTransaction = state.transactions.find((transaction) => transaction.id === state.selectedTransactionId)
  const currentMerchantName = currentTransaction?.merchantName ?? merchant.name
  const currentAmount = currentTransaction?.displayAmount ?? payments.jia.displayAmount
  const canContinueAsDarren = state.currentAuthor === 'Jia' && currentTransaction?.merchantId === merchant.id

  let screen

  switch (state.activeScreen) {
    case 'main-menu':
      screen = <MainMenuScreen transactions={state.transactions} onScan={() => dispatch({ type: 'OPEN_SCAN' })} onProfile={(tab) => dispatch({ type: 'OPEN_PROFILE', tab })} onSavedOffers={() => dispatch({ type: 'OPEN_SAVED_OFFERS' })} onTransaction={(transactionId) => dispatch({ type: 'SELECT_TRANSACTION', transactionId })} />
      break
    case 'scanner':
      screen = <ScanToPayScreen scanning={state.isScanning} onScan={() => dispatch({ type: 'SIMULATE_SCAN' })} onBack={() => dispatch({ type: 'GO_HOME' })} />
      break
    case 'payment-review':
      screen = <PaymentReviewScreen isPaying={state.isPaying} onBack={back} onPay={() => dispatch({ type: 'BEGIN_SCAN_PAYMENT' })} onCancel={() => dispatch({ type: 'GO_HOME', notice: 'Payment cancelled' })} />
      break
    case 'profile':
      screen = <ProfileScreen activeTab={state.profileTab} transactions={state.transactions} vouches={state.vouches} onTab={(tab) => dispatch({ type: 'OPEN_PROFILE', tab })} onTransaction={(transactionId) => dispatch({ type: 'SELECT_TRANSACTION', transactionId })} onSavedOffers={() => dispatch({ type: 'OPEN_SAVED_OFFERS' })} />
      break
    case 'transaction-detail':
      screen = selectedTransaction ? <TransactionDetailScreen transaction={selectedTransaction} onBack={back} onVouch={() => dispatch({ type: 'START_VOUCH', transactionId: selectedTransaction.id, author: 'Jia' })} onViewVouches={() => dispatch({ type: 'OPEN_PROFILE', tab: 'vouches' })} /> : null
      break
    case 'payment-success':
      screen = <PaymentSuccessScreen merchantName={currentMerchantName} amount={currentAmount} onVouch={() => dispatch({ type: 'START_VOUCH', transactionId: state.currentTransactionId, author: 'Jia' })} onDone={() => dispatch({ type: 'GO_HOME', notice: 'Payment complete' })} />
      break
    case 'create-vouch':
      screen = <CreateVouchScreen author={state.currentAuthor} merchantName={currentMerchantName} cycleNumber={state.cycleNumber} selectedTag={state.selectedTag} onSelect={(tag) => dispatch({ type: 'SELECT_TAG', tag })} onShare={() => dispatch({ type: 'NAVIGATE', screen: 'share-sheet' })} onSkip={() => dispatch({ type: 'SKIP_VOUCH' })} onBack={back} />
      break
    case 'share-sheet':
      screen = <ShareSheetScreen author={state.currentAuthor} merchantName={currentMerchantName} selectedTag={selectedTag} onClose={closeShareSheet} onShare={(channel) => dispatch({ type: 'COMPLETE_VOUCH', channel })} />
      break
    case 'vouch-complete':
      screen = state.lastShareChannel ? <VouchCompleteScreen author={state.currentAuthor} merchantName={currentMerchantName} selectedTag={selectedTag} channel={state.lastShareChannel} canContinueAsDarren={canContinueAsDarren} onDone={() => dispatch({ type: 'GO_HOME', notice: 'Vouch saved to My Vouches' })} onContinue={() => dispatch({ type: 'CONTINUE_AS_DARREN' })} /> : null
      break
    case 'whatsapp':
      screen = <WhatsAppScreen author={state.currentAuthor} selectedTag={selectedTag} onBack={back} onView={() => dispatch({ type: 'NAVIGATE', screen: 'vouch-detail' })} />
      break
    case 'vouch-detail':
      screen = <VouchDetailScreen author={state.currentAuthor} selectedTag={selectedTag} offerStatus={state.offerStatus} onBack={back} onClaim={() => dispatch({ type: 'CLAIM_OFFER' })} onViewSaved={() => dispatch({ type: 'OPEN_SAVED_OFFERS' })} />
      break
    case 'offer-claimed':
      screen = <OfferClaimedScreen onBack={back} onViewSaved={() => dispatch({ type: 'OPEN_SAVED_OFFERS' })} onDone={() => { dispatch({ type: 'OPEN_SAVED_OFFERS' }); window.setTimeout(() => dispatch({ type: 'SHOW_NOTICE', notice: 'Saved to Saved Offers' }), 0) }} />
      break
    case 'my-offers':
      screen = <MyOffersScreen offerStatus={state.offerStatus} onBack={back} onUse={() => dispatch({ type: 'USE_OFFER' })} />
      break
    case 'use-offer':
      screen = <UseOfferScreen onBack={back} onPay={() => dispatch({ type: 'NAVIGATE', screen: 'darren-payment' })} />
      break
    case 'darren-payment':
      screen = <DarrenPaymentScreen isPaying={state.isPaying} onBack={back} onPay={() => dispatch({ type: 'BEGIN_PAYMENT' })} />
      break
    case 'redemption-success':
      screen = <RedemptionSuccessScreen onVouch={() => dispatch({ type: 'CREATE_NEXT_VOUCH' })} onDone={() => dispatch({ type: 'GO_HOME', notice: 'Consumer loop complete' })} />
      break
    case 'merchant-campaign':
      screen = <MerchantCampaignScreen status={state.campaignStatus} onBack={() => dispatch({ type: 'SUPPORT_BACK' })} onClose={() => dispatch({ type: 'CLOSE_SUPPORT' })} onLaunch={() => dispatch({ type: 'LAUNCH_CAMPAIGN' })} />
      break
    case 'business-logic':
      screen = <BusinessLogicScreen onBack={() => dispatch({ type: 'SUPPORT_BACK' })} onClose={() => dispatch({ type: 'CLOSE_SUPPORT' })} onNext={() => dispatch({ type: 'SUPPORT_NEXT' })} />
      break
  }

  const showBottomNav = showsBottomNavigation(state.activeScreen)

  return (
    <PhoneShell onOpenDemo={() => dispatch({ type: 'OPEN_NAVIGATOR' })}>
      <div className={showBottomNav ? 'phone-content' : 'phone-content phone-content--focused'}>
        <div className="screen-transition" key={state.activeScreen}>{screen}</div>
        {showBottomNav ? <BottomNavigation active={state.activeScreen === 'profile' ? 'profile' : 'home'} onHome={() => dispatch({ type: 'GO_HOME' })} onScan={() => dispatch({ type: 'OPEN_SCAN' })} onProfile={() => dispatch({ type: 'OPEN_PROFILE' })} /> : null}
      </div>
      <FeedbackToast notice={state.notice} />
      {state.navigatorOpen ? <DemoNavigator state={state} onClose={() => dispatch({ type: 'CLOSE_NAVIGATOR' })} onConsumer={() => dispatch({ type: 'START_OR_RESUME' })} onSupport={openSupport} onRestart={restart} /> : null}
    </PhoneShell>
  )
}

export default App
