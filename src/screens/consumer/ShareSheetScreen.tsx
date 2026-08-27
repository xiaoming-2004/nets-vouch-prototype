import { useEffect, useRef } from 'react'
import { Copy, MessageCircle, MessagesSquare, Send, Share2, X } from 'lucide-react'
import type { Author, VouchTagId } from '../../app/types'
import { VerifiedVisitBadge } from '../../components/VerifiedVisitBadge'
import { merchant, vouchTags } from '../../data/mockData'

interface ShareSheetScreenProps {
  author: Author
  selectedTag: VouchTagId
  onClose: () => void
  onWhatsApp: () => void
  onSimulatedOption: (label: string) => void
}

export function ShareSheetScreen({ author, selectedTag, onClose, onWhatsApp, onSimulatedOption }: ShareSheetScreenProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const selectedLabel = vouchTags.find((tag) => tag.id === selectedTag)?.label ?? 'Vouch Pick'

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled])'))
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="share-screen">
      <div className="share-screen__background" aria-hidden="true">
        <Share2 size={40} />
        <h1>Share your Vouch</h1>
        <p>Choose how to send this trusted recommendation.</p>
      </div>
      <div className="modal-layer">
        <button className="modal-backdrop" type="button" aria-label="Close share sheet" onClick={onClose} />
        <div className="share-sheet modal-sheet" role="dialog" aria-modal="true" aria-labelledby="share-sheet-title" ref={dialogRef}>
          <div className="modal-sheet__handle" aria-hidden="true" />
          <div className="share-sheet__header">
            <p id="share-sheet-title">Share Vouch</p>
            <button className="icon-button" type="button" onClick={onClose} ref={closeRef} aria-label="Close share sheet">
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          <article className="share-preview">
            <div className="share-preview__brand"><span>NETS</span> Vouch</div>
            <p className="share-preview__title"><strong>{author}</strong> Vouched for {merchant.name}</p>
            <span className="vouch-tag-chip">{selectedLabel}</span>
            <VerifiedVisitBadge />
          </article>
          <div className="share-options" aria-label="Share options">
            <button type="button" onClick={onWhatsApp}>
              <span className="share-app share-app--whatsapp"><MessageCircle size={24} aria-hidden="true" /></span>
              <span>WhatsApp</span>
            </button>
            <button type="button" onClick={() => onSimulatedOption('Telegram sharing is simulated in this demo')}>
              <span className="share-app share-app--telegram"><Send size={23} aria-hidden="true" /></span>
              <span>Telegram</span>
            </button>
            <button type="button" onClick={() => onSimulatedOption('Messages sharing is simulated in this demo')}>
              <span className="share-app share-app--messages"><MessagesSquare size={23} aria-hidden="true" /></span>
              <span>Messages</span>
            </button>
            <button type="button" onClick={() => onSimulatedOption('Demo link copied')}>
              <span className="share-app share-app--copy"><Copy size={22} aria-hidden="true" /></span>
              <span>Copy link</span>
            </button>
          </div>
          <p className="share-sheet__note">Prototype only — no external app will open.</p>
        </div>
      </div>
    </div>
  )
}
