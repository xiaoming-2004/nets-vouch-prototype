import { ArrowLeft, Check, CheckCircle2, CalendarDays, MapPin, ShieldCheck, Store, Users } from 'lucide-react'
import type { CampaignStatus } from '../../app/types'
import { Button } from '../../components/Button'
import { ScreenHeader } from '../../components/ScreenHeader'
import { campaign, merchant, offer } from '../../data/mockData'

interface MerchantCampaignScreenProps {
  status: CampaignStatus
  onBack: () => void
  onClose: () => void
  onLaunch: () => void
}

export function MerchantCampaignScreen({ status, onBack, onClose, onLaunch }: MerchantCampaignScreenProps) {
  return (
    <div className="screen screen--merchant">
      <ScreenHeader eyebrow="Merchant demo" title="Create Vouch Offer" onBack={onBack} onClose={onClose} />
      {status === 'launched' ? (
        <div className="campaign-success" role="status"><CheckCircle2 size={19} aria-hidden="true" /><span><strong>Campaign launched</strong>Live for this demo only</span></div>
      ) : null}

      <div className="campaign-owner">
        <span className="merchant-monogram" aria-hidden="true">C</span>
        <span><small>Merchant</small><strong>{merchant.name}</strong></span>
        <span className="status-dot">Draft setup</span>
      </div>

      <section className="campaign-offer" aria-labelledby="campaign-offer-title">
        <p className="eyebrow">Customer perk</p>
        <h2 id="campaign-offer-title">{offer.title}</h2>
        <p>Unlocked by a friend’s Vouch and an eligible NETS payment.</p>
      </section>

      <dl className="campaign-details">
        <div><dt><Users size={17} aria-hidden="true" />Redemption limit</dt><dd>{campaign.redemptionLimit}</dd></div>
        <div><dt><CalendarDays size={17} aria-hidden="true" />Validity period</dt><dd>{campaign.validity}</dd></div>
        <div><dt><MapPin size={17} aria-hidden="true" />Eligible outlet</dt><dd>{merchant.outlet}</dd></div>
        <div><dt><ShieldCheck size={17} aria-hidden="true" />Customer limit</dt><dd>One redemption per customer</dd></div>
        <div><dt><Store size={17} aria-hidden="true" />Estimated maximum</dt><dd>{campaign.estimatedMaximum} redemptions</dd></div>
      </dl>

      <div className="control-badges">
        <span><Check size={15} aria-hidden="true" />Merchant-funded</span>
        <span><Check size={15} aria-hidden="true" />Merchant-controlled</span>
      </div>

      <div className="screen-actions">
        <Button
          fullWidth
          variant={status === 'launched' ? 'success' : 'primary'}
          onClick={onLaunch}
          disabled={status === 'launched'}
        >
          {status === 'launched' ? 'Campaign launched' : 'Launch Campaign'}
        </Button>
        <Button variant="ghost" fullWidth onClick={onBack} icon={<ArrowLeft size={18} />}>Back</Button>
      </div>
    </div>
  )
}
