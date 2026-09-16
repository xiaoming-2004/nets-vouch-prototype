import { useState } from 'react'
import { Bell, BrainCircuit, LocateFixed, ShieldCheck } from 'lucide-react'
import type { PersonalisationSettings } from '../app/types'
import { Button } from '../components/Button'

export function PersonalisationScreen({ settings, onSave }: { settings: PersonalisationSettings; onSave: (settings: Omit<PersonalisationSettings, 'completed'>) => void }) {
  const [values, setValues] = useState({ recommendations: settings.recommendations, transactionAnalysis: settings.transactionAnalysis, location: settings.location, notifications: settings.notifications })
  const toggle = (key: keyof typeof values) => setValues((current) => ({ ...current, [key]: !current[key] }))
  const rows = [
    ['recommendations', BrainCircuit, 'Personalised recommendations', 'Use the preferences you choose.'],
    ['transactionAnalysis', ShieldCheck, 'NETS activity patterns', 'Optional patterns only — never public.'],
    ['location', LocateFixed, 'Location while using', 'Find participating options nearby.'],
    ['notifications', Bell, 'Helpful notifications', 'One timely suggestion, not a promo feed.'],
  ] as const
  return <div className="screen screen--personalisation">
    <p className="eyebrow">You stay in control</p><h1 data-screen-heading tabIndex={-1}>Set up Vouch AI</h1>
    <p className="screen-lede">Choose what NETS may use. Turn transaction analysis off anytime and continue in Basic Mode.</p>
    <div className="privacy-list">{rows.map(([key, Icon, title, copy]) => <button key={key} type="button" className="privacy-row" onClick={() => toggle(key)} aria-pressed={values[key]}>
      <span className="privacy-row__icon"><Icon size={20} aria-hidden="true" /></span><span><strong>{title}</strong><small>{copy}</small></span><span className={`switch ${values[key] ? 'switch--on' : ''}`} aria-hidden="true"><i /></span>
    </button>)}</div>
    {!values.transactionAnalysis ? <div className="basic-mode-note"><strong>Basic Mode</strong><span>Recommendations use only your selected preferences and participating merchant information.</span></div> : null}
    <div className="screen-actions screen-actions--bottom"><Button fullWidth onClick={() => onSave(values)}>Save and continue</Button><p className="action-helper">Fictional settings for this prototype</p></div>
  </div>
}
