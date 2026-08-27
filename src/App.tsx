import { useEffect, useReducer } from 'react'
import { demoReducer, initialState } from './app/demoReducer'
import type { SupportingScreen } from './app/types'
import { DemoNavigator } from './components/DemoNavigator'
import { FeedbackToast } from './components/FeedbackToast'
import { PhoneShell } from './components/PhoneShell'
import { DemoHomeScreen } from './screens/DemoHomeScreen'
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
    if (!state.isPaying) return
    const timer = window.setTimeout(() => dispatch({ type: 'COMPLETE_PAYMENT' }), 650)
    return () => window.clearTimeout(timer)
  }, [state.isPaying])

  const openSupport = (screen: SupportingScreen) => dispatch({ type: 'OPEN_SUPPORT', screen })
  const restart = () => dispatch({ type: state.restartArmed ? 'RESTART' : 'ARM_RESTART' })
  const back = () => dispatch({ type: 'BACK' })
  const closeShareSheet = () => {
    dispatch({ type: 'BACK' })
    window.setTimeout(() => document.querySelector<HTMLElement>('[data-share-trigger]')?.focus(), 0)
  }

  const selectedTag = state.selectedTag ?? 'vouch-pick'
  let screen

  switch (state.activeScreen) {
    case 'demo-home':
      screen = <DemoHomeScreen hasStarted={state.hasStarted} cycleNumber={state.cycleNumber} campaignStatus={state.campaignStatus} restartArmed={state.restartArmed} onConsumer={() => dispatch({ type: 'START_OR_RESUME' })} onSupport={openSupport} onRestart={restart} />
      break
    case 'payment-success':
      screen = <PaymentSuccessScreen onVouch={() => dispatch({ type: 'NAVIGATE', screen: 'create-vouch' })} onDone={() => dispatch({ type: 'GO_HOME' })} />
      break
    case 'create-vouch':
      screen = <CreateVouchScreen author={state.currentAuthor} cycleNumber={state.cycleNumber} selectedTag={state.selectedTag} onSelect={(tag) => dispatch({ type: 'SELECT_TAG', tag })} onShare={() => dispatch({ type: 'NAVIGATE', screen: 'share-sheet' })} onSkip={() => dispatch({ type: 'SKIP_VOUCH' })} onBack={back} />
      break
    case 'share-sheet':
      screen = <ShareSheetScreen author={state.currentAuthor} selectedTag={selectedTag} onClose={closeShareSheet} onWhatsApp={() => dispatch({ type: 'NAVIGATE', screen: 'whatsapp' })} onSimulatedOption={(notice) => dispatch({ type: 'SHOW_NOTICE', notice })} />
      break
    case 'whatsapp':
      screen = <WhatsAppScreen author={state.currentAuthor} selectedTag={selectedTag} onBack={back} onView={() => dispatch({ type: 'NAVIGATE', screen: 'vouch-detail' })} />
      break
    case 'vouch-detail':
      screen = <VouchDetailScreen author={state.currentAuthor} selectedTag={selectedTag} offerStatus={state.offerStatus} onBack={back} onClaim={() => dispatch({ type: 'CLAIM_OFFER' })} onViewSaved={() => dispatch({ type: 'NAVIGATE', screen: 'my-offers' })} />
      break
    case 'offer-claimed':
      screen = <OfferClaimedScreen onBack={back} onViewSaved={() => dispatch({ type: 'NAVIGATE', screen: 'my-offers' })} onDone={() => { dispatch({ type: 'NAVIGATE', screen: 'my-offers' }); window.setTimeout(() => dispatch({ type: 'SHOW_NOTICE', notice: 'Saved to My Offers' }), 0) }} />
      break
    case 'my-offers':
      screen = <MyOffersScreen onBack={back} onUse={() => dispatch({ type: 'USE_OFFER' })} />
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

  return (
    <PhoneShell onOpenDemo={() => dispatch({ type: 'OPEN_NAVIGATOR' })}>
      <div className="screen-transition" key={state.activeScreen}>{screen}</div>
      <FeedbackToast notice={state.notice} />
      {state.navigatorOpen ? <DemoNavigator state={state} onClose={() => dispatch({ type: 'CLOSE_NAVIGATOR' })} onConsumer={() => dispatch({ type: 'START_OR_RESUME' })} onSupport={openSupport} onRestart={restart} /> : null}
    </PhoneShell>
  )
}

export default App
