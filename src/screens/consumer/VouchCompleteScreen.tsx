import { ArrowRight, Check, Home, Send } from 'lucide-react'
import type { Author, ShareChannel, VouchTagId } from '../../app/types'
import { Button } from '../../components/Button'
import { VerifiedVisitBadge } from '../../components/VerifiedVisitBadge'
import { vouchTags } from '../../data/mockData'

interface VouchCompleteScreenProps {
  author: Author
  merchantName: string
  selectedTag: VouchTagId
  channel: ShareChannel
  canContinueAsDarren: boolean
  onDone: () => void
  onContinue: () => void
}

export function VouchCompleteScreen({
  author,
  merchantName,
  selectedTag,
  channel,
  canContinueAsDarren,
  onDone,
  onContinue,
}: VouchCompleteScreenProps) {
  const selectedLabel = vouchTags.find((tag) => tag.id === selectedTag)?.label ?? 'Vouch Pick'
  const shared = channel !== 'Copy link'

  return (
    <div className="screen screen--vouch-complete">
      <div className="vouch-complete-mark" aria-hidden="true"><Check size={34} strokeWidth={3} /></div>
      <p className="eyebrow">Saved to {author === 'Jia' ? 'My Vouches' : 'this demo session'}</p>
      <h1 data-screen-heading tabIndex={-1}>{shared ? 'Vouch shared' : 'Vouch completed'}</h1>
      <p className="vouch-complete-lede">{shared ? `Shared through simulated ${channel}.` : 'The demo link action is complete.'}</p>

      <article className="completed-vouch-card">
        <div className="completed-vouch-card__topline"><span>NETS Vouch</span><Send size={17} aria-hidden="true" /></div>
        <h2>{merchantName}</h2>
        <p><strong>{author}</strong> Vouched for this place</p>
        <div className="badge-row">
          <span className="vouch-tag-chip">{selectedLabel}</span>
          <VerifiedVisitBadge />
        </div>
      </article>

      {author === 'Jia' ? <p className="profile-save-confirmation">This Vouch now appears in Profile → My Vouches.</p> : null}

      <div className="screen-actions screen-actions--bottom">
        <Button fullWidth onClick={onDone} icon={<Home size={19} />}>Done</Button>
        {canContinueAsDarren ? (
          <Button fullWidth variant="secondary" onClick={onContinue} icon={<ArrowRight size={19} />}>Continue demo as Darren</Button>
        ) : null}
      </div>
    </div>
  )
}
