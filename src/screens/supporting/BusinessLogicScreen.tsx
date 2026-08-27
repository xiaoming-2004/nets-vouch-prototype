import { ArrowLeft, ArrowRight, BadgeDollarSign, Handshake, Lightbulb, Store } from 'lucide-react'
import { Button } from '../../components/Button'
import { ScreenHeader } from '../../components/ScreenHeader'
import { businessRates } from '../../data/mockData'

interface BusinessLogicScreenProps {
  onBack: () => void
  onClose: () => void
  onNext: () => void
}

export function BusinessLogicScreen({ onBack, onClose, onNext }: BusinessLogicScreenProps) {
  return (
    <div className="screen screen--business">
      <ScreenHeader eyebrow="Illustrative business logic" title="How the loop can work" onClose={onClose} />
      <p className="screen-lede">A small acceptance-cost difference can help a merchant fund a useful customer perk.</p>

      <div className="rate-comparison" aria-label="Illustrative payment rate comparison">
        <article className="rate-card rate-card--card">
          <span>Card payment</span>
          <strong>{businessRates.card}</strong>
          <small>Illustrative rate</small>
        </article>
        <span className="rate-comparison__versus">vs</span>
        <article className="rate-card rate-card--nets">
          <span>NETS</span>
          <strong>{businessRates.nets}</strong>
          <small>Illustrative rate</small>
        </article>
      </div>

      <div className="business-flow" aria-label="Potential merchant value flow">
        <div><span><BadgeDollarSign size={20} aria-hidden="true" /></span><p>Potential acceptance-cost difference</p></div>
        <i aria-hidden="true"><ArrowRight size={17} /></i>
        <div><span><Lightbulb size={20} aria-hidden="true" /></span><p>Small customer perk</p></div>
        <i aria-hidden="true"><ArrowRight size={17} /></i>
        <div><span><Handshake size={20} aria-hidden="true" /></span><p>Referred customer</p></div>
      </div>

      <section className="merchant-outcome">
        <Store size={23} aria-hidden="true" />
        <div>
          <p className="eyebrow">Potential outcome</p>
          <h2>Merchant receives a referred customer</h2>
          <p>The Vouch supplies trust. The optional merchant-funded offer can help convert a future visit.</p>
        </div>
      </section>

      <div className="rate-disclaimer">
        <strong>{businessRates.disclaimer}</strong>
        <span>Rates are not guaranteed merchant pricing. Savings and fees depend on actual agreements.</span>
      </div>

      <div className="dual-actions">
        <Button variant="ghost" onClick={onBack} icon={<ArrowLeft size={18} />}>Back</Button>
        <Button onClick={onNext} icon={<ArrowRight size={18} />}>Next</Button>
      </div>
    </div>
  )
}
