import { useEffect, useRef } from 'react'
import { ArrowRight, RefreshCcw, Store, UserRound, X } from 'lucide-react'
import type { DemoState, Persona } from '../app/types'

export function DemoNavigator({ state, onClose, onPersona, onRestart }: { state: DemoState; onClose: () => void; onPersona: (persona: Persona) => void; onRestart: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled])') ?? [])
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown); previousFocus?.focus() }
  }, [onClose])

  return <div className="modal-layer">
    <button className="modal-backdrop" aria-label="Close demo navigator" onClick={onClose} />
    <div className="demo-navigator modal-sheet" role="dialog" aria-modal="true" aria-labelledby="demo-nav-title" ref={dialogRef}>
      <div className="modal-sheet__handle" />
      <div className="modal-sheet__header"><div><p className="eyebrow">Connected MVP</p><h2 id="demo-nav-title">Choose a view</h2></div><button className="icon-button" onClick={onClose} ref={closeRef} aria-label="Close demo navigator"><X size={20} /></button></div>
      <div className="navigator-list">
        <button className="navigator-item" onClick={() => onPersona('darren')}><span className="navigator-item__icon navigator-item__icon--blue"><UserRound size={20} /></span><span><strong>Darren’s view</strong><small>Recommend → pay → collect → Vouch</small></span><ArrowRight size={18} /></button>
        <button className="navigator-item" onClick={() => onPersona('felicia')}><span className="navigator-item__icon navigator-item__icon--red"><Store size={20} /></span><span><strong>Felicia’s view</strong><small>Offer → paid order → ready → results</small></span><ArrowRight size={18} /></button>
      </div>
      <p className="navigator-shared-state">Both views use the same simulated order state.</p>
      <button className={`restart-button ${state.restartArmed ? 'restart-button--armed' : ''}`} onClick={onRestart}><RefreshCcw size={16} /><span>{state.restartArmed ? 'Restart now — clear saved progress' : 'Restart demo'}</span></button>
    </div>
  </div>
}
