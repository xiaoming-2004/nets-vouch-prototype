import { useEffect, useReducer } from 'react'
import { demoReducer, initialState } from './app/demoReducer'
import type { SupportingScreen } from './app/types'
import { DemoNavigator } from './components/DemoNavigator'
import { FeedbackToast } from './components/FeedbackToast'
import { PhoneShell } from './components/PhoneShell'
import { DemoHomeScreen } from './screens/DemoHomeScreen'
import { PaymentSuccessScreen } from './screens/consumer/PaymentSuccessScreen'

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

  const openSupport = (screen: SupportingScreen) => dispatch({ type: 'OPEN_SUPPORT', screen })
  const restart = () => dispatch({ type: state.restartArmed ? 'RESTART' : 'ARM_RESTART' })

  const screen = state.activeScreen === 'demo-home' ? (
    <DemoHomeScreen
      hasStarted={state.hasStarted}
      cycleNumber={state.cycleNumber}
      campaignStatus={state.campaignStatus}
      restartArmed={state.restartArmed}
      onConsumer={() => dispatch({ type: 'START_OR_RESUME' })}
      onSupport={openSupport}
      onRestart={restart}
    />
  ) : state.activeScreen === 'payment-success' ? (
    <PaymentSuccessScreen
      onVouch={() => dispatch({ type: 'NAVIGATE', screen: 'create-vouch' })}
      onDone={() => dispatch({ type: 'GO_HOME' })}
    />
  ) : (
    <div className="screen screen--centered">
      <p className="eyebrow">Prototype journey</p>
      <h1 data-screen-heading tabIndex={-1}>Continue through NETS Vouch</h1>
    </div>
  )

  return (
    <PhoneShell onOpenDemo={() => dispatch({ type: 'OPEN_NAVIGATOR' })}>
      <div className="screen-transition" key={state.activeScreen}>{screen}</div>
      <FeedbackToast notice={state.notice} />
      {state.navigatorOpen ? (
        <DemoNavigator
          state={state}
          onClose={() => dispatch({ type: 'CLOSE_NAVIGATOR' })}
          onConsumer={() => dispatch({ type: 'START_OR_RESUME' })}
          onSupport={openSupport}
          onRestart={restart}
        />
      ) : null}
    </PhoneShell>
  )
}

export default App
