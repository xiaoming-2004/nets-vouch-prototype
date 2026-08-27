export function StatusBar() {
  return (
    <div className="status-bar" aria-hidden="true">
      <span className="status-bar__time">9:41</span>
      <span className="status-bar__island" />
      <span className="status-bar__signals">
        <span className="signal-bars"><i /><i /><i /><i /></span>
        <span className="wifi-mark">◢</span>
        <span className="battery-mark"><i /></span>
      </span>
    </div>
  )
}
