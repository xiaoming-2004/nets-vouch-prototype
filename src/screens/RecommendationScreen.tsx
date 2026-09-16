import { BadgeCheck, Clock3, MapPin, Sparkles, Store } from 'lucide-react'
import type { Recommendation } from '../app/types'
import { Button } from '../components/Button'
import { ScreenHeader } from '../components/ScreenHeader'

export function RecommendationScreen({ recommendation, basicMode, rejectionNote, onAccept, onReject, onBack }: { recommendation: Recommendation; basicMode: boolean; rejectionNote?: string; onAccept: () => void; onReject: () => void; onBack: () => void }) {
  return <div className="screen screen--recommendation">
    <ScreenHeader eyebrow={basicMode ? 'Basic Mode smart match' : 'Vouch AI smart match'} title="One lunch option" onBack={onBack} />
    {rejectionNote ? <div className="learning-banner"><Sparkles size={18} aria-hidden="true" /><span><strong>Adjusted</strong>{rejectionNote}</span></div> : null}
    <article className="recommendation-card">
      <div className="recommendation-card__visual"><Store size={38} aria-hidden="true" /><span>{recommendation.availability}</span></div>
      <p className="eyebrow">Participating merchant</p><h2>{recommendation.merchantName}</h2><h3>{recommendation.itemName}</h3>
      <div className="recommendation-facts"><span>{recommendation.displayPrice}</span><span>{recommendation.dietary}</span><span><MapPin size={13} aria-hidden="true" />{recommendation.distance}</span></div>
      <div className="cashback-chip">$0.50 cashback after eligible NETS payment</div>
      <div className="verified-vouches"><BadgeCheck size={18} aria-hidden="true" />{recommendation.vouchCount} Payment-Verified Vouches</div>
      <p className="match-reason"><Clock3 size={17} aria-hidden="true" />{recommendation.reason}</p>
    </article>
    <p className="verification-note">A Verified Vouch confirms an eligible payment, not guaranteed quality.</p>
    <div className="screen-actions"><Button fullWidth onClick={onAccept}>Accept and pay</Button><Button variant="ghost" fullWidth onClick={onReject}>Not for me</Button></div>
  </div>
}
