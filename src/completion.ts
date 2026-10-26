import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { type Command, onePositional, parse, UsageError } from './command.js';
import { ConfigStore, configPath, profileName } from './config.js';
import { withSession } from './context.js';
import { print } from './output.js';
import { streamsOf } from './streams.js';
import { PAGES } from './web.js';

/** The words that may follow a command: its subcommands, or what its first argument names. */
const NEXT: Record<string, string> = {
  metrics: 'query names labels values series',
  traces: 'show',
  services: 'show compare',
  'search-jobs': 'submit show results cancel',
  incidents: 'show ack resolve',
  approvals: 'show execute',
  synthetics: 'results run',
  'source-maps': 'upload list delete',
  symbols: 'upload list delete',
  mcp: 'setup',
  profiles: 'remove',
  tools: 'show',
  completion: 'bash zsh fish',
  open: Object.keys(PAGES).join(' '),
};

/** The commands whose first argument is a stream. */
const STREAM_FIRST = ['logs', 'fields', 'send', 'run'];

/** How long the stream names fetched for completion are kept. */
const STREAMS_KEPT_MS = 5 * 60_000;

/** The stream names of the current profile, from a cache kept a few minutes, else from MoleSignal. */
async function streamNames(): Promise<string[]> {
  const store = await ConfigStore.open();
  const profile = profileName(undefined, process.env, store.config);
  const cache = join(dirname(configPath()), 'cache', `streams-${profile}.json`);

  const fresh = await stat(cache).then((info) => Date.now() - info.mtimeMs < STREAMS_KEPT_MS, () => false);
  if (fresh) return JSON.parse(await readFile(cache, 'utf8')) as string[];

  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 5000).unref());
  const names = await Promise.race([
    withSession({}, async (session) => {
      const lists = await Promise.all(
        ['logs', 'traces', 'metrics'].map(async (type) => streamsOf(await session.call('list_streams', { stream_type: type, limit: 1000 }))),
      );
      return [...new Set(lists.flat().map((stream) => stream.name))].sort();
    }),
    timeout,
  ]);
  await mkdir(dirname(cache), { recursive: true, mode: 0o700 });
  await writeFile(cache, JSON.stringify(names), { mode: 0o600 });
  return names;
}

/** What `molesignal __complete <what>` prints: stream names, profiles or pages. */
export async function completions(what: string): Promise<string[]> {
  if (what === 'streams') return streamNames().catch(() => []);
  if (what === 'profiles') return (await ConfigStore.open()).names;
  if (what === 'pages') return Object.keys(PAGES);
  return [];
}

function bash(commands: string[]): string {
  const cases = Object.entries(NEXT)
    .map(([command, words]) => `    ${command}) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=( $(compgen -W "${words}" -- "$cur") ) ;;`)
    .join('\n');
  return `# molesignal completion for bash; zsh takes it after \`autoload -U +X bashcompinit && bashcompinit\`
_molesignal() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}" command="\${COMP_WORDS[1]}"
  COMPREPLY=()
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${commands.join(' ')}" -- "$cur") )
    return
  fi
  case "$prev" in
    --profile) COMPREPLY=( $(compgen -W "$(molesignal __complete profiles 2>/dev/null)" -- "$cur") ); return ;;
    --stream) COMPREPLY=( $(compgen -W "$(molesignal __complete streams 2>/dev/null)" -- "$cur") ); return ;;
    --type) COMPREPLY=( $(compgen -W "logs metrics traces profiles extend" -- "$cur") ); return ;;
  esac
  case "$command" in
    ${STREAM_FIRST.join('|')}) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=( $(compgen -W "$(molesignal __complete streams 2>/dev/null)" -- "$cur") ) ;;
    use) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=( $(compgen -W "$(molesignal __complete profiles 2>/dev/null)" -- "$cur") ) ;;
${cases}
  esac
}
complete -F _molesignal molesignal
`;
}

function zsh(commands: string[]): string {
  return `#compdef molesignal
# molesignal completion for zsh: put it in a folder of $fpath as _molesignal, or source it
autoload -U +X bashcompinit && bashcompinit
${bash(commands)}`;
}

function fish(commands: Command[]): string {
  const lines = [
    '# molesignal completion for fish: save as ~/.config/fish/completions/molesignal.fish',
    'complete -c molesignal -f',
    ...commands.map((command) => `complete -c molesignal -n __fish_use_subcommand -a ${command.name} -d ${JSON.stringify(command.summary)}`),
    `complete -c molesignal -n "__fish_seen_subcommand_from ${STREAM_FIRST.join(' ')}" -a "(molesignal __complete streams 2>/dev/null)"`,
    'complete -c molesignal -n "__fish_seen_subcommand_from use" -a "(molesignal __complete profiles 2>/dev/null)"',
    'complete -c molesignal -l profile -x -a "(molesignal __complete profiles 2>/dev/null)"',
    'complete -c molesignal -l stream -x -a "(molesignal __complete streams 2>/dev/null)"',
    ...Object.entries(NEXT).map(([command, words]) => `complete -c molesignal -n "__fish_seen_subcommand_from ${command}" -a "${words}"`),
  ];
  return `${lines.join('\n')}\n`;
}

/** `molesignal completion <shell>`, for the commands there are. */
export function completionCommand(commands: () => Command[]): Command {
  return {
    name: 'completion',
    group: 'Tools and setup',
    summary: 'Print a shell completion script: bash, zsh or fish',
    usage: `Usage: molesignal completion <bash|zsh|fish>

Prints a script that completes molesignal's commands, their subcommands,
profiles, and stream names (fetched once every few minutes).

  bash:  echo 'source <(molesignal completion bash)' >> ~/.bashrc
  zsh:   echo 'source <(molesignal completion zsh)' >> ~/.zshrc
  fish:  molesignal completion fish > ~/.config/fish/completions/molesignal.fish`,

    async run(args) {
      const { positionals } = parse('completion', args, {});
      const shell = onePositional('completion', positionals, 'shell');
      const all = commands();
      const names = all.map((command) => command.name);
      if (shell === 'bash') print(bash(names));
      else if (shell === 'zsh') print(zsh(names));
      else if (shell === 'fish') print(fish(all));
      else throw new UsageError('The shell is bash, zsh or fish');
    },
  };
}
