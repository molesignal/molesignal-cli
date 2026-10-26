import { type Command, CONNECTION, parse, UsageError } from './command.js';
import { ConfigStore, profileName, resolveConnection } from './config.js';
import { print, say } from './output.js';
import { openInBrowser, PAGES, pageOf } from './web.js';

export const openCommand: Command = {
  name: 'open',
  group: 'Tools and setup',
  summary: 'Open a MoleSignal page in the browser',
  usage: `Usage: molesignal open [page] [id] [options]

Opens a page of MoleSignal in the browser, the home page when none is named.

Pages:
${Object.entries(PAGES)
  .map(([name, page]) => `  ${name.padEnd(12)}${page.about}`)
  .join('\n')}

Options:
  --print            Print the address instead of opening it
  --profile <name>   The saved sign-in whose MoleSignal to open
  --url <address>    The MoleSignal address, instead of the saved one

Examples:
  molesignal open logs app_logs
  molesignal open incidents 01JB7Q…`,

  async run(args) {
    const { values, positionals } = parse('open', args, { ...CONNECTION, print: { type: 'boolean' } });
    const [page, id, ...extra] = positionals;
    if (extra.length > 0) throw new UsageError(`Unexpected "${extra[0]}"; see \`molesignal open --help\``);

    const store = await ConfigStore.open();
    const profile = profileName(values.profile, process.env, store.config);
    const connection = resolveConnection(values, process.env, store.config.profiles?.[profile] ?? {});
    const url = pageOf(connection.url, page, id);
    if (values.print) {
      print(url.toString());
      return;
    }
    say(`Opening ${url}`);
    openInBrowser(url);
  },
};
