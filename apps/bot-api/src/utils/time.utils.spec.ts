import {
  addMoscowDays,
  describeTimeslot,
  endOfMoscowDay,
  formatTimeslotRange,
  parseIsoDate,
  startOfMoscowDay,
  toOzonIso,
} from './time.utils';

describe('time.utils', () => {
  it('toOzonIso removes milliseconds and retains Z suffix', () => {
    const source = new Date(Date.UTC(2025, 4, 10, 12, 34, 56, 789));
    expect(toOzonIso(source)).toBe('2025-05-10T12:34:56Z');
  });

  it('startOfMoscowDay normalises time to 00:00:00.000 Moscow time (UTC+3)', () => {
    const source = new Date(Date.UTC(2025, 0, 1, 23, 59, 59, 999));
    const normalized = startOfMoscowDay(source);
    expect(normalized.toISOString()).toBe('2024-12-31T21:00:00.000Z');
  });

  it('endOfMoscowDay normalises time to 23:59:59.000 Moscow time (UTC+3)', () => {
    const source = new Date(Date.UTC(2025, 0, 1, 0, 0, 0, 0));
    const normalized = endOfMoscowDay(source);
    expect(normalized.toISOString()).toBe('2025-01-01T20:59:59.000Z');
  });

  it('addMoscowDays shifts date keeping Moscow time component', () => {
    const source = new Date(Date.UTC(2025, 0, 1, 8, 30, 0, 0));
    const shifted = addMoscowDays(source, 3);
    expect(shifted.toISOString()).toBe('2025-01-04T08:30:00.000Z');
  });

  it('formatTimeslotRange renders readable interval with timezone', () => {
    const formatted = formatTimeslotRange(
      '2025-05-01T07:00:00Z',
      '2025-05-01T08:00:00Z',
      'Asia/Yekaterinburg',
    );
    expect(formatted).toContain('01.05');
    expect(formatted).toContain('Asia/Yekaterinburg');
  });

  it('describeTimeslot returns formatted text only when both edges present', () => {
    expect(
      describeTimeslot({
        from: '2025-05-01T07:00:00Z',
        to: '2025-05-01T08:00:00Z',
      }),
    ).toBe('2025-05-01T07:00:00Z — 2025-05-01T08:00:00Z');
    expect(
      describeTimeslot({
        from: '2025-05-01T07:00:00Z',
      }),
    ).toBeUndefined();
  });

  it('parseIsoDate returns undefined for invalid values', () => {
    expect(parseIsoDate('2025-05-01T00:00:00Z')).toBeInstanceOf(Date);
    expect(parseIsoDate('not-a-date')).toBeUndefined();
    expect(parseIsoDate(undefined)).toBeUndefined();
  });
});
