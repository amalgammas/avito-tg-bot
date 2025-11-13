export function toOzonIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function startOfUtcDay(source: Date): Date {
  const date = new Date(source.getTime());
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export function endOfUtcDay(source: Date): Date {
  const date = new Date(source.getTime());
  date.setUTCHours(23, 59, 59, 0);
  return date;
}

export function addUtcDays(source: Date, days: number): Date {
  const date = new Date(source.getTime());
  date.setUTCDate(date.getUTCDate() + days);
  return date;
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
    const options: Intl.DateTimeFormatOptions = {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    };
    const formatter = new Intl.DateTimeFormat(
      'ru-RU',
      timezone ? { ...options, timeZone: timezone } : options,
    );
    const fromText = formatter.format(new Date(fromIso));
    const toText = formatter.format(new Date(toIso));
    return timezone ? `${fromText} — ${toText} (${timezone})` : `${fromText} — ${toText}`;
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
