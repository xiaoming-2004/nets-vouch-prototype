const qrSize = 17

function finderCell(row: number, column: number, startRow: number, startColumn: number): boolean | null {
  const localRow = row - startRow
  const localColumn = column - startColumn
  if (localRow < 0 || localRow > 6 || localColumn < 0 || localColumn > 6) return null
  const edge = localRow === 0 || localRow === 6 || localColumn === 0 || localColumn === 6
  const centre = localRow >= 2 && localRow <= 4 && localColumn >= 2 && localColumn <= 4
  return edge || centre
}

function isDarkCell(row: number, column: number): boolean {
  const topLeft = finderCell(row, column, 0, 0)
  const topRight = finderCell(row, column, 0, 10)
  const bottomLeft = finderCell(row, column, 10, 0)
  if (topLeft !== null) return topLeft
  if (topRight !== null) return topRight
  if (bottomLeft !== null) return bottomLeft
  return ((row * 7 + column * 11 + row * column * 3) % 13) < 6
}

const qrCells = Array.from({ length: qrSize * qrSize }, (_, index) => ({
  id: index,
  dark: isDarkCell(Math.floor(index / qrSize), index % qrSize),
}))

interface FictionalQrButtonProps {
  scanning: boolean
  onScan: () => void
}

export function FictionalQrButton({ scanning, onScan }: FictionalQrButtonProps) {
  return (
    <button
      type="button"
      className={scanning ? 'fictional-qr-button fictional-qr-button--scanning' : 'fictional-qr-button'}
      onClick={onScan}
      disabled={scanning}
      aria-label="Simulate scanning Café ABC QR code"
      aria-busy={scanning}
    >
      <span className="fictional-qr" aria-hidden="true">
        {qrCells.map((cell) => <i key={cell.id} className={cell.dark ? 'qr-cell qr-cell--dark' : 'qr-cell'} />)}
        <span className="fictional-qr__brand">NETS</span>
        {scanning ? <span className="fictional-qr__scan-line" /> : null}
      </span>
      <span className="fictional-qr-button__state">{scanning ? 'Scanning…' : 'Tap to scan'}</span>
    </button>
  )
}
