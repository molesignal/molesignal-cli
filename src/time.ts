const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** `30s`, `10m`, `2h`, `1d` or `1w`, in milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(text.trim());
  const value = match ? Number(match[1]) * UNITS[match[2]!]! : Number.NaN;
  if (!(value > 0)) throw new Error(`"${text}" is not a duration: write it as 30s, 10m, 2h or 1d`);
  return value;
}

/**
 * A moment, in microseconds since the epoch, as it may be written: a time
 * (`2026-10-26T14:03:12Z`, `2026-10-26 14:03`, read as local time without a
 * zone), a date, a number of seconds, milliseconds or microseconds since the
 * epoch, or a duration back from now (`2h`).
 */
export function parseTime(text: string, nowMicros = Date.now() * 1000): number {
  const value = text.trim();
  if (/^\d+(?:\.\d+)?(ms|s|m|h|d|w)$/.test(value)) return Math.round(nowMicros - parseDuration(value) * 1000);
  if (/^\d+$/.test(value)) {
    const number = Number(value);
    // Seconds until the year 5138, then milliseconds, then microseconds.
    return number < 1e11 ? number * 1_000_000 : number < 1e14 ? number * 1000 : number;
  }

  // A date alone is midnight here, not in UTC as Date reads it.
  const written = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00` : value.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');
  const parsed = Date.parse(written);
  if (Number.isNaN(parsed)) {
    throw new Error(`"${text}" is not a time: write it as 2026-10-26T14:03:00Z, 2026-10-26 14:03, or 2h for two hours ago`);
  }
  // Date keeps milliseconds; the fraction a time was written with goes up to microseconds.
  const fraction = /\.(\d{4,6})/.exec(value)?.[1];
  const micros = fraction ? Number(fraction.padEnd(6, '0').slice(3)) : 0;
  return parsed * 1000 + micros;
}

/** A window of time as the tools take it. */
export interface TimeWindow {
  start_micros: number;
  end_micros: number;
}

/**
 * The window a command reads: from `--from` (or `--since` back from now,
 * else the default) to `--to` or now.
 */
export function timeWindow(
  options: { since?: string | undefined; from?: string | undefined; to?: string | undefined },
  defaultSince: string,
  nowMicros = Date.now() * 1000,
): TimeWindow {
  if (options.since && options.from) throw new Error('Give --since or --from, not both');
  const end = options.to ? parseTime(options.to, nowMicros) : nowMicros;
  const start = options.from
    ? parseTime(options.from, nowMicros)
    : end - Math.round(parseDuration(options.since ?? defaultSince) * 1000);
  if (start >= end) throw new Error('The window ends before it starts: --from must come before --to');
  return { start_micros: start, end_micros: end };
}

/** A moment as a clock reads it: `2026-10-26 14:03:12.345`, local or UTC. */
export function clock(micros: number, utc = false): string {
  const date = new Date(Math.floor(micros / 1000));
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const [year, month, day, hours, minutes, seconds, millis] = utc
    ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()]
    : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];
  return `${year}-${pad(month)}-${pad(day)} ${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

/** A moment to the minute, for tables: `2026-10-26 14:03`. */
export function minute(micros: number, utc = false): string {
  return clock(micros, utc).slice(0, 16);
}

/** A length of time for people: `850ms`, `1.2s`, `3m 05s`, `2h 10m`, `3d 4h`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1) return `${Math.round(ms * 1000)}µs`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1).replace(/\.?0+$/, '')}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  const hours = Math.round(minutes / 60);
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** How long ago a moment was: `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function ago(micros: number, nowMicros = Date.now() * 1000): string {
  const ms = (nowMicros - micros) / 1000;
  if (ms < 0) return `in ${formatDuration(-ms).split(' ')[0]}`;
  if (ms < 60_000) return 'just now';
  return `${formatDuration(ms).split(' ')[0]} ago`;
}
