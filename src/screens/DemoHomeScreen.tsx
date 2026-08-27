import { ArrowRight, BriefcaseBusiness, RefreshCcw, Route, Scale, ShieldCheck } from 'lucide-react'
import type { CampaignStatus, SupportingScreen } from '../app/types'
import { Button } from '../components/Button'

interface DemoHomeScreenProps {
  hasStarted: boolean
  cycleNumber: number
  campaignStatus: CampaignStatus
  restartArmed: boolean
  onConsumer: () => void
  onSupport: (screen: SupportingScreen) => void
  onRestart: () => void
}

export function DemoHomeScreen({
  hasStarted,
  cycleNumber,
  campaignStatus,
  restartArmed,
  onConsumer,
  onSupport,
  onRestart,
}: DemoHomeScreenProps) {
  return (
    <div className="screen screen--home">
      <div className="home-hero">
        <div className="prototype-pill"><ShieldCheck size={14} aria-hidden="true" /> Interactive prototype</div>
        <h1 data-screen-heading tabIndex={-1}>One payment<br />creates the next.</h1>
        <p>See how a trusted Vouch can turn one completed NETS payment into a referred visit.</p>
      </div>

      <section className="journey-feature" aria-labelledby="consumer-journey-title">
        <div className="journey-feature__icon"><Route size={24} aria-hidden="true" /></div>
        <p className="eyebrow">Main story · 10 screens</p>
        <h2 id="consumer-journey-title">Consumer journey</h2>
        <p>Follow Jia’s Vouch to Darren’s next payment.</p>
        {hasStarted ? <span className="resume-chip">{cycleNumber > 1 ? 'Cycle complete' : 'Journey in progress'}</span> : null}
        <Button fullWidth onClick={onConsumer} icon={<ArrowRight size={19} />}>
          {hasStarted ? 'Resume journey' : 'Start journey'}
        </Button>
      </section>

      <div className="support-grid">
        <button className="support-card" type="button" onClick={() => onSupport('merchant-campaign')}>
          <span className="support-card__icon support-card__icon--red"><BriefcaseBusiness size={20} aria-hidden="true" /></span>
          <strong>Merchant</strong>
          <small>{campaignStatus === 'launched' ? 'Campaign launched' : 'Create an offer'}</small>
        </button>
        <button className="support-card" type="button" onClick={() => onSupport('business-logic')}>
          <span className="support-card__icon support-card__icon--blue"><Scale size={20} aria-hidden="true" /></span>
          <strong>Business logic</strong>
          <small>Why it can work</small>
        </button>
      </div>

      <button className={`home-restart ${restartArmed ? 'home-restart--armed' : ''}`} type="button" onClick={onRestart}>
        <RefreshCcw size={14} aria-hidden="true" />
        {restartArmed ? 'Restart now' : 'Restart demo'}
      </button>
      <p className="prototype-disclaimer">Fictional data · Simulated payments · No external integrations</p>
    </div>
  )
}
