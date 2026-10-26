import { type Command, CONNECTION, CONNECTION_HELP, parse, parseCount, UsageError } from './command.js';
import { signedIn, withSession } from './context.js';
import { type LogRow, rowsOf } from './logs.js';
import { cell, csv, cut, formatCount, print, printJsonLines, say, table, terminalWidth } from './output.js';
import { clock, formatDuration, timeWindow } from './time.js';
import { logsPage, openInBrowser, timeParam } from './web.js';

/** The stream a statement reads: the first name after `FROM`. */
export function streamOfSql(sql: string): string | undefined {
  const match = /\bFROM\s+("(?:[^"]|"")+"|[A-Za-z_][\w.-]*)/i.exec(sql);
  if (!match) return undefined;
  const name = match[1]!;
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name;
}

/** The columns of a result, in its order, else in the order the rows have them. */
export function columnsOf(result: unknown, rows: LogRow[]): string[] {
  if (result && typeof result === 'object' && 'columns' in result && Array.isArray(result.columns)) {
    return result.columns.map(String);
  }
  return [...new Set(rows.flatMap((row) => Object.keys(row)))];
}

/** Rows as a table for the terminal: times as clock times, long values cut. */
export function queryTable(
  columns: string[],
  rows: LogRow[],
  options: { utc?: boolean | undefined; width?: number | undefined } = {},
): string[] {
  const shown = rows.map((row) =>
    columns.map((column) => {
      const value = row[column];
      if (column === '_timestamp' && typeof value === 'number') return clock(value, options.utc ?? false);
      return cut(cell(value), 80);
    }),
  );
  return table(columns.map((column) => column.toUpperCase()), shown, { width: options.width });
}

export const queryCommand: Command = {
  name: 'query',
  group: 'Logs and queries',
  summary: 'Run SQL against a log stream; print a table, CSV or JSON',
  usage: `Usage: molesignal query "<SQL>" [options]

Runs one read-only SQL statement against a log stream, with joins,
expressions and aggregates, and prints the result as a table.

Options:
  --stream <stream>     The stream it reads (default: the first one after FROM)
  --since <duration>    How far back to look: 30s, 10m, 2h, 1d (default 1h)
  --from <time>         Start at a time instead: 2026-10-26 14:00, an ISO time, or 2h (ago)
  --to <time>           End at a time instead of now
  -n, --limit <count>   The most rows to print (default 1000, at most 5000)
  --csv                 Print CSV, with a head line
  --json                Print each row as one line of JSON
  --utc                 Print times in UTC instead of local time
  --web                 Open the statement in the Logs page instead
${CONNECTION_HELP}

Examples:
  molesignal query "SELECT level, COUNT(*) AS logs FROM app_logs GROUP BY level ORDER BY logs DESC"
  molesignal query "SELECT * FROM app_logs WHERE MATCH_TEXT(message, 'timeout')" --since 1d --csv > timeouts.csv`,

  async run(args) {
    const { values, positionals } = parse('query', args, {
      ...CONNECTION,
      stream: { type: 'string' },
      since: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      limit: { type: 'string', short: 'n' },
      csv: { type: 'boolean' },
      json: { type: 'boolean' },
      utc: { type: 'boolean' },
      web: { type: 'boolean' },
    });

    const sql = positionals.join(' ').trim();
    if (!sql) throw new UsageError('Which statement? Run `molesignal query "SELECT … FROM <stream>"`');
    const stream = values.stream ?? streamOfSql(sql);
    if (!stream) throw new UsageError('Which stream does it read? Add --stream <stream>');
    const window = timeWindow(values, '1h');

    if (values.web) {
      const signed = await signedIn(values);
      const time = timeParam({ from: window.start_micros, to: values.to ? window.end_micros : undefined });
      const url = logsPage(signed.credentials.connection.url, { stream, sql, time });
      say(`Opening ${url}`);
      openInBrowser(url);
      return;
    }

    const limit = parseCount(values.limit ?? '1000', '--limit', 5000);
    const result = await withSession(values, (session) =>
      session.call('query_logs', { stream, sql, time_range: window, limit }),
    );
    const rows = rowsOf(result);
    const columns = columnsOf(result, rows);

    if (values.json) printJsonLines(rows);
    else if (values.csv) print(csv(columns, rows.map((row) => columns.map((column) => row[column]))));
    else if (rows.length === 0) say('No rows');
    else print(queryTable(columns, rows, { utc: values.utc, width: terminalWidth() }));

    if (process.stderr.isTTY && !values.json && !values.csv && result && typeof result === 'object') {
      const stats = result as { scanned_rows?: number; took_ms?: number };
      const parts = [`${rows.length} row${rows.length === 1 ? '' : 's'}`];
      if (typeof stats.scanned_rows === 'number') parts.push(`scanned ${formatCount(stats.scanned_rows)}`);
      if (typeof stats.took_ms === 'number') parts.push(formatDuration(stats.took_ms));
      say(parts.join(' · '));
    }
  },
};
