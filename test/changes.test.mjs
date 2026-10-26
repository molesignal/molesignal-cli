import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeChange, reportChange } from '../dist/index.js';

/** A tool session that answers from a script of results, and keeps what it was asked. */
function session(script) {
  const asked = [];
  const answer = async (kind, name, args) => {
    asked.push({ kind, name, args });
    const reply = script[name];
    const value = typeof reply === 'function' ? reply(args, asked) : reply;
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    asked,
    call: (name, args) => answer('call', name, args),
    read: (name, args) => answer('read', name, args),
    manage: (name, args) => answer('manage', name, args),
  };
}

const said = [];
const options = (extra = {}) => ({
  reason: 'why',
  impact: 'what',
  approvalsPage: 'https://ms.example.com/agent/approvals',
  say: (line) => said.push(line),
  interval: 1,
  ...extra,
});

const executed = { operation_id: 'op1', approval_id: 'a1', status: 'succeeded', execution: { status: 'succeeded', output_summary: 'acknowledged' } };

test('a change the policy runs at once is done, with its reason and impact sent along', async () => {
  const tools = session({ acknowledge_incident: executed });
  const outcome = await makeChange(tools, 'acknowledge_incident', { incident_id: 'i1' }, options());
  assert.deepEqual(outcome, { state: 'done', approvalId: 'a1', execution: { status: 'succeeded', output_summary: 'acknowledged' } });
  assert.deepEqual(tools.asked[0].args, { incident_id: 'i1', reason: 'why', impact: 'what' });
  assert.equal(reportChange(outcome, 'Acknowledged incident i1', options()), 0);
  assert.equal(said.at(-1), 'Acknowledged incident i1: acknowledged');
});

test('a change to confirm runs through execute_agent_approval', async () => {
  const tools = session({
    create_annotation: { approval: { id: 'a2', status: 'approved', required_approvals: 0 }, message: 'created' },
    execute_agent_approval: executed,
  });
  const outcome = await makeChange(tools, 'create_annotation', { title: 'Release' }, options());
  assert.equal(outcome.state, 'done');
  assert.equal(tools.asked[1].name, 'execute_agent_approval');
  assert.equal(tools.asked[1].args.approval_id, 'a2');
});

test('a change that needs reviewers waits only when asked to', async () => {
  const pending = { approval: { id: 'a3', status: 'pending', required_approvals: 1 } };
  const waiting = await makeChange(session({ resolve_incident: pending }), 'resolve_incident', { incident_id: 'i1' }, options());
  assert.equal(waiting.state, 'pending');
  assert.equal(reportChange(waiting, '', options()), 3);
  assert.match(said.at(-1), /approval a3 at https:\/\/ms\.example\.com\/agent\/approvals/);

  let looks = 0;
  const tools = session({
    resolve_incident: pending,
    get_agent_approval: () => ({ id: 'a3', status: ++looks < 2 ? 'pending' : 'approved', required_approvals: 1 }),
    execute_agent_approval: executed,
  });
  const outcome = await makeChange(tools, 'resolve_incident', { incident_id: 'i1' }, options({ wait: 5000 }));
  assert.equal(outcome.state, 'done');
  assert.equal(looks, 2);
});

test('a rejected, declined or failed change says so and changes nothing', async () => {
  const pending = { approval: { id: 'a4', status: 'pending', required_approvals: 1 } };
  await assert.rejects(
    makeChange(session({ resolve_incident: pending, get_agent_approval: { id: 'a4', status: 'rejected' } }), 'resolve_incident', {}, options({ wait: 5000 })),
    /Approval a4 was rejected/,
  );
  await assert.rejects(
    makeChange(
      session({
        create_annotation: { approval: { id: 'a5', status: 'approved', required_approvals: 0 } },
        execute_agent_approval: new Error('the user declined or cancelled execution'),
      }),
      'create_annotation',
      {},
      options(),
    ),
    /Not confirmed/,
  );
  await assert.rejects(
    makeChange(session({ run_synthetic_monitor: { ...executed, execution: { status: 'failed', error: 'no location' } } }), 'run_synthetic_monitor', {}, options()),
    /could not carry out the change: no location/,
  );
});
