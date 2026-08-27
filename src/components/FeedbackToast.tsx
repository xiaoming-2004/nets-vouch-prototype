import { CheckCircle2 } from 'lucide-react'

export function FeedbackToast({ notice }: { notice: string | null }) {
  return (
    <div className={`feedback-toast ${notice ? 'feedback-toast--visible' : ''}`} role="status" aria-live="polite">
      {notice ? <CheckCircle2 size={17} aria-hidden="true" /> : null}
      <span>{notice ?? ''}</span>
    </div>
  )
}
