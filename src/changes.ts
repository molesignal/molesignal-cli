import { randomUUID } from 'node:crypto';

import { say } from './output.js';
import { confirm } from './prompt.js';
import { formatDuration, parseDuration } from './time.js';
import type { SessionOptions, ToolSession } from './tools.js';
import { pageOf } from './web.js';

/** The options of every command that asks for a change. */
export const CHANGE = {
  reason: { type: 'string' },
  wait: { type: 'boolean' },
  timeout: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
} as const;

/** The help lines of the change options, for a command's usage. */
export const CHANGE_HELP = `  --reason <text>    Why, kept with the approval and in the audit log
  --wait             When the change needs approval, wait for it, then carry the change out
  --timeout <time>   How long --wait waits (default 30m)
  -y, --yes          Confirm at once where MoleSignal asks to confirm a change`;

/** What a change command was given of the change options. */
export interface ChangeValues {
  reason?: string | undefined;
  wait?: boolean | undefined;
  timeout?: string | undefined;
  yes?: boolean | undefined;
}

/** How a command answers MoleSignal when it asks to confirm a change: on the terminal, or yes with --yes. */
export function confirmations(values: ChangeValues): SessionOptions {
  return { confirm: (message) => confirm(`${message}\nGo ahead?`, { yes: values.yes }) };
}

/** The options of a change, from the command's --reason, --wait and --timeout. */
export function changeOptions(
  values: ChangeValues,
  address: string,
  texts: { reason: string; impact: string },
): ChangeOptions {
  return {
    reason: values.reason?.trim() || texts.reason,
    impact: texts.impact,
    wait: values.wait ? parseDuration(values.timeout ?? '30m') : undefined,
    approvalsPage: pageOf(address, 'approvals', undefined).toString(),
    say,
  };
}

/** An approval request as MoleSignal keeps it. */
export interface Approval {
  id: string;
  status: string;
  action?: string | undefined;
  target?: string | undefined;
  reason?: string | undefined;
  impact?: string | undefined;
  risk?: string | undefined;
  required_approvals?: number | undefined;
  reviews?: unknown;
  requested_by?: string | undefined;
  expires_at?: number | null | undefined;
  created_at?: number | undefined;
}

/** How an approved change ran. */
export interface Execution {
  id?: string | undefined;
  /** What the change was made to, such as the id of a search job it submitted. */
  target?: string | undefined;
  status?: string | undefined;
  output_summary?: string | null | undefined;
  error?: string | null | undefined;
  verification?: unknown;
}

/** A change that ran, or one that waits for people to approve it. */
export type ChangeOutcome =
  | { state: 'done'; approvalId?: string | undefined; execution: Execution }
  | { state: 'pending'; approval: Approval };

export interface ChangeOptions {
  /** Why the change is made, kept with the approval and in the audit log. */
  reason: string;
  /** What the change does, shown to whoever approves it. */
  impact: string;
  /** How long to wait for reviewers, in milliseconds; without it a change that needs them is left waiting. */
  wait?: number | undefined;
  /** How long between looks at an approval that waits. */
  interval?: number | undefined;
  /** Where approvals are reviewed, for the messages. */
  approvalsPage: string;
  say: (line: string) => void;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The approval in a tool result: the result itself, or its `approval`. */
export function approvalOf(value: unknown): Approval | undefined {
  const approval = isObject(value) && isObject(value.approval) ? value.approval : value;
  return isObject(approval) && typeof approval.id === 'string' && typeof approval.status === 'string'
    ? (approval as unknown as Approval)
    : undefined;
}

/** The execution in a result that says a change ran. */
function executionOf(value: unknown): Execution | undefined {
  if (!isObject(value) || typeof value.operation_id !== 'string') return undefined;
  const execution = isObject(value.execution) ? (value.execution as Execution) : {};
  return { ...execution, status: execution.status ?? (typeof value.status === 'string' ? value.status : undefined) };
}

/** Throws when the change ran and failed. */
function checked(execution: Execution): Execution {
  if (execution.status === 'failed') {
    throw new Error(`MoleSignal could not carry out the change: ${execution.error ?? execution.output_summary ?? 'it failed'}`);
  }
  return execution;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs an approved change now; MoleSignal may ask to confirm it first. */
async function execute(session: ToolSession, approval: Approval, options: ChangeOptions): Promise<ChangeOutcome> {
  let result: unknown;
  try {
    result = await session.call('execute_agent_approval', { approval_id: approval.id, idempotency_key: randomUUID() });
  } catch (error) {
    const message = (error as Error).message;
    if (/declined or cancelled/i.test(message)) {
      throw new Error('Not confirmed, so nothing was changed. Answer y, or add --yes where there is no terminal to ask on');
    }
    if (/2026-07-28/.test(message)) {
      throw new Error(
        `MoleSignal asks for this change to be confirmed, which this connection cannot do. Confirm approval ${approval.id} at ${options.approvalsPage}`,
      );
    }
    throw error;
  }
  return { state: 'done', approvalId: approval.id, execution: checked(executionOf(result) ?? {}) };
}

/** How an approval that someone else carried out ran. */
async function executionFor(session: ToolSession, approvalId: string): Promise<Execution> {
  const executions = await session.call('list_agent_executions', { limit: 100 });
  const found = Array.isArray(executions)
    ? executions.find((execution) => isObject(execution) && execution.approval_request_id === approvalId)
    : undefined;
  return (found as Execution | undefined) ?? { status: 'succeeded' };
}

/**
 * Takes an approval to its end: an approved one runs now, after the
 * confirmation MoleSignal may ask for; one that waits for reviewers is
 * returned as it is, or, with `wait`, looked at until they decide.
 */
export async function followApproval(session: ToolSession, approval: Approval, options: ChangeOptions): Promise<ChangeOutcome> {
  const deadline = Date.now() + (options.wait ?? 0);
  let current = approval;
  let told = false;

  for (;;) {
    if (current.status === 'approved') return execute(session, current, options);
    if (current.status === 'executed') {
      return { state: 'done', approvalId: current.id, execution: checked(await executionFor(session, current.id)) };
    }
    if (current.status !== 'pending') throw new Error(`Approval ${current.id} was ${current.status}: nothing was changed`);
    if (!options.wait) return { state: 'pending', approval: current };

    if (!told) {
      const reviewers = current.required_approvals ?? 1;
      options.say(`Waiting for ${reviewers} approval${reviewers === 1 ? '' : 's'} of ${current.id} at ${options.approvalsPage}`);
      told = true;
    }
    if (Date.now() >= deadline) {
      throw new Error(`No decision on approval ${current.id} within ${formatDuration(options.wait)}; nothing was changed yet`);
    }
    await sleep(Math.min(options.interval ?? 5000, Math.max(0, deadline - Date.now())));
    current = approvalOf(await session.call('get_agent_approval', { approval_id: current.id })) ?? current;
  }
}

/**
 * Asks MoleSignal for a change through a managed tool and takes it as far as
 * it goes: it runs at once when the organization's tool policy lets it, after
 * a confirmation when the policy asks for one, or waits for reviewers.
 */
export async function makeChange(
  session: ToolSession,
  tool: string,
  args: Record<string, unknown>,
  options: ChangeOptions,
): Promise<ChangeOutcome> {
  const result = await session.manage(tool, { ...args, reason: options.reason, impact: options.impact }, randomUUID());

  const execution = executionOf(result);
  if (execution) {
    const approvalId = isObject(result) && typeof result.approval_id === 'string' ? result.approval_id : undefined;
    return { state: 'done', approvalId, execution: checked(execution) };
  }

  const approval = approvalOf(result);
  if (!approval) throw new Error(`MoleSignal answered ${tool} with neither an approval nor an execution`);
  return followApproval(session, approval, options);
}

/**
 * Says how a change ended and returns the exit status: 0 when it ran, 3 when
 * it waits for approval.
 */
export function reportChange(outcome: ChangeOutcome, done: string, options: { approvalsPage: string; say: (line: string) => void }): number {
  if (outcome.state === 'done') {
    const summary = outcome.execution.output_summary;
    options.say(summary ? `${done}: ${summary}` : done);
    return 0;
  }
  const { approval } = outcome;
  const reviewers = approval.required_approvals ?? 1;
  options.say(
    `Waiting for ${reviewers} approval${reviewers === 1 ? '' : 's'}: approval ${approval.id} at ${options.approvalsPage}. ` +
      `Once approved, run \`molesignal approvals execute ${approval.id}\`, or add --wait next time.`,
  );
  return 3;
}
