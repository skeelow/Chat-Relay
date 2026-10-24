// Relay Chat — GUI settings decisions (M4.2), pure and DOM-free so Node's
// test runner can exercise them (tests/gui-settings.test.ts). The renderer
// owns the panel; nothing here touches the document or socket.
//
// The panel shows only the server's values (snapshot.settings and
// settings_update); a change sends a set_mode frame and waits for the update
// to come back. Invalid input is never sent — an inline hint explains.

/** The server's settings as the engine reports them. */
export interface RelaySettings {
  mode: 'manual' | 'approve_each';
  turnCap: number;
  autoSend: boolean;
  autoSendDelaySec: number;
}

export const TURN_CAP_MIN = 1;
export const TURN_CAP_MAX = 50;
export const DELAY_MIN_SEC = 3;
export const DELAY_MAX_SEC = 1800;

/** The delay box's unit. */
export type DelayUnit = 'seconds' | 'minutes';

/** Pure: the number box's value and unit, converted to seconds. */
export function delayToSeconds(value: number, unit: DelayUnit): number {
  return unit === 'minutes' ? value * 60 : value;
}

/** The reverse: whole minutes read as minutes, everything else as seconds. */
export function secondsToDelay(seconds: number): { value: number; unit: DelayUnit } {
  if (seconds >= 60 && seconds % 60 === 0) return { value: seconds / 60, unit: 'minutes' };
  return { value: seconds, unit: 'seconds' };
}

/** Pure: the auto-send delay bounds, 3 seconds to 30 minutes, whole seconds. */
export function isDelayValid(seconds: number): boolean {
  return Number.isInteger(seconds) && seconds >= DELAY_MIN_SEC && seconds <= DELAY_MAX_SEC;
}

/** Pure: the turn cap bounds, 1 to 50. */
export function isTurnCapValid(value: number): boolean {
  return Number.isInteger(value) && value >= TURN_CAP_MIN && value <= TURN_CAP_MAX;
}

/** The header label for a mode. */
export function modeLabel(mode: string): string {
  return mode === 'approve_each' ? 'Approve each' : 'Manual';
}

/**
 * The panel's control state for a server value: which radio is checked, the
 * cap box's text, the checkbox, and the delay box/unit. Pure — the renderer
 * just applies it, so the panel can only ever show the server's truth.
 */
export function settingsControls(server: RelaySettings): {
  mode: 'manual' | 'approve_each';
  turnCap: string;
  autoSend: boolean;
  delay: { value: number; unit: DelayUnit };
} {
  return {
    mode: server.mode,
    turnCap: String(server.turnCap),
    autoSend: server.autoSend,
    delay: secondsToDelay(server.autoSendDelaySec),
  };
}

/** The exact frame the GUI sends (SPEC protocol table) — any subset. */
export function setModeFrame(update: {
  mode?: 'manual' | 'approve_each';
  turnCap?: number;
  autoSend?: boolean;
  autoSendDelaySec?: number;
}): { type: 'set_mode' } & Record<string, unknown> {
  return { type: 'set_mode', ...update };
}
