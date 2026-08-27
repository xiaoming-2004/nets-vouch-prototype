import { CameraOff, ScanLine, ShieldCheck } from 'lucide-react'
import { FictionalQrButton } from '../components/FictionalQrButton'
import { ScreenHeader } from '../components/ScreenHeader'

interface ScanToPayScreenProps {
  scanning: boolean
  onScan: () => void
  onBack: () => void
}

export function ScanToPayScreen({ scanning, onScan, onBack }: ScanToPayScreenProps) {
  return (
    <div className="screen screen--scanner">
      <ScreenHeader eyebrow="Simulated QR payment" title="Scan to Pay" onBack={onBack} />
      <div className="scanner-intro">
        <span><ScanLine size={20} aria-hidden="true" /></span>
        <div>
          <h2>Point, scan, pay</h2>
          <p>Try the fictional merchant QR below.</p>
        </div>
      </div>

      <div className={scanning ? 'scan-frame scan-frame--active' : 'scan-frame'}>
        <i className="scan-corner scan-corner--tl" aria-hidden="true" />
        <i className="scan-corner scan-corner--tr" aria-hidden="true" />
        <i className="scan-corner scan-corner--bl" aria-hidden="true" />
        <i className="scan-corner scan-corner--br" aria-hidden="true" />
        <FictionalQrButton scanning={scanning} onScan={onScan} />
      </div>

      <div className="scan-instruction" role="status" aria-live="polite">
        <strong>{scanning ? 'Scanning…' : 'Tap the QR code to simulate scanning'}</strong>
        <span>{scanning ? 'Recognising Café ABC' : 'The entire QR is a button'}</span>
      </div>

      <div className="prototype-camera-note">
        <CameraOff size={18} aria-hidden="true" />
        <span><strong>No camera used</strong>This prototype never requests camera permission.</span>
      </div>
      <p className="scan-security"><ShieldCheck size={14} aria-hidden="true" />Fictional QR · Contains no payment information</p>
    </div>
  )
}
