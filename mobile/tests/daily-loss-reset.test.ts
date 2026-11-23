import { describe, expect, it } from 'vitest';
import { nextDailyLossReset } from '../src/lib/daily-loss-reset';

describe('daily loss reset at midnight Eastern', () => {
  it.each([
    ['2026-01-01T04:59:59.999Z', '2026-01-01T05:00:00.000Z'],
    ['2026-01-01T05:00:00.000Z', '2026-01-02T05:00:00.000Z'],
    ['2026-03-08T04:59:59.999Z', '2026-03-08T05:00:00.000Z'],
    ['2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['2026-03-09T04:30:00.000Z', '2026-03-10T04:00:00.000Z'],
    ['2026-11-01T03:59:59.999Z', '2026-11-01T04:00:00.000Z'],
    ['2026-11-01T04:30:00.000Z', '2026-11-02T05:00:00.000Z'],
    ['2026-11-02T04:30:00.000Z', '2026-11-02T05:00:00.000Z'],
  ])('returns the next reset after %s', (now, reset) => {
    expect(nextDailyLossReset(new Date(now)).toISOString()).toBe(reset);
  });
});
