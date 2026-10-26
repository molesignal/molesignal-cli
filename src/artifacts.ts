import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import { isElf, isMachO, readElf, readMachO } from './binaries.js';
import { type Command, CONNECTION, CONNECTION_HELP, onePositional, parse, parseCount, UsageError } from './command.js';
import { type Api, apiAccess } from './context.js';
import { formatBytes, print, printJsonLines, say, table, terminalWidth } from './output.js';
import { apiRequest, multipartForm } from './rest.js';
import { minute } from './time.js';

const compress = promisify(gzip);

/** The most MoleSignal takes in one upload. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** One file to upload, and how MoleSignal is to match it to error frames. */
export interface Artifact {
  path: string;
  filename: string;
  kind: string;
  platform: string;
  architecture?: string | undefined;
  debugId?: string | undefined;
  /** The bytes, when the file is not uploaded whole, as one slice of a universal binary. */
  bytes?: Uint8Array | undefined;
}

/** The build an upload belongs to: the RUM application, service and release of the events it explains. */
export interface BuildIdentity {
  application: string;
  service: string;
  release: string;
}

/** The files under a path: the path itself when it is a file, every file below it when it is a folder. */
async function filesUnder(path: string, keep: (file: string) => boolean): Promise<string[]> {
  const info = await stat(path).catch(() => {
    throw new Error(`No such file or folder: ${path}`);
  });
  if (info.isFile()) return [path];
  const found: string[] = [];
  const entries = (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(child, keep)));
    else if (entry.isFile() && keep(entry.name)) found.push(child);
  }
  return found;
}

/**
 * The source maps under the paths: every `.map` file, uploaded under its own
 * name, which must be the deployed bundle's name and `.map`. Two maps of the
 * same name would replace each other, so that is refused.
 */
export async function sourceMaps(
  paths: string[],
  options: { platform: string; architecture?: string | undefined; debugId?: string | undefined },
): Promise<Artifact[]> {
  const files = (await Promise.all(paths.map((path) => filesUnder(path, (name) => name.endsWith('.map'))))).flat();
  const seen = new Map<string, string>();
  for (const file of files) {
    const name = basename(file);
    const other = seen.get(name);
    if (other) throw new Error(`${other} and ${file} are both ${name}: upload them as separate releases`);
    seen.set(name, file);
  }
  return files.map((path) => ({
    path,
    filename: basename(path),
    kind: 'javascript_sourcemap',
    platform: options.platform,
    architecture: options.architecture ?? (options.platform === 'flutter' ? 'javascript' : undefined),
    debugId: options.debugId,
  }));
}

/** A Flutter symbols file's platform and architecture, from its name: `app.android-arm64.symbols`. */
export function flutterTarget(name: string): { platform: string; architecture: string } | undefined {
  const match = /\.(android|ios)-([a-z0-9_]+)\.symbols$/i.exec(name);
  if (!match) return undefined;
  const architecture = { arm64: 'arm64', arm: 'arm', x64: 'x86_64', x86: 'x86' }[match[2]!.toLowerCase()] ?? match[2]!;
  return { platform: match[1]!.toLowerCase(), architecture };
}

/**
 * The symbols under the paths, each with how it is matched: Flutter
 * `.symbols` files, an R8 `mapping.txt`, Android native libraries (`.so`, by
 * their build ID), and Apple dSYMs (by the UUID of each architecture).
 */
export async function symbolFiles(
  paths: string[],
  options: { platform?: string | undefined; architecture?: string | undefined; debugId?: string | undefined },
): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];
  for (const path of paths) {
    const files = path.replace(/\/+$/, '').endsWith('.dSYM')
      ? await filesUnder(join(path, 'Contents', 'Resources', 'DWARF'), () => true)
      : await filesUnder(path, (name) => /\.(symbols|so|debug|txt|dwarf)$/i.test(name) || !name.includes('.'));

    for (const file of files) {
      const name = basename(file);
      if (name.toLowerCase() === 'mapping.txt' || name.toLowerCase().endsWith('.mapping.txt')) {
        artifacts.push({ path: file, filename: name, kind: 'android_mapping', platform: 'android', debugId: options.debugId });
        continue;
      }
      if (name.endsWith('.txt')) continue;

      const bytes = await readFile(file);
      const flutter = flutterTarget(name);
      if (flutter && isElf(bytes)) {
        artifacts.push({
          path: file,
          filename: name,
          kind: 'flutter_symbols',
          platform: options.platform ?? flutter.platform,
          architecture: options.architecture ?? flutter.architecture,
          debugId: options.debugId,
        });
        continue;
      }
      if (isElf(bytes)) {
        const elf = readElf(bytes);
        artifacts.push({
          path: file,
          filename: name,
          kind: 'android_native_symbols',
          platform: options.platform ?? 'android',
          architecture: options.architecture ?? elf.architecture,
          debugId: options.debugId ?? (elf.debugId || undefined),
        });
        continue;
      }
      if (isMachO(bytes)) {
        for (const slice of readMachO(bytes)) {
          if (options.architecture && slice.architecture !== options.architecture) continue;
          artifacts.push({
            path: file,
            filename: name,
            kind: 'apple_dsym',
            platform: options.platform ?? 'ios',
            architecture: slice.architecture,
            debugId: options.debugId ?? (slice.debugId || undefined),
            bytes: slice.bytes,
          });
        }
      }
    }
  }
  return artifacts;
}

/** Uploads one artifact, gzipped unless it already is, and returns what MoleSignal kept. */
export async function uploadArtifact(api: Api, build: BuildIdentity, artifact: Artifact): Promise<{ size: number }> {
  const raw = artifact.bytes ?? (await readFile(artifact.path));
  const gzipped = raw[0] === 0x1f && raw[1] === 0x8b;
  const bytes = gzipped ? raw : await compress(raw, { level: 6 });
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(`${formatBytes(bytes.length)} even gzipped; MoleSignal takes at most 50 MiB a file`);
  }
  await apiRequest(api, 'POST', '/debug-artifacts', {
    raw: multipartForm(
      {
        application_id: build.application,
        service: build.service,
        release: build.release,
        kind: artifact.kind,
        platform: artifact.platform,
        architecture: artifact.architecture,
        debug_id: artifact.debugId,
      },
      { name: artifact.filename, bytes },
    ),
  });
  return { size: bytes.length };
}

/** Uploads the artifacts a few at a time, a line each; returns how many failed. */
async function uploadAll(api: Api, build: BuildIdentity, artifacts: Artifact[], concurrency: number): Promise<number> {
  let next = 0;
  let failed = 0;
  const label = (artifact: Artifact) =>
    [artifact.filename, artifact.architecture, artifact.debugId ? `id ${artifact.debugId}` : undefined].filter(Boolean).join(' · ');

  const worker = async () => {
    while (next < artifacts.length) {
      const artifact = artifacts[next++]!;
      try {
        const { size } = await uploadArtifact(api, build, artifact);
        say(`✓ ${label(artifact)} (${formatBytes(size)})`);
      } catch (error) {
        failed += 1;
        say(`✗ ${label(artifact)}: ${(error as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, artifacts.length) }, worker));
  return failed;
}

/** An artifact as MoleSignal lists it. */
interface StoredArtifact {
  id: string;
  kind?: string;
  platform?: string;
  architecture?: string;
  release?: string;
  service?: string;
  filename?: string;
  size_bytes?: number;
  uploaded_at_micros?: number;
}

/** The shared part of `source-maps` and `symbols`: upload, list and delete. */
function artifactCommand(options: {
  name: string;
  summary: string;
  usage: string;
  kinds: string[];
  find: (paths: string[], values: Record<string, string | boolean | undefined>) => Promise<Artifact[]>;
}): Command {
  return {
    name: options.name,
    group: 'Releases and data (API token)',
    summary: options.summary,
    usage: options.usage,

    async run(args) {
      const { values, positionals } = parse(options.name, args, {
        ...CONNECTION,
        application: { type: 'string' },
        service: { type: 'string' },
        release: { type: 'string' },
        platform: { type: 'string' },
        arch: { type: 'string' },
        'debug-id': { type: 'string' },
        kind: { type: 'string' },
        concurrency: { type: 'string' },
        'dry-run': { type: 'boolean' },
        json: { type: 'boolean' },
      });
      const [action, ...rest] = positionals;

      if (action === 'upload') {
        if (rest.length === 0) throw new UsageError(`What to upload? Run \`molesignal ${options.name} upload <path>…\``);
        const missing = ['application', 'service', 'release'].filter((key) => !values[key as 'application']);
        if (missing.length) {
          throw new UsageError(`Add ${missing.map((key) => `--${key}`).join(', ')}: they must match what the app's events carry`);
        }
        const build = { application: values.application!, service: values.service!, release: values.release! };
        const artifacts = await options.find(rest, values);
        if (artifacts.length === 0) throw new Error('Nothing to upload under those paths');

        if (values['dry-run']) {
          // The file goes last, as the path from here: the column a narrow terminal may cut.
          const shown = (path: string) => {
            const near = relative(process.cwd(), path);
            return near && !near.startsWith('..') && !isAbsolute(near) ? near : path;
          };
          print(
            table(
              ['KIND', 'PLATFORM', 'ARCH', 'DEBUG ID', 'FILE'],
              artifacts.map((artifact) => [
                artifact.kind,
                artifact.platform,
                artifact.architecture ?? '',
                artifact.debugId ?? '',
                shown(artifact.path),
              ]),
              { width: terminalWidth() },
            ),
          );
          return;
        }

        const api = await apiAccess(values);
        say(`Uploading ${artifacts.length} file${artifacts.length === 1 ? '' : 's'} for ${build.service} ${build.release} (${build.application})`);
        const failed = await uploadAll(api, build, artifacts, parseCount(values.concurrency ?? '4', '--concurrency', 16));
        if (failed > 0) say(`${failed} of ${artifacts.length} failed`);
        return failed > 0 ? 1 : 0;
      }

      if (action === 'list') {
        const api = await apiAccess(values);
        const kind = values.kind ?? (options.kinds.length === 1 ? options.kinds[0] : undefined);
        const found = (await apiRequest(api, 'GET', '/debug-artifacts', {
          query: { application_id: values.application, service: values.service, kind, platform: values.platform },
        })) as StoredArtifact[];
        const listed = (found ?? []).filter(
          (artifact) => options.kinds.includes(artifact.kind ?? '') && (!values.release || artifact.release === values.release),
        );
        if (values.json) printJsonLines(listed);
        else if (listed.length === 0) say('None uploaded');
        else {
          const rows = listed.map((artifact) => [
            artifact.id,
            artifact.service ?? '',
            artifact.release ?? '',
            [artifact.platform, artifact.architecture].filter(Boolean).join(' '),
            artifact.size_bytes === undefined ? '' : formatBytes(artifact.size_bytes),
            artifact.uploaded_at_micros ? minute(artifact.uploaded_at_micros) : '',
            artifact.filename ?? '',
          ]);
          print(table(['ID', 'SERVICE', 'RELEASE', 'PLATFORM', 'SIZE', 'UPLOADED', 'FILE'], rows, { width: terminalWidth() }));
        }
        return;
      }

      if (action === 'delete') {
        const id = onePositional(options.name, rest, 'upload');
        await apiRequest(await apiAccess(values), 'DELETE', `/debug-artifacts/${encodeURIComponent(id)}`);
        say(`Deleted ${id}`);
        return;
      }

      throw new UsageError(`Run \`molesignal ${options.name} upload|list|delete\`; see \`molesignal ${options.name} --help\``);
    },
  };
}

const BUILD_HELP = `  --application <id>   The RUM application (applicationId in the SDK)
  --service <name>     The service the SDK reports (service)
  --release <version>  The version the SDK reports (version)`;

export const sourceMapsCommand = artifactCommand({
  name: 'source-maps',
  summary: 'Upload JavaScript source maps for RUM; list or delete them',
  kinds: ['javascript_sourcemap'],
  find: (paths, values) =>
    sourceMaps(paths, {
      platform: (values.platform as string | undefined) ?? 'web',
      architecture: values.arch as string | undefined,
      debugId: values['debug-id'] as string | undefined,
    }),
  usage: `Usage: molesignal source-maps upload <folder|file>… --application <id> --service <name> --release <version>
       molesignal source-maps list [--application <id>] [--service <name>] [--release <version>]
       molesignal source-maps delete <id>

Uploads every .map file under the folders, so RUM shows errors at their
original lines. Each map keeps its own name, which must be the deployed
bundle's name and .map: app.8f312.js.map for /assets/app.8f312.js. Files are
gzipped on the way. Needs an API token whose role holds streams.configure.

Options:
${BUILD_HELP}
  --platform <platform> web (default), or flutter for Flutter Web
  --arch <arch>         With flutter: the architecture the app reports (default javascript)
  --debug-id <id>       With flutter: the MOLESIGNAL_DEBUG_ID the app was built with
  --concurrency <n>     How many files go at once (default 4)
  --dry-run             List what would be uploaded, and upload nothing
  --json                With list: print JSON
${CONNECTION_HELP}

Example:
  molesignal source-maps upload dist/assets --application checkout-web --service web-frontend --release "$VERSION"`,
});

export const symbolsCommand = artifactCommand({
  name: 'symbols',
  summary: 'Upload Flutter, Android and Apple symbols for RUM; list or delete them',
  kinds: ['flutter_symbols', 'android_mapping', 'android_native_symbols', 'apple_dsym'],
  find: (paths, values) =>
    symbolFiles(paths, {
      platform: values.platform as string | undefined,
      architecture: values.arch as string | undefined,
      debugId: values['debug-id'] as string | undefined,
    }),
  usage: `Usage: molesignal symbols upload <path>… --application <id> --service <name> --release <version>
       molesignal symbols list [--application <id>] [--service <name>] [--kind <kind>]
       molesignal symbols delete <id>

Uploads what turns mobile and native stack frames back into code, each found
by what it is:
  app.android-arm64.symbols   Flutter --split-debug-info output: platform and architecture from the name
  mapping.txt                 an Android R8 mapping
  libapp.so and other ELF     Android native libraries: architecture and build ID read from the file
  Checkout.app.dSYM           an Apple dSYM: each architecture of a universal binary goes up on its own,
                              with its UUID
Files are gzipped on the way. Needs an API token whose role holds streams.configure.

Options:
${BUILD_HELP}
  --debug-id <id>       The build ID to match by, instead of the one read from the file;
                        for Flutter symbols, the MOLESIGNAL_DEBUG_ID the app was built with
  --platform <platform> android or ios, instead of the one the file says
  --arch <arch>         The architecture, instead of the one the file says; for a dSYM, only that one
  --kind <kind>         With list: flutter_symbols, android_mapping, android_native_symbols or apple_dsym
  --concurrency <n>     How many files go at once (default 4)
  --dry-run             List what would be uploaded, with the IDs read, and upload nothing
  --json                With list: print JSON
${CONNECTION_HELP}

Examples:
  molesignal symbols upload build/molesignal-symbols --application checkout-app --service checkout --release 2.4.0 --debug-id "$BUILD_ID"
  molesignal symbols upload build/Checkout.app.dSYM --application checkout-app --service checkout --release 2.4.0`,
});
