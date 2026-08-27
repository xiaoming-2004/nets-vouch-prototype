import { useEffect, useRef } from 'react'
import { ArrowRight, BriefcaseBusiness, RefreshCcw, Route, Scale, X } from 'lucide-react'
import type { DemoState, SupportingScreen } from '../app/types'

interface DemoNavigatorProps {
  state: DemoState
  onClose: () => void
  onConsumer: () => void
  onSupport: (screen: SupportingScreen) => void
  onRestart: () => void
}

export function DemoNavigator({ state, onClose, onConsumer, onSupport, onRestart }: DemoNavigatorProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null)

  useEffect(() => {
    const returnFocus = returnFocusRef.current
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      returnFocus?.focus()
    }
  }, [onClose])

  return (
    <div className="modal-layer" role="presentation">
      <button className="modal-backdrop" type="button" aria-label="Close demo navigator" onClick={onClose} />
      <div className="demo-navigator modal-sheet" role="dialog" aria-modal="true" aria-labelledby="demo-nav-title" ref={dialogRef}>
        <div className="modal-sheet__handle" aria-hidden="true" />
        <div className="modal-sheet__header">
          <div>
            <p className="eyebrow">Prototype navigator</p>
            <h2 id="demo-nav-title">Choose a demo</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} ref={closeRef} aria-label="Close demo navigator">
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="navigator-list">
          <button type="button" className="navigator-item" onClick={onConsumer}>
            <span className="navigator-item__icon navigator-item__icon--blue"><Route size={20} aria-hidden="true" /></span>
            <span><strong>{state.hasStarted ? 'Resume journey' : 'Consumer journey'}</strong><small>Payment → Vouch → offer → next Vouch</small></span>
            <ArrowRight size={18} aria-hidden="true" />
          </button>
          <button type="button" className="navigator-item" onClick={() => onSupport('merchant-campaign')}>
            <span className="navigator-item__icon navigator-item__icon--red"><BriefcaseBusiness size={20} aria-hidden="true" /></span>
            <span><strong>Merchant campaign</strong><small>Set up a funded Vouch offer</small></span>
            <ArrowRight size={18} aria-hidden="true" />
          </button>
          <button type="button" className="navigator-item" onClick={() => onSupport('business-logic')}>
            <span className="navigator-item__icon navigator-item__icon--green"><Scale size={20} aria-hidden="true" /></span>
            <span><strong>Business logic</strong><small>See the illustrative cost comparison</small></span>
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        </div>
        <button className={`restart-button ${state.restartArmed ? 'restart-button--armed' : ''}`} type="button" onClick={onRestart}>
          <RefreshCcw size={16} aria-hidden="true" />
          <span>{state.restartArmed ? 'Restart now — clear all progress' : 'Restart demo'}</span>
        </button>
      </div>
    </div>
  )
}
