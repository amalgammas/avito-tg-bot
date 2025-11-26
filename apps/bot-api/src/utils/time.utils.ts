export const MOSCOW_TIMEZONE = 'Europe/Moscow';
export const MOSCOW_UTC_OFFSET_MINUTES = 3 * 60;
const MOSCOW_UTC_OFFSET_MS = MOSCOW_UTC_OFFSET_MINUTES * 60 * 1000;

export function toOzonIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function shiftToMoscowClock(source: Date): Date {
  return new Date(source.getTime() + MOSCOW_UTC_OFFSET_MS);
}

function shiftFromMoscowClock(source: Date): Date {
  return new Date(source.getTime() - MOSCOW_UTC_OFFSET_MS);
}

export function startOfMoscowDay(source: Date): Date {
  const date = shiftToMoscowClock(source);
  date.setUTCHours(0, 0, 0, 0);
  return shiftFromMoscowClock(date);
}

export function endOfMoscowDay(source: Date): Date {
  const date = shiftToMoscowClock(source);
  date.setUTCHours(23, 59, 59, 0);
  return shiftFromMoscowClock(date);
}

export function addMoscowDays(source: Date, days: number): Date {
  const date = shiftToMoscowClock(source);
  date.setUTCDate(date.getUTCDate() + days);
  return shiftFromMoscowClock(date);
}

export function formatTimeslotRange(
  fromIso?: string,
  toIso?: string,
  timezone?: string,
): string | undefined {
  if (!fromIso || !toIso) {
    return undefined;
  }

  try {
    const effectiveTimezone = timezone ?? MOSCOW_TIMEZONE;
    const options: Intl.DateTimeFormatOptions = {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    };
    const formatter = new Intl.DateTimeFormat('ru-RU', {
      ...options,
      timeZone: effectiveTimezone,
    });
    const fromText = formatter.format(new Date(fromIso));
    const toText = formatter.format(new Date(toIso));
    return timezone ? `${fromText} — ${toText} (${effectiveTimezone})` : `${fromText} — ${toText}`;
  } catch {
    return `${fromIso} — ${toIso}`;
  }
}

export function describeTimeslot(options: {
  from?: string;
  to?: string;
}): string | undefined {
  const { from, to } = options;
  if (!from || !to) {
    return undefined;
  }
  return `${from} — ${to}`;
}

export function parseIsoDate(value?: string): Date | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
