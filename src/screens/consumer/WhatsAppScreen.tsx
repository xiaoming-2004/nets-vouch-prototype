import { ArrowLeft, Lock, MoreVertical, Phone, Video } from 'lucide-react'
import type { Author, VouchTagId } from '../../app/types'
import { Button } from '../../components/Button'
import { VerifiedVisitBadge } from '../../components/VerifiedVisitBadge'
import { merchant, personalMessage, vouchTags } from '../../data/mockData'

interface WhatsAppScreenProps {
  author: Author
  selectedTag: VouchTagId
  onBack: () => void
  onView: () => void
}

export function WhatsAppScreen({ author, selectedTag, onBack, onView }: WhatsAppScreenProps) {
  const selectedLabel = vouchTags.find((tag) => tag.id === selectedTag)?.label ?? 'Vouch Pick'

  return (
    <div className="screen screen--whatsapp" aria-label="Simulated WhatsApp conversation">
      <div className="whatsapp-demo-label"><Lock size={12} aria-hidden="true" /> Simulated WhatsApp</div>
      <header className="whatsapp-header">
        <button type="button" className="whatsapp-back" onClick={onBack} aria-label="Go back to share sheet">
          <ArrowLeft size={22} aria-hidden="true" />
        </button>
        <div className="chat-avatar" aria-hidden="true">D</div>
        <div className="whatsapp-header__person">
          <h1 data-screen-heading tabIndex={-1}>Darren</h1>
          <span>online</span>
        </div>
        <Video size={19} aria-hidden="true" />
        <Phone size={18} aria-hidden="true" />
        <MoreVertical size={19} aria-hidden="true" />
      </header>
      <div className="chat-area">
        <div className="chat-date">Today</div>
        <div className="encryption-note"><Lock size={11} aria-hidden="true" /> Messages are simulated for this prototype</div>
        <div className="message-bubble message-bubble--sent">
          <p>{personalMessage}</p>
          <span>9:42 ✓✓</span>
        </div>
        <div className="message-bubble message-bubble--sent message-bubble--vouch">
          <article className="whatsapp-vouch-card">
            <div className="whatsapp-vouch-card__visual">
              <span className="mini-wordmark">NETS Vouch</span>
              <span className="cafe-monogram" aria-hidden="true">C</span>
            </div>
            <div className="whatsapp-vouch-card__body">
              <p><strong>{author}</strong> Vouched for {merchant.name}</p>
              <span className="vouch-tag-chip">{selectedLabel}</span>
              <VerifiedVisitBadge />
            </div>
            <Button fullWidth onClick={onView}>View in NETS</Button>
          </article>
          <span className="message-time">9:42 ✓✓</span>
        </div>
      </div>
    </div>
  )
}
