import { BadgeCheck } from 'lucide-react'

export function VerifiedVisitBadge() {
  return (
    <span className="verified-badge">
      <BadgeCheck size={15} aria-hidden="true" />
      Verified NETS Visit
    </span>
  )
}
