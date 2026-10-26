import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:os';
import { promisify } from 'node:util';

import { type Command, CONNECTION, CONNECTION_HELP, parse, UsageError } from './command.js';
import { apiAccess } from './context.js';
import { printJson, say } from './output.js';
import { apiRequest } from './rest.js';
import { parseTime } from './time.js';

/** What a CI run tells about the change it deploys. */
export interface CiFacts {
  provider?: string | undefined;
  commit?: string | undefined;
  repository?: string | undefined;
  pull_request?: string | undefined;
  author?: string | undefined;
  ci_url?: string | undefined;
  environment?: string | undefined;
}

const present = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);

/**
 * The commit, repository, pull request, author and run link a CI system
 * sets in the environment: GitHub Actions, GitLab CI/CD, Jenkins, CircleCI,
 * Buildkite, Bitbucket Pipelines and Azure Pipelines.
 */
export function ciFacts(env: NodeJS.ProcessEnv): CiFacts {
  if (env.GITHUB_ACTIONS === 'true') {
    const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
    const repository = env.GITHUB_REPOSITORY ? `${server}/${env.GITHUB_REPOSITORY}` : undefined;
    const pull = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '')?.[1];
    return {
      provider: 'GitHub Actions',
      commit: present(env.GITHUB_SHA),
      repository,
      pull_request: pull && repository ? `${repository}/pull/${pull}` : undefined,
      author: present(env.GITHUB_ACTOR),
      ci_url: repository && env.GITHUB_RUN_ID ? `${repository}/actions/runs/${env.GITHUB_RUN_ID}` : undefined,
    };
  }
  if (env.GITLAB_CI === 'true') {
    return {
      provider: 'GitLab CI/CD',
      commit: present(env.CI_COMMIT_SHA),
      repository: present(env.CI_PROJECT_URL),
      pull_request:
        env.CI_PROJECT_URL && env.CI_MERGE_REQUEST_IID ? `${env.CI_PROJECT_URL}/-/merge_requests/${env.CI_MERGE_REQUEST_IID}` : undefined,
      author: present(env.GITLAB_USER_LOGIN ?? env.GITLAB_USER_NAME),
      ci_url: present(env.CI_JOB_URL ?? env.CI_PIPELINE_URL),
      environment: present(env.CI_ENVIRONMENT_NAME),
    };
  }
  if (env.JENKINS_URL) {
    return {
      provider: 'Jenkins',
      commit: present(env.GIT_COMMIT),
      repository: present(env.GIT_URL),
      pull_request: present(env.CHANGE_URL),
      author: present(env.CHANGE_AUTHOR ?? env.BUILD_USER_ID),
      ci_url: present(env.BUILD_URL),
    };
  }
  if (env.CIRCLECI === 'true') {
    return {
      provider: 'CircleCI',
      commit: present(env.CIRCLE_SHA1),
      repository: present(env.CIRCLE_REPOSITORY_URL),
      pull_request: present(env.CIRCLE_PULL_REQUEST),
      author: present(env.CIRCLE_USERNAME),
      ci_url: present(env.CIRCLE_BUILD_URL),
    };
  }
  if (env.BUILDKITE === 'true') {
    return {
      provider: 'Buildkite',
      commit: present(env.BUILDKITE_COMMIT),
      repository: present(env.BUILDKITE_REPO),
      author: present(env.BUILDKITE_BUILD_CREATOR),
      ci_url: present(env.BUILDKITE_BUILD_URL),
    };
  }
  if (env.BITBUCKET_BUILD_NUMBER) {
    const origin = present(env.BITBUCKET_GIT_HTTP_ORIGIN);
    return {
      provider: 'Bitbucket Pipelines',
      commit: present(env.BITBUCKET_COMMIT),
      repository: origin,
      pull_request: origin && env.BITBUCKET_PR_ID ? `${origin}/pull-requests/${env.BITBUCKET_PR_ID}` : undefined,
      ci_url: origin ? `${origin}/addon/pipelines/home#!/results/${env.BITBUCKET_BUILD_NUMBER}` : undefined,
      environment: present(env.BITBUCKET_DEPLOYMENT_ENVIRONMENT),
    };
  }
  if (env.TF_BUILD === 'True') {
    const collection = env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
    return {
      provider: 'Azure Pipelines',
      commit: present(env.BUILD_SOURCEVERSION),
      repository: present(env.BUILD_REPOSITORY_URI),
      author: present(env.BUILD_REQUESTEDFOR),
      ci_url:
        collection && env.SYSTEM_TEAMPROJECT && env.BUILD_BUILDID
          ? `${collection}${encodeURIComponent(env.SYSTEM_TEAMPROJECT)}/_build/results?buildId=${env.BUILD_BUILDID}`
          : undefined,
    };
  }
  return {};
}

const run = promisify(execFile);

/** The commit and the repository of the git checkout here, when there is one. */
export async function gitFacts(cwd = process.cwd()): Promise<CiFacts> {
  const git = async (...args: string[]) => {
    try {
      return present((await run('git', args, { cwd, timeout: 5000 })).stdout);
    } catch {
      return undefined;
    }
  };
  const [commit, repository] = await Promise.all([git('rev-parse', 'HEAD'), git('config', '--get', 'remote.origin.url')]);
  return { commit, repository };
}

/** A deployment as `POST /api/v1/apm/deployments` takes it. */
export interface DeploymentWrite {
  kind?: string | undefined;
  service: string;
  version?: string | undefined;
  environment?: string | undefined;
  namespace?: string | undefined;
  status?: string | undefined;
  commit?: string | undefined;
  repository?: string | undefined;
  pull_request?: string | undefined;
  author?: string | undefined;
  ci_url?: string | undefined;
  description?: string | undefined;
  deployed_at?: number | undefined;
}

/** The deployment to record: what the options say, else what CI and git tell. */
export function deployment(options: DeploymentWrite, facts: CiFacts): DeploymentWrite {
  const written: DeploymentWrite = {
    ...options,
    environment: options.environment ?? facts.environment,
    commit: options.commit ?? facts.commit,
    repository: options.repository ?? facts.repository,
    pull_request: options.pull_request ?? facts.pull_request,
    author: options.author ?? facts.author,
    ci_url: options.ci_url ?? facts.ci_url,
  };
  return Object.fromEntries(Object.entries(written).filter(([, value]) => value !== undefined && value !== '')) as DeploymentWrite;
}

const KINDS = ['deployment', 'configuration', 'feature_flag'];
const STATUSES = ['succeeded', 'failed', 'rolled_back'];

/** The exit status of a process that ended on a signal, as a shell gives it: 128 and the signal's number. */
export function signalStatus(signal: NodeJS.Signals | null): number {
  return 128 + ((signal && constants.signals[signal]) || 1);
}

/**
 * Runs a command with this terminal, and returns its exit status. Ctrl+C
 * reaches the command too; this process stays to report how it ended.
 */
function runCommand(command: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit' });
    const stay = () => undefined;
    const pass = () => child.kill('SIGTERM');
    process.on('SIGINT', stay);
    process.on('SIGTERM', pass);
    const done = () => {
      process.off('SIGINT', stay);
      process.off('SIGTERM', pass);
    };
    child.on('error', (error) => {
      done();
      reject(new Error(`Could not run ${command[0]}: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      done();
      resolve(code ?? signalStatus(signal));
    });
  });
}

export const deployCommand: Command = {
  name: 'deploy',
  group: 'Releases and data (API token)',
  summary: 'Report a deployment to APM; can run the deploy command itself',
  usage: `Usage: molesignal deploy --service <name> --version <version> [options] [-- <command>…]

Records a deployment, a configuration change or a feature flag change, so
APM marks it on the service's timeline and compares the versions. In CI the
commit, repository, pull request, author and run link are taken from the
environment (GitHub Actions, GitLab CI/CD, Jenkins, CircleCI, Buildkite,
Bitbucket Pipelines, Azure Pipelines); elsewhere the commit and the
repository come from git.

Given a command after --, it runs the command first, records the deployment
as succeeded or failed by how the command ended, and exits as it did.

Needs an API token whose role holds apm.deploy (MOLESIGNAL_TOKEN in CI).

Options:
  --service <name>          The service, as its spans name it (service.name)
  --version <version>       The version deployed (service.version); a deployment needs one
  --env <environment>       The environment (deployment.environment.name)
  --namespace <namespace>   The service's namespace (service.namespace)
  --kind <kind>             deployment (default), configuration or feature_flag
  --status <status>         succeeded (default), failed, or rolled_back to --version
  --commit <sha>            The commit, instead of the one CI or git tells
  --repository <address>    The repository, instead of the one CI or git tells
  --pull-request <url>      The pull request
  --author <name>           Who deployed
  --ci-url <url>            The CI run
  --description <text>      Shown when the deployment is pointed at
  --time <time>             When it happened, instead of now
  --dry-run                 Print what would be recorded, and record nothing
${CONNECTION_HELP}

Examples:
  molesignal deploy --service checkout --version "$GITHUB_SHA" --env production
  molesignal deploy --service checkout --version 2.4.0 --env production -- ./scripts/deploy.sh`,

  async run(args) {
    const end = args.indexOf('--');
    const own = end < 0 ? args : args.slice(0, end);
    const command = end < 0 ? [] : args.slice(end + 1);
    const { values, positionals } = parse('deploy', own, {
      ...CONNECTION,
      service: { type: 'string' },
      version: { type: 'string' },
      env: { type: 'string' },
      namespace: { type: 'string' },
      kind: { type: 'string' },
      status: { type: 'string' },
      commit: { type: 'string' },
      repository: { type: 'string' },
      'pull-request': { type: 'string' },
      author: { type: 'string' },
      'ci-url': { type: 'string' },
      description: { type: 'string' },
      time: { type: 'string' },
      'dry-run': { type: 'boolean' },
    });
    if (positionals.length > 0) throw new UsageError(`Unexpected "${positionals[0]}": a command to run goes after --`);
    if (end >= 0 && command.length === 0) throw new UsageError('No command after --');
    if (!values.service) throw new UsageError('Which service? Add --service <name>');
    const kind = values.kind ?? 'deployment';
    if (!KINDS.includes(kind)) throw new UsageError(`--kind is one of ${KINDS.join(', ')}`);
    if (kind === 'deployment' && !values.version) throw new UsageError('Which version? A deployment needs --version');
    if (values.status && !STATUSES.includes(values.status)) throw new UsageError(`--status is one of ${STATUSES.join(', ')}`);
    if (values.commit && !/^[A-Za-z0-9]{1,64}$/.test(values.commit)) throw new UsageError('--commit is at most 64 letters and digits');

    const facts = ciFacts(process.env);
    const local = facts.provider ? {} : await gitFacts();
    const api = values['dry-run'] ? undefined : await apiAccess(values);

    // A dry run says what would be recorded; it does not deploy.
    let exit = 0;
    if (command.length > 0 && api) {
      exit = await runCommand(command);
      if (exit !== 0) say(`${command[0]} exited with ${exit}: recording the deployment as failed`);
    }

    const write = deployment(
      {
        kind,
        service: values.service,
        version: values.version,
        environment: values.env,
        namespace: values.namespace,
        status: values.status ?? (exit === 0 ? 'succeeded' : 'failed'),
        commit: values.commit,
        repository: values.repository,
        pull_request: values['pull-request'],
        author: values.author,
        ci_url: values['ci-url'],
        description: values.description,
        deployed_at: values.time ? parseTime(values.time) : undefined,
      },
      { ...local, ...facts },
    );

    if (!api) {
      printJson(write);
      return exit;
    }
    await apiRequest(api, 'POST', '/apm/deployments', { json: write });
    const where = write.environment ? ` to ${write.environment}` : '';
    const what = kind === 'deployment' ? `the deployment of ${write.service} ${write.version}` : `the ${kind.replace('_', ' ')} change of ${write.service}`;
    say(`Recorded ${what}${where}${write.commit ? ` (${write.commit.slice(0, 12)})` : ''}: ${write.status}`);
    return exit;
  },
};
