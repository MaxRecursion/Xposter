/**
 * Consecutive scheduled reply runs that produce neither a post nor an
 * approval candidate. After two empties, one ntfy alert; the latch stays
 * until a later run actually delivers.
 */
import { logEvent } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { sendStalledDeliveryNotification } from '../notifications/ntfy.js';

const ALERT_AFTER = 2;

let _consecutiveEmpty = 0;
let _alertLatched = false;

export interface DeliveryTally {
  posted: number;
  pendingApproval: number;
}

export function getStalledDeliveryState(): {
  consecutiveEmpty: number;
  alertLatched: boolean;
} {
  return { consecutiveEmpty: _consecutiveEmpty, alertLatched: _alertLatched };
}

export function resetStalledDeliveryState(): void {
  _consecutiveEmpty = 0;
  _alertLatched = false;
}

export async function notePipelineDelivery(tally: DeliveryTally): Promise<{
  consecutiveEmpty: number;
  alerted: boolean;
}> {
  const delivered = tally.posted + tally.pendingApproval;
  if (delivered > 0) {
    _consecutiveEmpty = 0;
    _alertLatched = false;
    return { consecutiveEmpty: 0, alerted: false };
  }

  _consecutiveEmpty += 1;
  if (_consecutiveEmpty < ALERT_AFTER || _alertLatched) {
    return { consecutiveEmpty: _consecutiveEmpty, alerted: false };
  }

  _alertLatched = true;
  logEvent(
    'PIPELINE_STALLED',
    `${_consecutiveEmpty} consecutive runs with no posted reply or approval candidate`,
  );
  logger.warn('Reply pipeline stalled', { consecutiveEmpty: _consecutiveEmpty });
  try {
    await sendStalledDeliveryNotification(_consecutiveEmpty);
  } catch (err) {
    logger.warn('Stalled-delivery ntfy failed', { err: String(err) });
  }
  return { consecutiveEmpty: _consecutiveEmpty, alerted: true };
}
