import { ArrowLeft, Sparkles } from 'lucide-react'
import type { RejectionReason } from '../app/types'
import { rejectionLabels } from '../data/mockData'
import { ScreenHeader } from '../components/ScreenHeader'

export function RejectionScreen({ onSelect, onBack }: { onSelect: (reason: RejectionReason) => void; onBack: () => void }) {
  return <div className="screen screen--rejection"><ScreenHeader eyebrow="One tap — no typing" title="What did not fit?" onBack={onBack} />
    <div className="rejection-intro"><Sparkles size={24} aria-hidden="true" /><p>Your answer improves the next recommendation. Rejecting is always free.</p></div>
    <div className="rejection-grid">{(Object.entries(rejectionLabels) as [RejectionReason, string][]).map(([reason, label]) => <button type="button" key={reason} onClick={() => onSelect(reason)}>{label}<ArrowLeft size={16} className="reverse-arrow" aria-hidden="true" /></button>)}</div>
  </div>
}
