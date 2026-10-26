#!/usr/bin/env node
import { loginCommand, logoutCommand, profilesCommand, statusCommand, useCommand, whoamiCommand } from './account.js';
import { annotateCommand } from './annotate.js';
import { approvalsCommand } from './approvals.js';
import { sourceMapsCommand, symbolsCommand } from './artifacts.js';
import { callCommand, toolsCommand } from './catalog.js';
import { type Command, UsageError, wantsHelp } from './command.js';
import { completionCommand, completions } from './completion.js';
import { deployCommand } from './deploy.js';
import { doctorCommand } from './doctor.js';
import { fieldsCommand } from './fields.js';
import { incidentsCommand } from './incidents.js';
import { runCommand, sendCommand } from './intake.js';
import { searchJobsCommand } from './jobs.js';
import { logsCommand } from './logs.js';
import { describeError } from './mcp.js';
import { metricsCommand } from './metrics.js';
import { oncallCommand } from './oncall.js';
import { openCommand } from './open.js';
import { queryCommand } from './query.js';
import { servicesCommand } from './services.js';
import { mcpCommand } from './setup.js';
import { streamsCommand } from './streams.js';
import { syntheticsCommand } from './synthetics.js';
import { tracesCommand } from './traces.js';
import { VERSION } from './version.js';

const COMMANDS: Command[] = [
  loginCommand,
  logoutCommand,
  profilesCommand,
  useCommand,
  statusCommand,
  whoamiCommand,
  doctorCommand,
  streamsCommand,
  logsCommand,
  queryCommand,
  fieldsCommand,
  metricsCommand,
  tracesCommand,
  servicesCommand,
  searchJobsCommand,
  incidentsCommand,
  oncallCommand,
  approvalsCommand,
  annotateCommand,
  syntheticsCommand,
  deployCommand,
  sourceMapsCommand,
  symbolsCommand,
  sendCommand,
  runCommand,
  toolsCommand,
  callCommand,
  mcpCommand,
  openCommand,
  completionCommand(() => COMMANDS),
];

/** `molesignal --help`: the commands by group, and what every command takes. */
function help(): string {
  const groups = new Map<string, Command[]>();
  for (const command of COMMANDS) groups.set(command.group, [...(groups.get(command.group) ?? []), command]);
  const sections = [...groups].map(
    ([group, commands]) => `${group}:\n${commands.map((command) => `  ${command.name.padEnd(13)}${command.summary}`).join('\n')}`,
  );

  return `molesignal ${VERSION} — MoleSignal on the command line

Usage: molesignal <command> [options]

${sections.join('\n\n')}

Every command that talks to MoleSignal takes:
  --profile <name>  The saved sign-in to use (molesignal profiles lists them)
  --url <address>   The MoleSignal address, such as https://molesignal.example.com
  --token <token>   An API token for this command only

  molesignal <command> --help   says what a command does and takes
  -v, --version                 prints the version

Environment:
  MOLESIGNAL_URL      The address, instead of --url or the saved one
  MOLESIGNAL_TOKEN    An API token, instead of the saved sign-in
  MOLESIGNAL_PROFILE  The profile, instead of the one \`molesignal use\` chose
  MOLESIGNAL_CONFIG   Where sign-ins are kept (default ~/.config/molesignal/config.json)
  HTTPS_PROXY         A proxy for every request; NO_PROXY lists hosts reached without it
  NO_COLOR            Print without colours; FORCE_COLOR prints them even into a pipe

Examples:
  molesignal login --url https://molesignal.example.com
  molesignal logs app_logs -f -q "level = 'error'"
  molesignal deploy --service checkout --version 2.4.0 --env production
  npx -y @molesignal/cli mcp     the command an agent tool such as Claude Code starts
`;
}

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  try {
    if (name === undefined || name === '-h' || name === '--help') {
      process.stdout.write(help());
      return 0;
    }
    if (name === '-v' || name === '--version' || name === 'version') {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (name === '__complete') {
      for (const word of await completions(rest[0] ?? '')) process.stdout.write(`${word}\n`);
      return 0;
    }
    if (name === 'help') {
      const command = COMMANDS.find((candidate) => candidate.name === rest[0]);
      process.stdout.write(command ? `${command.usage}\n` : help());
      return 0;
    }

    const command = COMMANDS.find((candidate) => candidate.name === name);
    if (!command) {
      process.stderr.write(`Unknown command "${name}". Run \`molesignal --help\`.\n`);
      return 2;
    }
    if (wantsHelp(rest)) {
      process.stdout.write(`${command.usage}\n`);
      return 0;
    }
    return (await command.run(rest)) ?? 0;
  } catch (error) {
    process.stderr.write(`molesignal: ${describeError(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
