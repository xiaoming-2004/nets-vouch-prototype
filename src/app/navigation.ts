import type { ScreenId } from './types'
export function showsBottomNavigation(screen: ScreenId) { return screen === 'main-menu' || screen === 'profile' }
