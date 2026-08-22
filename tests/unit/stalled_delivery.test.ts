import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../src/notifications/ntfy.js', () => ({
  sendStalledDeliveryNotification: vi.fn().mockResolvedValue({ ok: true }),
}));

const TEST_DB_RELATIVE = 'data/test-stalled-delivery.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

describe('stalled delivery latch', () => {
  beforeEach(async () => {
    vi.resetModules();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
    const { resetStalledDeliveryState } = await import('../../src/pipeline/stalled_delivery.js');
    resetStalledDeliveryState();
  });

  afterEach(async () => {
    const { resetStalledDeliveryState } = await import('../../src/pipeline/stalled_delivery.js');
    resetStalledDeliveryState();
    delete process.env.DB_PATH_OVERRIDE;
    removeTestDb();
  });

  it('alerts once after two empty runs and stays latched until a delivery', async () => {
    const { notePipelineDelivery, getStalledDeliveryState } = await import('../../src/pipeline/stalled_delivery.js');
    const { sendStalledDeliveryNotification } = await import('../../src/notifications/ntfy.js');

    const first = await notePipelineDelivery({ posted: 0, pendingApproval: 0 });
    expect(first).toEqual({ consecutiveEmpty: 1, alerted: false });
    expect(sendStalledDeliveryNotification).not.toHaveBeenCalled();

    const second = await notePipelineDelivery({ posted: 0, pendingApproval: 0 });
    expect(second).toEqual({ consecutiveEmpty: 2, alerted: true });
    expect(sendStalledDeliveryNotification).toHaveBeenCalledTimes(1);

    const third = await notePipelineDelivery({ posted: 0, pendingApproval: 0 });
    expect(third.alerted).toBe(false);
    expect(sendStalledDeliveryNotification).toHaveBeenCalledTimes(1);
    expect(getStalledDeliveryState().alertLatched).toBe(true);

    const recovered = await notePipelineDelivery({ posted: 1, pendingApproval: 0 });
    expect(recovered).toEqual({ consecutiveEmpty: 0, alerted: false });
    expect(getStalledDeliveryState()).toEqual({ consecutiveEmpty: 0, alertLatched: false });

    await notePipelineDelivery({ posted: 0, pendingApproval: 0 });
    await notePipelineDelivery({ posted: 0, pendingApproval: 0 });
    expect(sendStalledDeliveryNotification).toHaveBeenCalledTimes(2);
  });
});
