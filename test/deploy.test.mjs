import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ciFacts, deployment, signalStatus } from '../dist/index.js';

test('GitHub Actions tells the commit, repository, pull request, author and run', () => {
  assert.deepEqual(
    ciFacts({
      GITHUB_ACTIONS: 'true',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'acme/checkout',
      GITHUB_SHA: '9f2c1e7a4b3d',
      GITHUB_REF: 'refs/pull/42/merge',
      GITHUB_ACTOR: 'octocat',
      GITHUB_RUN_ID: '7',
    }),
    {
      provider: 'GitHub Actions',
      commit: '9f2c1e7a4b3d',
      repository: 'https://github.com/acme/checkout',
      pull_request: 'https://github.com/acme/checkout/pull/42',
      author: 'octocat',
      ci_url: 'https://github.com/acme/checkout/actions/runs/7',
    },
  );
});

test('GitLab, Jenkins, CircleCI, Bitbucket and Azure each tell theirs', () => {
  const gitlab = ciFacts({
    GITLAB_CI: 'true',
    CI_COMMIT_SHA: 'abc',
    CI_PROJECT_URL: 'https://gitlab.com/acme/checkout',
    CI_MERGE_REQUEST_IID: '5',
    GITLAB_USER_LOGIN: 'dev',
    CI_JOB_URL: 'https://gitlab.com/acme/checkout/-/jobs/9',
    CI_ENVIRONMENT_NAME: 'production',
  });
  assert.equal(gitlab.pull_request, 'https://gitlab.com/acme/checkout/-/merge_requests/5');
  assert.equal(gitlab.environment, 'production');

  assert.equal(ciFacts({ JENKINS_URL: 'https://ci', GIT_COMMIT: 'def', BUILD_URL: 'https://ci/job/1/' }).ci_url, 'https://ci/job/1/');
  assert.equal(ciFacts({ CIRCLECI: 'true', CIRCLE_SHA1: 'c1' }).commit, 'c1');
  assert.equal(
    ciFacts({ BITBUCKET_BUILD_NUMBER: '3', BITBUCKET_GIT_HTTP_ORIGIN: 'https://bitbucket.org/acme/app', BITBUCKET_PR_ID: '8' }).pull_request,
    'https://bitbucket.org/acme/app/pull-requests/8',
  );
  assert.equal(
    ciFacts({ TF_BUILD: 'True', SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: 'https://dev.azure.com/acme/', SYSTEM_TEAMPROJECT: 'Shop', BUILD_BUILDID: '11' }).ci_url,
    'https://dev.azure.com/acme/Shop/_build/results?buildId=11',
  );
  assert.deepEqual(ciFacts({}), {});
});

test('what the options say wins over what CI tells, and empty fields are left out', () => {
  assert.deepEqual(
    deployment(
      { kind: 'deployment', service: 'checkout', version: '2.4.0', commit: 'given', environment: undefined, description: '' },
      { commit: 'from-ci', repository: 'https://github.com/acme/checkout', environment: 'production' },
    ),
    { kind: 'deployment', service: 'checkout', version: '2.4.0', commit: 'given', environment: 'production', repository: 'https://github.com/acme/checkout' },
  );
});

test('a command ended by a signal exits as a shell says it', () => {
  assert.equal(signalStatus('SIGINT'), 130);
  assert.equal(signalStatus('SIGTERM'), 143);
});
