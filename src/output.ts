/** Whether to print colours: on a terminal, unless NO_COLOR says otherwise; FORCE_COLOR asks for them anyway. */
export function useColor(stream: NodeJS.WriteStream = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  const forced = env.FORCE_COLOR;
  if (forced !== undefined && forced !== '' && forced !== '0' && forced !== 'false') return true;
  return stream.isTTY === true && !env.NO_COLOR;
}

/** Text in an ANSI colour (`31` red, `32` green, `33` yellow, `36` cyan, `90` grey), when colours are on. */
export const paint = (on: boolean, code: string | undefined, value: string): string =>
  on && code ? `\u001b[${code}m${value}\u001b[0m` : value;

/** A colour for a word that says how something is: red for trouble, yellow for a warning, green for well. */
export function stateColor(word: string): string | undefined {
  const value = word.toLowerCase();
  if (/^(fatal|crit|critical|emerg|alert|err|error|failed|failing|rejected|regressed|unhealthy|open|firing)/.test(value)) return '31';
  if (/^(warn|warning|degraded|flaky|pending|acknowledged|running|expired|insufficient)/.test(value)) return '33';
  if (/^(ok|healthy|succeeded|resolved|done|executed|approved|improved|passed|closed)/.test(value)) return '32';
  if (/^(debug|trace|unknown|skipped|cancelled|neutral|no_traffic)/.test(value)) return '90';
  return undefined;
}

/** How wide text is on a terminal: East Asian wide characters take two columns, colour codes none. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text.replace(/\u001b\[[0-9;]*m/g, '')) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x300 && code < 0x370) || code === 0x200b) continue;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd)
        ? 2
        : 1;
  }
  return width;
}

/** Text padded with spaces to a width, by how wide it shows. */
export function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** Text cut to a width with `…`, by how wide it shows; colour codes are dropped from cut text. */
export function cut(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let kept = '';
  for (const character of text.replace(/\u001b\[[0-9;]*m/g, '')) {
    if (displayWidth(kept + character) > width - 1) break;
    kept += character;
  }
  return `${kept}…`;
}

/** A `Name: value` line, values lined up at `width`, with a space at least after a longer name. */
export function labelled(name: string, value: string, width: number): string {
  const label = `${name}:`;
  return `${label}${' '.repeat(Math.max(1, width - label.length))}${value}`;
}

/** A value as a table shows it: text as it is, nothing as empty, anything else as JSON. */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\s*\n\s*/g, ' ');
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

/**
 * Rows as a table: a head, then the rows, columns aligned. On a terminal
 * the last column is cut to the width there is, so a row stays one line.
 */
export function table(head: string[], rows: string[][], options: { width?: number | undefined } = {}): string[] {
  const widths = head.map((title, column) =>
    Math.max(displayWidth(title), ...rows.map((row) => displayWidth(row[column] ?? ''))),
  );
  const last = head.length - 1;
  const before = widths.slice(0, last).reduce((sum, width) => sum + width + 2, 0);
  const room = options.width ? Math.max(10, options.width - before) : undefined;

  return [head, ...rows].map((row) =>
    row
      .map((value, column) =>
        column === last ? (room ? cut(value, room) : value) : padTo(value, widths[column]!),
      )
      .join('  ')
      .trimEnd(),
  );
}

/** The width a table may take: the terminal's, or none when the output is not a terminal. */
export function terminalWidth(stream: NodeJS.WriteStream = process.stdout): number | undefined {
  return stream.isTTY ? stream.columns : undefined;
}

/** A value as CSV writes it: quoted when it holds a comma, a quote or a line break. */
function csvValue(value: unknown): string {
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Rows as CSV: a head, then one line a row. */
export function csv(head: string[], rows: unknown[][]): string[] {
  return [head, ...rows].map((row) => row.map(csvValue).join(','));
}

/** A count for people: `950`, `12.3k`, `4.5M`. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '';
  const size = Math.abs(value);
  if (size < 1000) return String(Math.round(value * 100) / 100);
  if (size < 1_000_000) return `${(value / 1000).toFixed(size < 10_000 ? 1 : 0)}k`;
  if (size < 1_000_000_000) return `${(value / 1_000_000).toFixed(size < 10_000_000 ? 1 : 0)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

/** A share as a percentage: `0.12%`, `4.5%`, `100%`. */
export function formatPercent(share: number): string {
  if (!Number.isFinite(share)) return '';
  const percent = share * 100;
  if (percent === 0) return '0%';
  if (percent < 1) return `${percent.toFixed(2)}%`;
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

/** A size in bytes for people: `850 B`, `1.2 KiB`, `3.4 MiB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const BARS = '▁▂▃▄▅▆▇█';

/** Values as a line of bars, lowest to highest: `▁▃▅█▆`. */
export function sparkline(values: number[]): string {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return '';
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  return values
    .map((value) => {
      if (!Number.isFinite(value)) return ' ';
      if (high === low) return BARS[3];
      return BARS[Math.round(((value - low) / (high - low)) * (BARS.length - 1))];
    })
    .join('');
}

/** At most `count` values, spread evenly over all of them, for a sparkline that fits. */
export function evenly<T>(values: T[], count: number): T[] {
  if (values.length <= count) return values;
  return Array.from({ length: count }, (_, index) => values[Math.round((index * (values.length - 1)) / (count - 1))]!);
}

/** Writes lines to stdout, each ended with a line break. */
export function print(lines: string[] | string): void {
  const text = Array.isArray(lines) ? lines.join('\n') : lines;
  if (text) process.stdout.write(`${text}\n`);
}

/** Writes each value as one line of JSON. */
export function printJsonLines(values: unknown[]): void {
  for (const value of values) process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Writes a value as indented JSON. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Says something on stderr, apart from the output. */
export const say = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
