import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { OAuthClientInformationFull, OAuthDiscoveryState, OAuthTokens } from '@modelcontextprotocol/client';

import { serverAddress } from './endpoint.js';

/** What a sign-in in the browser left: the client registered for it and its tokens. */
export interface StoredOAuth {
  client?: OAuthClientInformationFull | undefined;
  tokens?: OAuthTokens | undefined;
  /** Kept between sending the browser off and the code coming back. */
  codeVerifier?: string | undefined;
  redirectUrl?: string | undefined;
  /** The authorization server found when the browser was sent off, so the code is redeemed with the same one. */
  discovery?: OAuthDiscoveryState | undefined;
}

/** One saved sign-in: which MoleSignal, and with an API token or a browser sign-in. */
export interface StoredProfile {
  url?: string | undefined;
  token?: string | undefined;
  oauth?: StoredOAuth | undefined;
}

/** The saved sign-ins by profile name, and the one commands use unless told otherwise. */
export interface StoredConfig {
  current?: string | undefined;
  profiles?: Record<string, StoredProfile> | undefined;
}

/** The profile a first sign-in goes into. */
export const DEFAULT_PROFILE = 'default';

/** Where the sign-in is kept: `MOLESIGNAL_CONFIG`, else the user's configuration folder. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MOLESIGNAL_CONFIG) return env.MOLESIGNAL_CONFIG;
  const base =
    env.XDG_CONFIG_HOME ??
    (process.platform === 'win32' && env.APPDATA ? env.APPDATA : join(homedir(), '.config'));
  return join(base, 'molesignal', 'config.json');
}

/** The saved configuration; none saved yet reads as empty. */
export async function readConfig(path: string): Promise<StoredConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === 'object' ? (parsed as StoredConfig) : {};
}

/**
 * Saves the configuration readable by its owner only: it holds credentials.
 * Written next to the file first, so a crash never leaves half of it.
 */
export async function writeConfig(path: string, config: StoredConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** A profile name as it may be written: letters, digits, `.`, `_` and `-`. */
export function checkProfileName(name: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error(`"${name}" is not a profile name: use letters, digits, ".", "_" and "-"`);
  }
  return name;
}

/**
 * The profile a command uses: the one it names (`--profile`), else
 * `MOLESIGNAL_PROFILE`, else the one chosen with `molesignal use`.
 */
export function profileName(
  option: string | undefined,
  env: NodeJS.ProcessEnv,
  config: StoredConfig,
): string {
  return checkProfileName(option ?? env.MOLESIGNAL_PROFILE ?? config.current ?? DEFAULT_PROFILE);
}

/** A configuration that is read, changed in place, and saved. */
export class ConfigStore {
  constructor(
    readonly path: string,
    public config: StoredConfig,
  ) {}

  static async open(path = configPath()): Promise<ConfigStore> {
    return new ConfigStore(path, await readConfig(path));
  }

  /** The saved profile of that name, made empty when there is none yet. */
  profile(name: string): StoredProfile {
    this.config.profiles ??= {};
    this.config.profiles[name] ??= {};
    return this.config.profiles[name];
  }

  /** Whether a profile of that name has been saved. */
  has(name: string): boolean {
    return Boolean(this.config.profiles?.[name]);
  }

  /** The saved profiles by name, in name order. */
  get names(): string[] {
    return Object.keys(this.config.profiles ?? {}).sort();
  }

  setProfile(name: string, profile: StoredProfile): void {
    this.config.profiles = { ...this.config.profiles, [name]: profile };
  }

  /** Forgets a profile; when it was the current one, the default is current again. */
  removeProfile(name: string): void {
    if (this.config.profiles) delete this.config.profiles[name];
    if (this.config.current === name) this.config.current = undefined;
  }

  async save(): Promise<void> {
    await writeConfig(this.path, this.config);
  }
}

/** A configuration kept in memory only: a sign-in under way, saved over the real one once it succeeds. */
export class PendingConfigStore extends ConfigStore {
  override async save(): Promise<void> {}
}

/** Which MoleSignal to talk to, and with what. */
export interface Connection {
  url: string;
  /** An API token; without one, the browser sign-in that was saved. */
  token?: string | undefined;
}

/**
 * The connection from the options given, else the environment
 * (`MOLESIGNAL_URL`, `MOLESIGNAL_TOKEN`), else the saved profile.
 */
export function resolveConnection(
  options: { url?: string | undefined; token?: string | undefined },
  env: NodeJS.ProcessEnv,
  profile: StoredProfile,
): Connection {
  const url = options.url ?? env.MOLESIGNAL_URL ?? profile.url;
  if (!url) {
    throw new Error(
      'No MoleSignal address: run `molesignal login --url <address>`, or set MOLESIGNAL_URL',
    );
  }
  const address = serverAddress(url);
  // A token saved for another MoleSignal is not sent to this one.
  const savedToken = profile.url && serverAddress(profile.url) === address ? profile.token : undefined;
  const token = options.token ?? env.MOLESIGNAL_TOKEN ?? savedToken;
  return token ? { url: address, token } : { url: address };
}
