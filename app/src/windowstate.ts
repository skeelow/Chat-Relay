// Relay Chat — saved window settings (M4.3), pure helpers: parsing and
// validating `window-state.json` from Electron's userData folder. A corrupt
// or malformed file is ignored (null), and bounds that no longer lie on an
// attached display fall back to the default — so an unplugged monitor can
// never strand the window off-screen.

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Used when there is nothing valid to restore. */
export const DEFAULT_BOUNDS: WindowBounds = { x: 120, y: 100, width: 980, height: 720 };

const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;
const MAX_SIZE = 4000;

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

/** Parse the saved state. Corrupt JSON, a non-object, or anything not four
 *  sane integers is rejected with null — the caller then uses the default. */
export function parseWindowState(raw: string): WindowBounds | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (!isInteger(record.x) || !isInteger(record.y) || !isInteger(record.width) || !isInteger(record.height)) {
    return null;
  }
  const bounds = { x: record.x, y: record.y, width: record.width, height: record.height };
  if (bounds.width < MIN_WIDTH || bounds.width > MAX_SIZE) return null;
  if (bounds.height < MIN_HEIGHT || bounds.height > MAX_SIZE) return null;
  return bounds;
}

/** True when the bounds overlap any attached display — a window the user
 *  could still find. Fully off-screen bounds are rejected. */
export function boundsOnADisplay(
  bounds: WindowBounds,
  displays: Array<{ x: number; y: number; width: number; height: number }>,
): boolean {
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;
  for (const display of displays) {
    const overlapX = Math.min(bounds.x + bounds.width, display.x + display.width) - Math.max(bounds.x, display.x);
    const overlapY = Math.min(bounds.y + bounds.height, display.y + display.height) - Math.max(bounds.y, display.y);
    if (overlapX > 0 && overlapY > 0) return true;
  }
  return false;
}
