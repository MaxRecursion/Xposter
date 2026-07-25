import { getIntSetting } from '../storage/settings.js';
import { pickWeightedOffsetMinute } from './audience_weights.js';

export interface ActiveWindow {
  startHour: number;
  endHour: number;
  startMs: number;
  endMs: number;
  totalMinutes: number;
}

export function todayDateKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatLocalTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * The daily window a scheduler may fire in.
 *
 * The setting keys are parameterised so schedulers with their own window (image
 * posts run in the evening) can reuse the slot machinery instead of rolling
 * their own plan table.
 */
export function getActiveWindow(
  dateKey: string,
  startKey = 'active_window_start_hour',
  endKey = 'active_window_end_hour',
  defaults: { start: number; end: number } = { start: 9, end: 22 },
): ActiveWindow {
  const startHour = getIntSetting(startKey, defaults.start, 0, 23);
  const endHourRaw = getIntSetting(endKey, defaults.end, 1, 24);
  const endHour = endHourRaw <= startHour ? startHour + 1 : endHourRaw;

  const [y, m, d] = dateKey.split('-').map(Number);
  const startMs = new Date(y, m - 1, d, startHour, 0, 0).getTime();
  const endMs = new Date(y, m - 1, d, endHour, 0, 0).getTime();
  const totalMinutes = Math.floor((endMs - startMs) / 60_000);

  return { startHour, endHour, startMs, endMs, totalMinutes };
}

export function generateWeightedSlots(
  count: number,
  dateKey: string,
  nowSec = Math.floor(Date.now() / 1000),
  window: ActiveWindow = getActiveWindow(dateKey),
): number[] {
  if (count <= 0) return [];
  if (window.totalMinutes <= 0) return [];

  const slotMin = Math.floor(window.totalMinutes / count);
  const picks: number[] = [];

  for (let i = 0; i < count; i++) {
    const slotStart = i * slotMin;
    const slotEnd = (i + 1) * slotMin;
    const offsetMin = pickWeightedOffsetMinute(window.startMs, slotStart, slotEnd);
    const ts = Math.floor((window.startMs + offsetMin * 60_000) / 1000);
    if (ts > nowSec + 60) picks.push(ts);
  }

  return picks;
}
