import { Check } from 'lucide-react'
import type { VouchTagId } from '../app/types'
import { vouchTags } from '../data/mockData'

interface VouchTagSelectorProps {
  selectedTag: VouchTagId | null
  onSelect: (tag: VouchTagId) => void
}

export function VouchTagSelector({ selectedTag, onSelect }: VouchTagSelectorProps) {
  return (
    <fieldset className="tag-selector">
      <legend className="sr-only">Choose one Vouch tag</legend>
      {vouchTags.map((tag) => {
        const selected = selectedTag === tag.id
        return (
          <label className={`tag-option ${selected ? 'tag-option--selected' : ''}`} key={tag.id}>
            <input
              type="radio"
              name="vouch-tag"
              value={tag.id}
              checked={selected}
              onChange={() => onSelect(tag.id)}
            />
            <span className="tag-option__symbol" aria-hidden="true">{tag.symbol}</span>
            <span className="tag-option__label">{tag.label}</span>
            <span className="tag-option__check" aria-hidden="true">{selected ? <Check size={16} strokeWidth={3} /> : null}</span>
          </label>
        )
      })}
    </fieldset>
  )
}
