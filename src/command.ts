import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

/** A mistake in how a command was written: the command exits with 2 and points at its help. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** A command of `molesignal`: what it does in a line, how it is used, and what runs it. */
export interface Command {
  name: string;
  /** The heading it is listed under in `molesignal --help`. */
  group: string;
  summary: string;
  usage: string;
  /** Runs the command; what it returns is the exit status, 0 when nothing. */
  run(args: string[]): Promise<number | void>;
}

/** The options of every command that talks to MoleSignal. */
export const CONNECTION = {
  url: { type: 'string' },
  token: { type: 'string' },
  profile: { type: 'string' },
} as const satisfies ParseArgsOptionsConfig;

/** The help lines of the connection options, for a command's usage. */
export const CONNECTION_HELP = `  --profile <name>   The saved sign-in to use (molesignal profiles lists them)
  --url <address>    The MoleSignal address, instead of the saved one
  --token <token>    An API token for this command only`;

/** Reads a command's arguments; a mistake in them is a usage error that names the command. */
export function parse<const O extends ParseArgsOptionsConfig>(command: string, args: string[], options: O) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    const reason = (error as Error).message.split('. ')[0]!.replace(/\.$/, '');
    throw new UsageError(`${reason}; see \`molesignal ${command} --help\``);
  }
}

/** Whether the arguments ask for the command's help. */
export function wantsHelp(args: string[]): boolean {
  const end = args.indexOf('--');
  return (end < 0 ? args : args.slice(0, end)).some((arg) => arg === '-h' || arg === '--help');
}

/** A whole number from 1 to `maximum`, as an option gives it. */
export function parseCount(text: string, name: string, maximum: number): number {
  const count = Number(text);
  if (!Number.isInteger(count) || count < 1 || count > maximum) {
    throw new UsageError(`${name} takes a whole number from 1 to ${maximum}`);
  }
  return count;
}

/** The items of a comma-separated list, trimmed, empty ones left out. */
export function splitList(text: string | undefined): string[] {
  return (text ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** `name=value` pairs as an object: `--field service=cron --field team=ops`. */
export function keyValues(pairs: string[] | undefined, option: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const index = pair.indexOf('=');
    if (index < 1) throw new UsageError(`${option} takes name=value, not "${pair}"`);
    values[pair.slice(0, index).trim()] = pair.slice(index + 1);
  }
  return values;
}

/** The one positional argument a command takes, or a usage error that says what it is. */
export function onePositional(command: string, positionals: string[], what: string): string {
  const [value, ...extra] = positionals;
  if (!value) throw new UsageError(`Which ${what}? See \`molesignal ${command} --help\``);
  if (extra.length > 0) throw new UsageError(`Unexpected "${extra[0]}"; see \`molesignal ${command} --help\``);
  return value;
}
