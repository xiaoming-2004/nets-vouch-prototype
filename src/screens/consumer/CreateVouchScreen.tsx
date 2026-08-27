import { ArrowRight, BadgeCheck, Info, Sparkles } from 'lucide-react'
import type { Author, VouchTagId } from '../../app/types'
import { Button } from '../../components/Button'
import { ScreenHeader } from '../../components/ScreenHeader'
import { VouchTagSelector } from '../../components/VouchTagSelector'
import { merchant, vouchTags } from '../../data/mockData'

interface CreateVouchScreenProps {
  author: Author
  cycleNumber: number
  selectedTag: VouchTagId | null
  onSelect: (tag: VouchTagId) => void
  onShare: () => void
  onSkip: () => void
  onBack: () => void
}

export function CreateVouchScreen({
  author,
  cycleNumber,
  selectedTag,
  onSelect,
  onShare,
  onSkip,
  onBack,
}: CreateVouchScreenProps) {
  const selectedLabel = vouchTags.find((tag) => tag.id === selectedTag)?.label

  return (
    <div className="screen screen--create-vouch">
      <ScreenHeader eyebrow="After a completed payment" title="Worth sharing?" onBack={onBack} />

      {cycleNumber > 1 ? (
        <div className="next-vouch-banner" role="status">
          <BadgeCheck size={20} aria-hidden="true" />
          <span><strong>New verified visit</strong>Darren can create the next Vouch.</span>
        </div>
      ) : null}

      <section className="merchant-intro" aria-labelledby="vouch-merchant-title">
        <div className="merchant-avatar" aria-hidden="true">C</div>
        <div>
          <p className="eyebrow">{author}’s verified visit</p>
          <h2 id="vouch-merchant-title">Vouch for {merchant.name}</h2>
          <p>Pick the one thing you’d tell a friend.</p>
        </div>
      </section>

      <div className="section-label">
        <span>Choose one tag</span>
        <span>{selectedLabel ?? 'None selected'}</span>
      </div>
      <VouchTagSelector selectedTag={selectedTag} onSelect={onSelect} />

      <div className="no-review-note">
        <Info size={16} aria-hidden="true" />
        <span>A simple recommendation from a verified NETS visit — no rating or review needed.</span>
      </div>

      <div className="screen-actions">
        <Button
          fullWidth
          data-share-trigger
          disabled={!selectedTag}
          onClick={onShare}
          icon={selectedTag ? <ArrowRight size={19} /> : <Sparkles size={19} />}
        >
          Share Vouch
        </Button>
        {!selectedTag ? <p className="action-helper">Choose one tag to continue</p> : null}
        <Button variant="ghost" fullWidth onClick={onSkip}>Not now</Button>
      </div>
    </div>
  )
}
