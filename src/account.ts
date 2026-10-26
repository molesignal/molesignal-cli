import { type Command, CONNECTION, CONNECTION_HELP, onePositional, parse, UsageError } from './command.js';
import { checkProfileName, ConfigStore, DEFAULT_PROFILE, profileName } from './config.js';
import { signedIn, withSession } from './context.js';
import { serverAddress } from './endpoint.js';
import { networkFetch } from './net.js';
import { signIn } from './oauth.js';
import { print, printJson, say, table } from './output.js';
import { checkConnection } from './status.js';
import { VERSION } from './version.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** How a profile signs in, in a word. */
function signInKind(profile: { token?: string | undefined; oauth?: { tokens?: unknown } | undefined }): string {
  if (profile.token) return 'API token';
  if (profile.oauth?.tokens) return 'browser';
  return 'signed out';
}

export const loginCommand: Command = {
  name: 'login',
  group: 'Sign-in',
  summary: 'Sign in: in the browser, or with an API token (--with-token)',
  usage: `Usage: molesignal login --url <address> [options]

Signs in to a MoleSignal in the browser: MoleSignal asks you to approve this
machine, and the sign-in is kept, and renewed, in a profile. Without a
browser, sign in with an API token read from stdin (--with-token).

Each profile keeps one sign-in, so you can stay signed in to several
MoleSignals or organizations: --profile names it, and the profile signed in
last becomes the one commands use (\`molesignal use\` chooses another).

Options:
  --url <address>     The MoleSignal address, such as https://molesignal.example.com
  --profile <name>    The profile to keep the sign-in in (default: the current one, else "default")
  --with-token        Sign in with an API token read from stdin

Examples:
  molesignal login --url https://molesignal.example.com
  molesignal login --url https://staging.molesignal.example.com --profile staging
  printf '%s' "$TOKEN" | molesignal login --url https://molesignal.example.com --with-token`,

  async run(args) {
    const { values, positionals } = parse('login', args, {
      url: { type: 'string' },
      profile: { type: 'string' },
      'with-token': { type: 'boolean' },
    });
    if (positionals.length > 0) throw new UsageError(`Unexpected "${positionals[0]}"; see \`molesignal login --help\``);

    const store = await ConfigStore.open();
    const profile = profileName(values.profile, process.env, store.config);
    const url = values.url ?? process.env.MOLESIGNAL_URL ?? store.config.profiles?.[profile]?.url;
    if (!url) throw new UsageError('Which MoleSignal? Add --url <address>');
    const address = serverAddress(url);

    if (values['with-token']) {
      const token = await readStdin();
      if (!token) throw new Error('No API token on stdin');
      store.setProfile(profile, { url: address, token });
      store.config.current = profile;
      await store.save();
    } else {
      say(`Signing in to ${address} in the browser…`);
      await signIn(store, profile, address, { log: say, fetch: await networkFetch() });
    }

    const signed = await signedIn({ profile });
    const status = await checkConnection(signed.credentials, VERSION);
    say(`Signed in to ${address}${profile === DEFAULT_PROFILE ? '' : ` as profile ${profile}`}: ${status.tools} tools`);
  },
};

export const logoutCommand: Command = {
  name: 'logout',
  group: 'Sign-in',
  summary: 'Forget the sign-in of a profile',
  usage: `Usage: molesignal logout [--profile <name>]

Forgets the sign-in kept in a profile, the current one unless named. The
profile keeps its address; \`molesignal profiles remove\` forgets it all.`,

  async run(args) {
    const { values } = parse('logout', args, { profile: { type: 'string' } });
    const store = await ConfigStore.open();
    const profile = profileName(values.profile, process.env, store.config);
    if (!store.has(profile)) throw new Error(`No profile ${profile}`);
    const url = store.profile(profile).url;
    store.setProfile(profile, url ? { url } : {});
    await store.save();
    say(profile === DEFAULT_PROFILE ? 'Signed out' : `Signed out of profile ${profile}`);
  },
};

export const profilesCommand: Command = {
  name: 'profiles',
  group: 'Sign-in',
  summary: 'List the saved sign-ins; remove one',
  usage: `Usage: molesignal profiles
       molesignal profiles remove <name>

Lists the profiles: each keeps the address of a MoleSignal and the sign-in to
it. The one commands use is marked with *; \`molesignal use <name>\` chooses
it, and --profile or MOLESIGNAL_PROFILE choose one for a single command.`,

  async run(args) {
    const { values, positionals } = parse('profiles', args, { json: { type: 'boolean' } });
    const [action, ...rest] = positionals;
    const store = await ConfigStore.open();

    if (action === 'remove') {
      const name = onePositional('profiles', rest, 'profile');
      if (!store.has(name)) throw new Error(`No profile ${name}`);
      store.removeProfile(name);
      await store.save();
      say(`Removed profile ${name}`);
      return;
    }
    if (action) throw new UsageError(`Unknown "${action}"; see \`molesignal profiles --help\``);

    const current = profileName(undefined, process.env, store.config);
    const names = store.names;
    if (values.json) {
      printJson(
        names.map((name) => ({
          name,
          current: name === current,
          url: store.profile(name).url,
          sign_in: signInKind(store.profile(name)),
        })),
      );
      return;
    }
    if (names.length === 0) {
      say('No profiles yet: run `molesignal login --url <address>`');
      return;
    }
    print(
      table(
        ['', 'PROFILE', 'SIGN-IN', 'ADDRESS'],
        names.map((name) => [name === current ? '*' : '', name, signInKind(store.profile(name)), store.profile(name).url ?? '']),
      ),
    );
  },
};

export const useCommand: Command = {
  name: 'use',
  group: 'Sign-in',
  summary: 'Choose the profile commands use',
  usage: `Usage: molesignal use <profile>

Makes a saved profile the one commands use. MOLESIGNAL_PROFILE and --profile
still choose another for a single command.`,

  async run(args) {
    const { positionals } = parse('use', args, {});
    const name = checkProfileName(onePositional('use', positionals, 'profile'));
    const store = await ConfigStore.open();
    if (!store.has(name)) throw new Error(`No profile ${name}: \`molesignal profiles\` lists them`);
    store.config.current = name;
    await store.save();
    say(`Using profile ${name} (${store.profile(name).url ?? 'no address'})`);
  },
};

export const statusCommand: Command = {
  name: 'status',
  group: 'Sign-in',
  summary: 'Check the connection: who answers, and how many tools it offers',
  usage: `Usage: molesignal status [options]

Connects to MoleSignal once and says who answered, in which MCP protocol,
how this command signs in, and how many tools MoleSignal offers directly.

Options:
${CONNECTION_HELP}`,

  async run(args) {
    const { values } = parse('status', args, CONNECTION);
    const signed = await signedIn(values);
    const result = await checkConnection(signed.credentials, VERSION);
    print([
      signed.credentials.connection.url,
      `  profile: ${signed.profile}`,
      `  server: ${result.server}${result.version ? ` ${result.version}` : ''}`,
      `  protocol: ${result.protocol ?? 'unknown'}`,
      `  sign-in: ${signed.credentials.connection.token ? 'API token' : 'browser'}`,
      `  tools: ${result.tools}`,
    ]);
  },
};

export const whoamiCommand: Command = {
  name: 'whoami',
  group: 'Sign-in',
  summary: 'Who you are in MoleSignal: user, organization, role and permissions',
  usage: `Usage: molesignal whoami [options]

Prints who MoleSignal takes you for: your name and email, the organization,
your role, and the permissions it gives you there.

Options:
  --json   Print JSON
${CONNECTION_HELP}`,

  async run(args) {
    const { values } = parse('whoami', args, { ...CONNECTION, json: { type: 'boolean' } });
    // The permissions are a second read that the tool policy may turn off; the rest stands without them.
    const { profile, capabilities, signed } = await withSession(values, async (session, signed) => ({
      profile: (await session.read('get_user_profile', {})) as Record<string, unknown>,
      capabilities: (await session.read('get_iam_capabilities', {}).catch(() => ({}))) as Record<string, unknown>,
      signed,
    }));
    if (values.json) {
      printJson({ ...profile, capabilities });
      return;
    }
    const org = (profile.org ?? {}) as { name?: string; slug?: string; id?: string };
    const permissions = Array.isArray(capabilities.permissions) ? (capabilities.permissions as string[]) : [];
    print([
      `${String(profile.display_name ?? '')}${profile.email ? ` <${String(profile.email)}>` : ''}`,
      `  organization: ${org.name ?? org.id ?? String(capabilities.org_id ?? '')}`,
      `  role: ${String(profile.display_role || capabilities.display_role || '')}`,
      `  permissions: ${permissions.length}${permissions.length ? ` (${permissions.slice(0, 6).join(', ')}${permissions.length > 6 ? ', …' : ''})` : ''}`,
      `  signed in with: ${signed.credentials.connection.token ? 'an API token' : 'the browser'}, profile ${signed.profile}`,
    ]);
  },
};
