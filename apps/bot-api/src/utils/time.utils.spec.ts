import {
  addUtcDays,
  describeTimeslot,
  endOfUtcDay,
  formatTimeslotRange,
  parseIsoDate,
  startOfUtcDay,
  toOzonIso,
} from './time.utils';

describe('time.utils', () => {
  it('toOzonIso removes milliseconds and retains Z suffix', () => {
    const source = new Date(Date.UTC(2025, 4, 10, 12, 34, 56, 789));
    expect(toOzonIso(source)).toBe('2025-05-10T12:34:56Z');
  });

  it('startOfUtcDay normalises time to 00:00:00.000 UTC', () => {
    const source = new Date(Date.UTC(2025, 0, 1, 23, 59, 59, 999));
    const normalized = startOfUtcDay(source);
    expect(normalized.getUTCHours()).toBe(0);
    expect(normalized.getUTCMinutes()).toBe(0);
    expect(normalized.getUTCSeconds()).toBe(0);
    expect(normalized.getUTCMilliseconds()).toBe(0);
    expect(normalized.getUTCDate()).toBe(1);
  });

  it('endOfUtcDay normalises time to 23:59:59.000 UTC', () => {
    const source = new Date(Date.UTC(2025, 0, 1, 0, 0, 0, 0));
    const normalized = endOfUtcDay(source);
    expect(normalized.getUTCHours()).toBe(23);
    expect(normalized.getUTCMinutes()).toBe(59);
    expect(normalized.getUTCSeconds()).toBe(59);
    expect(normalized.getUTCMilliseconds()).toBe(0);
  });

  it('addUtcDays shifts date keeping time component', () => {
    const source = new Date(Date.UTC(2025, 0, 1, 8, 30, 0, 0));
    const shifted = addUtcDays(source, 3);
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
