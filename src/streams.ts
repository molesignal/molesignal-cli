/** A log stream as `list_streams` describes it. */
export interface StreamSummary {
  name: string;
  field_count?: number | undefined;
  retention?: { days?: number | undefined } | null | undefined;
  description?: string | null | undefined;
}

/** The streams of a `list_streams` result. */
export function streamsOf(result: unknown): StreamSummary[] {
  if (!result || typeof result !== 'object' || !('streams' in result) || !Array.isArray(result.streams)) return [];
  return result.streams.filter(
    (stream: unknown): stream is StreamSummary =>
      Boolean(stream) && typeof stream === 'object' && typeof (stream as StreamSummary).name === 'string',
  );
}

/** The streams as a table: name, fields, retention and description, columns aligned. */
export function formatStreams(streams: StreamSummary[]): string[] {
  const rows = streams.map((stream) => [
    stream.name,
    stream.field_count === undefined ? '' : String(stream.field_count),
    stream.retention?.days ? `${stream.retention.days}d` : 'default',
    stream.description?.trim() ?? '',
  ]);
  const head = ['STREAM', 'FIELDS', 'RETENTION', 'DESCRIPTION'];
  const widths = head.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));

  return [head, ...rows].map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join('  ')
      .trimEnd(),
  );
}
