import {
  type Approval,
  approvalOf,
  CHANGE,
  changeOptions,
  confirmations,
  followApproval,
  reportChange,
} from './changes.js';
import { type Command, CONNECTION, CONNECTION_HELP, onePositional, parse, parseCount, UsageError } from './command.js';
import { withSession } from './context.js';
import { labelled, paint, print, printJson, printJsonLines, say, stateColor, table, terminalWidth, useColor } from './output.js';
import { ago, minute } from './time.js';

/** The approvals of a `list_agent_approvals` result. */
export function approvalsOf(result: unknown): Approval[] {
  return Array.isArray(result) ? result.map(approvalOf).filter((approval): approval is Approval => Boolean(approval)) : [];
}

/** How many reviews an approval has of those it needs: `1/2`. */
function reviewsOf(approval: Approval): string {
  const given = Array.isArray(approval.reviews) ? approval.reviews.length : 0;
  return approval.required_approvals ? `${given}/${approval.required_approvals}` : 'confirm';
}

/** Approvals as a table: id, status, action, target, reviews, age and reason. */
export function formatApprovals(approvals: Approval[], options: { color?: boolean; width?: number | undefined; now?: number } = {}): string[] {
  const color = options.color ?? false;
  const rows = approvals.map((approval) => [
    approval.id,
    paint(color, stateColor(approval.status), approval.status),
    approval.action ?? '',
    approval.target ?? '',
    reviewsOf(approval),
    approval.created_at ? ago(approval.created_at, options.now) : '',
    approval.reason ?? '',
  ]);
  return table(['APPROVAL', 'STATUS', 'ACTION', 'TARGET', 'REVIEWS', 'ASKED', 'REASON'], rows, options);
}

const usage = `Usage: molesignal approvals [options]
       molesignal approvals show <approval>
       molesignal approvals execute <approval>

Lists the approval requests of Mole Agent and of changes asked for over MCP
or with this command: those waiting, and those approved but not carried out.
\`execute\` carries out an approved change; MoleSignal may ask you to confirm.

Options:
  --all                 List every approval, decided ones too
  -n, --limit <count>   How many approvals (default 50, at most 500)
  --wait                With execute: wait for reviewers first
  --timeout <time>      How long --wait waits (default 30m)
  -y, --yes             Confirm at once where MoleSignal asks to confirm
  --json                Print JSON
${CONNECTION_HELP}

Exit status of execute: 0 when carried out, 3 when it still waits for approval.`;

export const approvalsCommand: Command = {
  name: 'approvals',
  group: 'On-call and changes',
  summary: 'Approval requests of Mole Agent and of changes: list, show, execute',
  usage,

  async run(args) {
    const { values, positionals } = parse('approvals', args, {
      ...CONNECTION,
      ...CHANGE,
      all: { type: 'boolean' },
      limit: { type: 'string', short: 'n' },
      json: { type: 'boolean' },
    });
    const [action, ...rest] = positionals;

    if (action === 'show') {
      const id = onePositional('approvals', rest, 'approval');
      const approval = await withSession(values, (session) => session.call('get_agent_approval', { approval_id: id }));
      if (values.json) {
        printJson(approval);
        return;
      }
      const found = approvalOf(approval);
      if (!found) throw new Error(`No approval ${id}`);
      const lines = [`${found.id} · ${paint(useColor(), stateColor(found.status), found.status)} · ${found.risk ?? ''}`];
      const field = (name: string, value: string | undefined) => {
        if (value) lines.push(labelled(name, value, 10));
      };
      field('Action', found.action);
      field('Target', found.target);
      field('Reason', found.reason);
      field('Impact', found.impact);
      field('Reviews', reviewsOf(found));
      field('Asked', found.created_at ? minute(found.created_at) : undefined);
      field('Expires', typeof found.expires_at === 'number' ? minute(found.expires_at) : undefined);
      print(lines);
      return;
    }

    if (action === 'execute') {
      const id = onePositional('approvals', rest, 'approval');
      return withSession(
        values,
        async (session, signed) => {
          const options = changeOptions(values, signed.credentials.connection.url, { reason: '', impact: '' });
          const approval = approvalOf(await session.call('get_agent_approval', { approval_id: id }));
          if (!approval) throw new Error(`No approval ${id}`);
          const outcome = await followApproval(session, approval, options);
          return reportChange(outcome, `Carried out approval ${id}`, options);
        },
        confirmations(values),
      );
    }

    if (action) throw new UsageError(`Unknown "${action}": use show or execute; see \`molesignal approvals --help\``);

    const limit = parseCount(values.limit ?? '50', '--limit', 500);
    const approvals = approvalsOf(await withSession(values, (session) => session.call('list_agent_approvals', { limit: 500 })))
      .filter((approval) => values.all || approval.status === 'pending' || approval.status === 'approved')
      .slice(0, limit);
    if (values.json) printJsonLines(approvals);
    else if (approvals.length === 0) say(values.all ? 'No approvals' : 'No approvals waiting');
    else print(formatApprovals(approvals, { color: useColor(), width: terminalWidth() }));
  },
};
