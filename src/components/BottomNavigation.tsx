import { Home, QrCode, UserRound } from 'lucide-react'

type BottomNavItem = 'home' | 'scan' | 'profile'

interface BottomNavigationProps {
  active: BottomNavItem
  onHome: () => void
  onScan: () => void
  onProfile: () => void
}

export function BottomNavigation({ active, onHome, onScan, onProfile }: BottomNavigationProps) {
  const items = [
    { id: 'home' as const, label: 'Home', icon: Home, action: onHome },
    { id: 'scan' as const, label: 'Scan', icon: QrCode, action: onScan },
    { id: 'profile' as const, label: 'Profile', icon: UserRound, action: onProfile },
  ]

  return (
    <nav className="bottom-navigation" aria-label="Primary navigation">
      {items.map((item) => {
        const Icon = item.icon
        const selected = active === item.id
        return (
          <button
            key={item.id}
            type="button"
            className={selected ? 'bottom-navigation__item bottom-navigation__item--active' : 'bottom-navigation__item'}
            onClick={item.action}
            aria-current={selected ? 'page' : undefined}
          >
            <Icon size={20} aria-hidden="true" />
            <span>{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
