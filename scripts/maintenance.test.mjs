import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  classifyUpdate,
  plainTranslationChange,
  PAUSE_MARKER,
  REPOSITORY,
  requirePreviewUrl,
} from './maintenance-policy.mjs';
import { apiClients, findPause, pauseAutomation } from './maintenance-api.mjs';
import { assessAndMerge } from './upstream-automerge.mjs';
import { prepareWatch, finishWatch } from './pages-watch.mjs';

const oldId = '11111111-1111-1111-1111-111111111111';
const newId = '22222222-2222-2222-2222-222222222222';
const newerId = '33333333-3333-3333-3333-333333333333';
const oldSha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);
const file = (filename, extra = {}) => ({
  filename,
  status: 'modified',
  additions: 1,
  deletions: 1,
  patch: '@@ -1 +1 @@\n-old\n+new',
  ...extra,
});
const production = (id = newId, sha = newSha, extra = {}) => ({
  id,
  environment: 'production',
  latest_stage: { status: 'success' },
  created_on: id === oldId ? '2026-10-14T00:00:00Z' : '2026-10-15T00:00:00Z',
  url: 'https://d6e8a1dd.bentopdf-ejf.pages.dev',
  deployment_trigger: { metadata: { commit_hash: sha } },
  ...extra,
});

test('the whole update must match the small text-only allowlist', () => {
  assert.equal(
    classifyUpdate([file('docs/tools/merge-pdf.md')]).automatic,
    true
  );
  assert.equal(
    classifyUpdate([file('public/locales/fr/common.json')]).automatic,
    true
  );
  for (const name of [
    'README.md',
    'public/locales/zh/common.json',
    'public/locales/en/common.json',
    'package-lock.json',
    'src/js/main.ts',
    'public/pdfjs-annotation-viewer/web/viewer.mjs',
    '.github/workflows/tests.yml',
    'cloudflare/pages-config.json',
    '../docs/tools/merge-pdf.md',
  ]) {
    assert.equal(
      classifyUpdate([file('docs/tools/merge-pdf.md'), file(name)]).automatic,
      false,
      name
    );
  }
});

test('deletions, renames, absent patches and oversized updates require review', () => {
  for (const extra of [
    { status: 'removed' },
    { previous_filename: 'old.md' },
    { patch: undefined },
    { additions: 500 },
    { additions: -1 },
    { additions: NaN },
  ])
    assert.equal(
      classifyUpdate([file('docs/tools/merge-pdf.md', extra)]).automatic,
      false
    );
  assert.equal(classifyUpdate([]).automatic, false);
  assert.equal(
    classifyUpdate(
      Array.from({ length: 21 }, (_, index) =>
        file(`docs/tools/tool-${index}.md`)
      )
    ).automatic,
    false
  );
});

test('translation automation preserves structure, links, markup and placeholders', () => {
  const base = JSON.stringify({
    title: 'Bonjour',
    url: 'https://example.invalid',
    nested: { count: '{{count}} files' },
  });
  assert.equal(
    plainTranslationChange(base, base.replace('Bonjour', 'Bienvenue')),
    true
  );
  for (const text of [
    base.replace('{{count}}', '{{total}}'),
    base.replace('Bonjour', '<b>Bonjour</b>'),
    base.replace('example.invalid', 'elsewhere.invalid'),
    base.replace('Bonjour', 'javascript:alert(1)'),
    base.replace('"title"', '"newTitle"'),
    '{}',
    'not json',
    'x'.repeat(300000),
  ])
    assert.equal(plainTranslationChange(base, text), false);
});

test('deployment URLs accept only this project and reject credential or host confusion', () => {
  assert.equal(
    requirePreviewUrl('https://d6e8a1dd.bentopdf-ejf.pages.dev'),
    'https://d6e8a1dd.bentopdf-ejf.pages.dev'
  );
  for (const url of [
    'http://d6e8a1dd.bentopdf-ejf.pages.dev',
    'https://evil.example',
    'https://d6e8a1dd.bentopdf-ejf.pages.dev.evil.example',
    'https://user@d6e8a1dd.bentopdf-ejf.pages.dev',
    'https://d6e8a1dd.bentopdf-ejf.pages.dev/?token=x',
  ])
    assert.throws(() => requirePreviewUrl(url));
});

test('API clients redact provider errors and never follow credential-bearing redirects', async () => {
  const calls = [];
  const clients = apiClients({
    env: {
      GITHUB_TOKEN: 'fixture-github',
      CLOUDFLARE_API_TOKEN: 'fixture-cloudflare',
    },
    request: async (url, options) => {
      calls.push({ url, options });
      return new Response('sensitive-provider-body', { status: 403 });
    },
  });
  await assert.rejects(clients.github('/repos/example'), /HTTP 403/);
  await assert.rejects(clients.cloudflare(), /HTTP 403/);
  assert.ok(calls.every(({ options }) => options.redirect === 'error'));
  assert.ok(calls[0].url.startsWith('https://api.github.com/'));
  assert.ok(calls[1].url.startsWith('https://api.cloudflare.com/'));
});

test('pause issue lookup paginates and excludes PR bodies', async () => {
  const calls = [];
  const found = await findPause(async (path) => {
    calls.push(path);
    if (path.endsWith('page=1'))
      return Array.from({ length: 100 }, () => ({
        pull_request: {},
        body: PAUSE_MARKER,
      }));
    return [{ number: 5, body: PAUSE_MARKER }];
  });
  assert.equal(found.number, 5);
  assert.equal(calls.length, 2);
});

test('an existing pause is retained without repeated notifications', async () => {
  const calls = [];
  const issue = await pauseAutomation(async (path, method = 'GET') => {
    calls.push(method);
    return [{ number: 5, body: PAUSE_MARKER }];
  }, 'another failure');
  assert.equal(issue.number, 5);
  assert.deepEqual(calls, ['GET']);
});

let fixture;
before(() => {
  const root = mkdtempSync(join(tmpdir(), 'pdf-maintenance-case-'));
  const upstream = join(root, 'upstream');
  const fork = join(root, 'fork');
  const rawGit = (cwd, ...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  rawGit(root, 'init', '--initial-branch=main', upstream);
  rawGit(upstream, 'config', 'user.name', 'Fixture');
  rawGit(upstream, 'config', 'user.email', 'fixture@example.invalid');
  rawGit(upstream, 'config', 'core.autocrlf', 'false');
  mkdirSync(join(upstream, 'docs', 'tools'), { recursive: true });
  mkdirSync(join(upstream, 'public', 'locales', 'fr'), { recursive: true });
  writeFileSync(join(upstream, 'docs', 'tools', 'merge-pdf.md'), 'Old guide\n');
  writeFileSync(
    join(upstream, 'public', 'locales', 'fr', 'common.json'),
    '{"title":"Bonjour"}\n'
  );
  rawGit(upstream, 'add', '.');
  rawGit(upstream, 'commit', '-m', 'base');
  rawGit(root, '-c', 'core.autocrlf=false', 'clone', upstream, fork);
  rawGit(fork, 'config', 'user.name', 'Fixture');
  rawGit(fork, 'config', 'user.email', 'fixture@example.invalid');
  rawGit(fork, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(fork, 'brand.txt'), '十三月 PDF 工具\n');
  rawGit(fork, 'add', '.');
  rawGit(fork, 'commit', '-m', 'brand');
  const base = rawGit(fork, 'rev-parse', 'HEAD');
  writeFileSync(
    join(upstream, 'docs', 'tools', 'merge-pdf.md'),
    'Improved guide\n'
  );
  writeFileSync(
    join(upstream, 'public', 'locales', 'fr', 'common.json'),
    '{"title":"Bienvenue"}\n'
  );
  rawGit(upstream, 'add', '.');
  rawGit(upstream, 'commit', '-m', 'guide and translation');
  rawGit(fork, 'fetch', 'origin', 'main');
  rawGit(fork, 'checkout', '-b', 'automation/sync-upstream');
  rawGit(fork, 'merge', '--no-ff', 'origin/main', '-m', 'upstream candidate');
  const candidate = rawGit(fork, 'rev-parse', 'HEAD');
  const origin = join(root, 'origin.git');
  rawGit(root, 'clone', '--bare', fork, origin);
  rawGit(fork, 'remote', 'set-url', 'origin', origin);
  rawGit(fork, 'update-ref', 'refs/remotes/origin/main', base);
  fixture = { root, upstream, fork, origin, base, candidate, rawGit };
});
after(() => {
  if (!fixture) return;
  const root = realpathSync(fixture.root);
  assert.equal(
    dirname(root).toLowerCase(),
    realpathSync(tmpdir()).toLowerCase()
  );
  assert.ok(basename(root).startsWith('pdf-maintenance-case-'));
  rmSync(root, { recursive: true, force: true });
});

function mergeScenario() {
  const calls = [];
  const env = {
    GITHUB_REPOSITORY: REPOSITORY,
    ENABLE_UPSTREAM_AUTOMERGE: 'true',
    ENABLE_PDF_ROLLBACK: 'true',
  };
  const event = { workflow_run: { id: 42 } };
  const pr = {
    number: 2,
    node_id: 'fixture-node',
    draft: true,
    state: 'open',
    mergeable: true,
    changed_files: 2,
    user: { login: 'github-actions[bot]' },
    head: {
      sha: fixture.candidate,
      ref: 'automation/sync-upstream',
      repo: { full_name: REPOSITORY },
    },
    base: { ref: 'main', sha: fixture.base },
  };
  const run = {
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: fixture.base,
    head_repository: { full_name: REPOSITORY },
    path: '.github/workflows/tests.yml',
    display_title: `PDF validation ${fixture.candidate}`,
  };
  const state = {
    pr,
    run,
    paused: false,
    protection: true,
    files: [
      file('docs/tools/merge-pdf.md'),
      file('public/locales/fr/common.json'),
    ],
    validStatus: true,
    jobs: true,
    activeMonitor: false,
    productionSha: fixture.base,
    prReads: 0,
    moved: false,
    dispatchFails: false,
  };
  const github = async (path, method = 'GET', body) => {
    calls.push({ provider: 'github', path, method, body });
    if (path.includes('/issues?'))
      return state.paused
        ? [{ body: PAUSE_MARKER, html_url: 'https://example.invalid/paused' }]
        : [];
    if (path.endsWith('/issues') && method === 'POST') {
      state.paused = true;
      return { number: 9 };
    }
    if (path.endsWith('/actions/runs/42')) return structuredClone(state.run);
    if (path.includes('/pulls?')) return [structuredClone(pr)];
    if (path.endsWith('/git/ref/heads/main'))
      return { object: { sha: fixture.base } };
    if (path.endsWith('/pulls/2')) {
      state.prReads++;
      return {
        ...structuredClone(pr),
        ...(state.moved && state.prReads > 1
          ? { head: { ...pr.head, sha: newSha } }
          : {}),
      };
    }
    if (path.endsWith('/pulls/2/files?per_page=100')) return state.files;
    if (path.includes('/statuses?'))
      return [
        {
          context: 'PDF validation',
          state: state.validStatus ? 'success' : 'failure',
          creator: { login: 'github-actions[bot]' },
          target_url: `https://github.com/${REPOSITORY}/actions/runs/42`,
        },
      ];
    if (path.endsWith('/actions/runs/42/jobs?per_page=100'))
      return {
        jobs: [
          { name: 'test', conclusion: 'success' },
          {
            name: 'pages / audit',
            conclusion: state.jobs ? 'success' : 'skipped',
          },
        ],
      };
    if (path.endsWith('/protection/required_status_checks'))
      return { strict: state.protection, contexts: ['PDF validation'] };
    if (path.includes('/pages-watch.yml/runs?'))
      return { total_count: state.activeMonitor ? 1 : 0 };
    if (path === '/graphql') return {};
    if (path.endsWith('/pulls/2/merge') && method === 'PUT')
      return { merged: true, sha: newSha };
    if (path.endsWith('/dispatches') && method === 'POST') {
      if (state.dispatchFails) throw new Error('dispatch unavailable');
      return null;
    }
    throw new Error(`Unexpected GitHub request: ${method} ${path}`);
  };
  const cloudflare = async (path = '', method = 'GET') => {
    calls.push({ provider: 'cloudflare', path, method });
    assert.equal(path, '');
    return { canonical_deployment: production(oldId, state.productionSha) };
  };
  const git = (...args) => {
    if (
      args[0] === 'fetch' &&
      args[2] === 'https://github.com/alam00000/bentopdf.git'
    )
      args[2] = fixture.upstream;
    return fixture.rawGit(fixture.fork, ...args);
  };
  return {
    state,
    calls,
    execute: () =>
      assessAndMerge({ env, event, github, cloudflare, git, summary() {} }),
    env,
  };
}

test('both switches default off without even fetching credentials or candidate data', async () => {
  const s = mergeScenario();
  delete s.env.ENABLE_UPSTREAM_AUTOMERGE;
  assert.equal((await s.execute()).result, 'disabled');
  assert.equal(s.calls.length, 0);
  s.env.ENABLE_UPSTREAM_AUTOMERGE = 'true';
  delete s.env.ENABLE_PDF_ROLLBACK;
  assert.equal((await s.execute()).result, 'disabled');
  assert.equal(s.calls.length, 0);
});

test('a real Git merge candidate retains branding and merges only after exact CI validation', async () => {
  const s = mergeScenario();
  const result = await s.execute();
  assert.equal(result.result, 'merged');
  const mutation = s.calls.find((call) => call.method === 'PUT');
  assert.equal(mutation.body.sha, fixture.candidate);
  assert.equal(mutation.body.merge_method, 'merge');
  assert.equal(
    s.calls.filter((call) => call.path.endsWith('/dispatches')).length,
    2
  );
  assert.equal(
    fixture.rawGit(fixture.fork, 'show', `${fixture.candidate}:brand.txt`),
    '十三月 PDF 工具'
  );
  assert.equal(
    fixture.rawGit(fixture.origin, 'rev-parse', 'main'),
    fixture.base
  );
});

for (const [name, change, expected] of [
  [
    'foreign PR workflows',
    (s) => {
      s.run.event = 'pull_request';
    },
    'untrusted-run',
  ],
  [
    'a workflow from an older main',
    (s) => {
      s.run.head_sha = oldSha;
    },
    'stale-validation-workflow',
  ],
  [
    'a manual validation for another candidate',
    (s) => {
      s.run.display_title = `PDF validation ${oldSha}`;
    },
    'unrelated-validation',
  ],
  [
    'a human review',
    (s) => {
      s.pr.draft = false;
    },
    'human-review',
  ],
  [
    'an existing pause',
    (s) => {
      s.paused = true;
    },
    'paused',
  ],
  [
    'critical files',
    (s) => {
      s.files[1] = file('package-lock.json');
    },
    'manual-risk',
  ],
  [
    'failed validation',
    (s) => {
      s.run.conclusion = 'failure';
    },
    'validation-failed',
  ],
  [
    'a stale status',
    (s) => {
      s.validStatus = false;
    },
    'missing-exact-validation',
  ],
  [
    'skipped build checks',
    (s) => {
      s.jobs = false;
    },
    'missing-required-jobs',
  ],
  [
    'an active production monitor',
    (s) => {
      s.activeMonitor = true;
    },
    'monitor-active',
  ],
  [
    'a changed PR during inspection',
    (s) => {
      s.moved = true;
    },
    'pr-moved',
  ],
])
  test(`automatic merge stops for ${name}`, async () => {
    const s = mergeScenario();
    change(s.state);
    assert.equal((await s.execute()).result, expected);
    assert.ok(
      !s.calls.some((call) => call.method === 'PUT' || call.path === '/graphql')
    );
  });

test('strict required checks and a matching live version are mandatory', async () => {
  const s = mergeScenario();
  s.state.protection = false;
  await assert.rejects(s.execute(), /must require up-to-date/);
  assert.ok(!s.calls.some((call) => call.method === 'PUT'));
  const t = mergeScenario();
  t.state.productionSha = oldSha;
  await assert.rejects(t.execute(), /Production and main differ/);
  assert.ok(!t.calls.some((call) => call.method === 'PUT'));
});

function watchScenario() {
  const calls = [];
  const state = {
    canonical: production(),
    main: newSha,
    prior: production(oldId, oldSha),
    paused: false,
    deploys: [],
    projects: 0,
    movedBeforeRollback: false,
  };
  const github = async (path, method = 'GET', body) => {
    calls.push({ provider: 'github', path, method, body });
    if (path.endsWith('/git/ref/heads/main'))
      return { object: { sha: state.main } };
    if (path.includes('/issues?'))
      return state.paused ? [{ number: 9, body: PAUSE_MARKER }] : [];
    if (path.endsWith('/issues') && method === 'POST') {
      state.paused = true;
      return { number: 9 };
    }
    throw new Error(`Unexpected GitHub request ${path}`);
  };
  const cloudflare = async (path = '', method = 'GET') => {
    calls.push({ provider: 'cloudflare', path, method });
    if (!path) {
      state.projects++;
      if (state.movedBeforeRollback && state.projects >= 2)
        state.canonical = production(newerId, 'c'.repeat(40));
      return { canonical_deployment: structuredClone(state.canonical) };
    }
    if (path === `/deployments/${oldId}`) return structuredClone(state.prior);
    if (path.startsWith('/deployments?')) return state.deploys;
    if (path === `/deployments/${oldId}/rollback` && method === 'POST') {
      state.canonical = structuredClone(state.prior);
      return structuredClone(state.prior);
    }
    throw new Error(`Unexpected Cloudflare request ${method} ${path}`);
  };
  const args = {
    commit: newSha,
    previous: oldId,
    deployment: newId,
    state: 'ready',
    smokeResult: 'failure',
    errorKind: 'functional',
    github,
    cloudflare,
    env: {},
  };
  return { calls, state, args };
}

test('production polling selects the exact successful main build', async () => {
  const s = watchScenario();
  const result = await prepareWatch({
    ...s.args,
    attempts: 1,
    wait: async () => {},
  });
  assert.equal(result.state, 'ready');
  assert.equal(result.deployment, newId);
});

test('failed builds and timeouts do not pretend that old production is the new version', async () => {
  const s = watchScenario();
  s.state.canonical = s.state.prior;
  s.state.deploys = [
    production(newId, newSha, { latest_stage: { status: 'failure' } }),
  ];
  assert.equal(
    (await prepareWatch({ ...s.args, attempts: 1 })).state,
    'build-failed'
  );
  s.state.deploys = [];
  assert.equal(
    (await prepareWatch({ ...s.args, attempts: 1 })).state,
    'timeout'
  );
  assert.ok(s.calls.every((call) => call.method === 'GET'));
});

test('healthy production performs no recovery writes', async () => {
  const s = watchScenario();
  assert.equal(
    (await finishWatch({ ...s.args, smokeResult: 'success' })).result,
    'healthy'
  );
  assert.ok(s.calls.every((call) => call.method === 'GET'));
});

test('a confirmed functional failure pauses first and rolls back only the current failing deployment', async () => {
  const s = watchScenario();
  const result = await finishWatch(s.args);
  assert.equal(result.result, 'rolled-back');
  const mutations = s.calls.filter((call) => call.method === 'POST');
  assert.equal(mutations[0].provider, 'github');
  assert.equal(mutations[1].path, `/deployments/${oldId}/rollback`);
  assert.equal(s.state.canonical.id, oldId);
  assert.equal(s.state.paused, true);
});

for (const [name, options] of [
  ['a network or challenge failure', { errorKind: 'access' }],
  ['an unknown failure', { errorKind: undefined }],
  ['a build failure', { state: 'build-failed', errorKind: 'functional' }],
  ['a timeout', { state: 'timeout' }],
])
  test(`updates pause without rollback for ${name}`, async () => {
    const s = watchScenario();
    assert.equal(
      (await finishWatch({ ...s.args, ...options })).result,
      'paused'
    );
    assert.equal(s.state.paused, true);
    assert.ok(
      !s.calls.some(
        (call) => call.provider === 'cloudflare' && call.method === 'POST'
      )
    );
  });

test('a newer main or deployment is never reverted by an older monitor', async () => {
  const s = watchScenario();
  s.state.main = oldSha;
  assert.equal((await finishWatch(s.args)).result, 'superseded');
  assert.ok(s.calls.every((call) => call.method === 'GET'));
  const t = watchScenario();
  t.state.movedBeforeRollback = true;
  assert.equal((await finishWatch(t.args)).result, 'superseded');
  assert.ok(
    !t.calls.some(
      (call) => call.provider === 'cloudflare' && call.method === 'POST'
    )
  );
});

test('preview or newer rollback targets are rejected', async () => {
  for (const prior of [
    production(oldId, oldSha, { environment: 'preview' }),
    production(oldId, oldSha, { created_on: '2026-10-16T00:00:00Z' }),
  ]) {
    const s = watchScenario();
    s.state.prior = prior;
    await assert.rejects(
      finishWatch(s.args),
      /successful production|Unsafe rollback target/
    );
    assert.ok(
      !s.calls.some(
        (call) => call.provider === 'cloudflare' && call.method === 'POST'
      )
    );
  }
});
