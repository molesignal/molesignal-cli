import { CHANGE, CHANGE_HELP, changeOptions, confirmations, makeChange, reportChange } from './changes.js';
import { type Command, CONNECTION, CONNECTION_HELP, parse, splitList, UsageError } from './command.js';
import { withSession } from './context.js';
import { parseTime } from './time.js';

export const annotateCommand: Command = {
  name: 'annotate',
  group: 'On-call and changes',
  summary: 'Mark a moment or a stretch of time on dashboards, such as a release',
  usage: `Usage: molesignal annotate "<title>" [options]

Adds an annotation that dashboards show at its time: on every dashboard, or
on one. It is made through MoleSignal's tool policy: at once, after you
confirm, or once reviewers approve.

Options:
  --description <text>   More about it
  --tags <a,b>           Tags to find it by
  --dashboard <id>       Only on this dashboard
  --stream <stream>      The stream it is about
  --time <time>          When (default now): 2026-10-26 14:00, an ISO time, or 10m (ago)
  --end <time>           When it ended, for a stretch of time
${CHANGE_HELP}
${CONNECTION_HELP}

Example:
  molesignal annotate "Release 2.4.0" --tags release,checkout --yes`,

  async run(args) {
    const { values, positionals } = parse('annotate', args, {
      ...CONNECTION,
      ...CHANGE,
      description: { type: 'string' },
      tags: { type: 'string' },
      dashboard: { type: 'string' },
      stream: { type: 'string' },
      time: { type: 'string' },
      end: { type: 'string' },
    });
    const title = positionals.join(' ').trim();
    if (!title) throw new UsageError('What does it say? Run `molesignal annotate "<title>"`');
    if (title.length > 500) throw new UsageError('A title has at most 500 characters');

    const now = Date.now() * 1000;
    const start = values.time ? parseTime(values.time, now) : now;
    const end = values.end ? parseTime(values.end, now) : start;
    if (end < start) throw new UsageError('--end comes before --time');
    const tags = splitList(values.tags);

    return withSession(
      values,
      async (session, signed) => {
        const options = changeOptions(values, signed.credentials.connection.url, {
          reason: 'Annotation from the molesignal command line',
          impact: `Dashboards show the annotation "${title}"${values.dashboard ? ` on dashboard ${values.dashboard}` : ''}`,
        });
        const outcome = await makeChange(
          session,
          'create_annotation',
          {
            title,
            time_start_micros: start,
            time_end_micros: end,
            ...(values.description ? { description: values.description } : {}),
            ...(tags.length ? { tags } : {}),
            ...(values.dashboard ? { dashboard_id: values.dashboard } : {}),
            ...(values.stream ? { stream_name: values.stream } : {}),
          },
          options,
        );
        return reportChange(outcome, `Annotated "${title}"`, options);
      },
      confirmations(values),
    );
  },
};
