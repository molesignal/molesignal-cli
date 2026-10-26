import { createInterface } from 'node:readline/promises';

/**
 * Asks a yes-or-no question on the terminal, no being the answer when nothing
 * is typed. Without a terminal to ask on, as in CI or behind a pipe, the
 * answer is no: `--yes` says yes ahead of time.
 */
export async function confirm(question: string, options: { yes?: boolean | undefined } = {}): Promise<boolean> {
  if (options.yes) return true;
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;

  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await reader.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    reader.close();
  }
}
