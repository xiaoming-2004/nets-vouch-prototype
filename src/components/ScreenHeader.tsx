import { ArrowLeft, X } from 'lucide-react'

interface ScreenHeaderProps {
  eyebrow?: string
  title: string
  onBack?: () => void
  onClose?: () => void
}

export function ScreenHeader({ eyebrow, title, onBack, onClose }: ScreenHeaderProps) {
  return (
    <div className="screen-heading-row">
      <div className="screen-heading-row__side">
        {onBack ? (
          <button className="icon-button" type="button" onClick={onBack} aria-label="Go back">
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="screen-heading-row__copy">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 data-screen-heading tabIndex={-1}>{title}</h1>
      </div>
      <div className="screen-heading-row__side screen-heading-row__side--end">
        {onClose ? (
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close and resume journey">
            <X size={20} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  )
}
