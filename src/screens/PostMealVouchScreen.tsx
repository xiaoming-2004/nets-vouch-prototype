import { BadgeCheck, ThumbsUp } from 'lucide-react'
import type { Order } from '../app/types'
import { Button } from '../components/Button'

export function PostMealVouchScreen({ order, onVouch, onSkip }: { order: Order; onVouch: () => void; onSkip: () => void }) {
  return <div className="screen screen--post-meal"><p className="eyebrow">After lunch · Optional</p><h1 data-screen-heading tabIndex={-1}>Worth a Vouch?</h1><p className="screen-lede">Would you recommend {order.merchantName}?</p>
    <div className="one-tap-vouch"><ThumbsUp size={34} aria-hidden="true" /><h2>One tap. No review required.</h2><p>Your amount is never shown and you receive no extra reward.</p></div>
    <div className="verified-definition"><BadgeCheck size={20} aria-hidden="true" /><span><strong>Payment-Verified Vouch</strong>Confirms an eligible NETS payment, not guaranteed quality.</span></div>
    <div className="screen-actions screen-actions--bottom"><Button fullWidth onClick={onVouch}>Vouch — one tap</Button><Button variant="ghost" fullWidth onClick={onSkip}>Not now</Button></div>
  </div>
}
