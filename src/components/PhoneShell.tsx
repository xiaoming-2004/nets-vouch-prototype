import type { ReactNode } from 'react'
import { Compass } from 'lucide-react'
import { StatusBar } from './StatusBar'

interface PhoneShellProps {
  children: ReactNode
  onOpenDemo: () => void
}

export function PhoneShell({ children, onOpenDemo }: PhoneShellProps) {
  return (
    <main className="prototype-stage">
      <section className="phone-shell" aria-label="NETS Vouch mobile prototype">
        <StatusBar />
        <header className="app-bar">
          <div className="wordmark" aria-label="NETS Vouch">
            <span className="wordmark__nets">NETS</span>
            <span className="wordmark__vouch">Vouch</span>
          </div>
          <button className="demo-trigger" type="button" onClick={onOpenDemo} aria-label="Open demo navigator">
            <Compass size={16} aria-hidden="true" />
            <span>Demo</span>
          </button>
        </header>
        <div className="phone-viewport">{children}</div>
        <div className="home-indicator" aria-hidden="true" />
      </section>
    </main>
  )
}
