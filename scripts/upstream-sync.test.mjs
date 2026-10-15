import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { prepareUpstreamMerge, proposeUpdate } from './upstream-sync.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pdf-upstream-test-'));
  const upstream = join(root, 'upstream');
  const fork = join(root, 'fork');
  const git = (cwd, ...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(root, 'init', '--initial-branch=main', upstream);
  for (const path of [upstream]) {
    git(path, 'config', 'user.name', 'Fixture');
    git(path, 'config', 'user.email', 'fixture@example.invalid');
    git(path, 'config', 'core.autocrlf', 'false');
  }
  writeFileSync(join(upstream, 'brand.txt'), 'Original brand\n');
  writeFileSync(join(upstream, 'viewer.txt'), 'Old viewer\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-m', 'base');
  git(root, '-c', 'core.autocrlf=false', 'clone', upstream, fork);
  git(fork, 'config', 'user.name', 'Fixture');
  git(fork, 'config', 'user.email', 'fixture@example.invalid');
  git(fork, 'config', 'core.autocrlf', 'false');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const commit = (cwd, name, text) => {
    writeFileSync(join(cwd, name), text);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', `update ${name}`);
  };
  const prepare = (baseRef = 'main') =>
    prepareUpstreamMerge({
      cwd: fork,
      remote: upstream,
      branch: 'main',
      baseRef,
    });
  return { root, upstream, fork, git, commit, prepare };
}

test('no upstream changes create no candidate or branch mutation', (t) => {
  const f = fixture(t);
  const before = f.git(f.fork, 'rev-parse', 'main');
  assert.equal(f.prepare(), null);
  assert.equal(f.git(f.fork, 'rev-parse', 'HEAD'), before);
  assert.equal(f.git(f.fork, 'branch', '--show-current'), 'main');
});

test('merge keeps local branding and upstream fix without moving production branch', (t) => {
  const f = fixture(t);
  f.commit(f.fork, 'brand.txt', '十三月 PDF 工具\n');
  const production = f.git(f.fork, 'rev-parse', 'main');
  f.commit(f.upstream, 'viewer.txt', 'Origin check enabled\n');
  const result = f.prepare();
  assert.equal(result.count, 1);
  assert.equal(
    readFileSync(join(f.fork, 'brand.txt'), 'utf8'),
    '十三月 PDF 工具\n'
  );
  assert.equal(
    readFileSync(join(f.fork, 'viewer.txt'), 'utf8'),
    'Origin check enabled\n'
  );
  assert.equal(f.git(f.fork, 'rev-parse', 'main'), production);
  assert.equal(
    f.git(f.fork, 'show', '--format=%P', '-s', 'HEAD').split(' ').length,
    2
  );
  assert.equal(f.prepare('HEAD'), null);
});

test('conflict aborts cleanly and preserves production and customized content', (t) => {
  const f = fixture(t);
  f.commit(f.fork, 'brand.txt', '十三月 PDF 工具\n');
  const production = f.git(f.fork, 'rev-parse', 'main');
  f.commit(f.upstream, 'brand.txt', 'Changed upstream brand\n');
  assert.throws(() => f.prepare(), /resolve conflicts manually: brand.txt/);
  assert.equal(f.git(f.fork, 'rev-parse', 'main'), production);
  assert.equal(f.git(f.fork, 'status', '--porcelain'), '');
  assert.equal(
    readFileSync(join(f.fork, 'brand.txt'), 'utf8'),
    '十三月 PDF 工具\n'
  );
});

test('uncommitted user changes are rejected before merge', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.fork, 'brand.txt'), 'Unsaved work\n');
  assert.throws(() => f.prepare(), /Working tree must be clean/);
  assert.equal(
    readFileSync(join(f.fork, 'brand.txt'), 'utf8'),
    'Unsaved work\n'
  );
});

test('an update only pushes the bot branch, creates a draft PR and dispatches read-only validation', async (t) => {
  const f = fixture(t);
  f.commit(f.fork, 'brand.txt', '十三月 PDF 工具\n');
  const origin = join(f.root, 'origin.git');
  f.git(f.root, 'clone', '--bare', f.fork, origin);
  f.git(f.fork, 'remote', 'set-url', 'origin', origin);
  f.git(
    f.fork,
    'config',
    `url.${pathToFileURL(f.upstream).href}.insteadOf`,
    'https://github.com/alam00000/bentopdf.git'
  );
  f.commit(f.upstream, 'viewer.txt', 'Origin check enabled\n');
  const production = f.git(origin, 'rev-parse', 'main');
  const oldProtocol = process.env.GIT_ALLOW_PROTOCOL;
  process.env.GIT_ALLOW_PROTOCOL = 'file';
  t.after(() => {
    if (oldProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = oldProtocol;
  });
  const requests = [];
  await proposeUpdate({
    cwd: f.fork,
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'bigzhihui/bentopdf',
      GITHUB_TOKEN: 'fixture-only-token',
      GITHUB_RUN_ID: '123',
      GITHUB_STEP_SUMMARY: '',
    },
    request: async (url, options) => {
      const method = options.method;
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, method, body });
      if (url.includes('/pulls?')) return Response.json([]);
      if (url.endsWith('/releases/latest'))
        return Response.json({
          tag_name: 'v0.test',
          html_url: 'https://example.invalid/release',
        });
      if (url.endsWith('/pulls') && method === 'POST')
        return Response.json({ html_url: 'https://example.invalid/pull/1' });
      if (url.endsWith('/dispatches') && method === 'POST')
        return new Response(null, { status: 204 });
      throw new Error(`Unexpected API call: ${method} ${url}`);
    },
  });
  const pr = requests.find(
    (r) => r.method === 'POST' && r.url.endsWith('/pulls')
  );
  assert.equal(pr.body.draft, true);
  assert.equal(pr.body.head, 'automation/sync-upstream');
  assert.equal(pr.body.base, 'main');
  const dispatch = requests.find((r) => r.url.endsWith('/dispatches'));
  const candidate = f.git(origin, 'rev-parse', 'automation/sync-upstream');
  assert.deepEqual(dispatch.body, { ref: 'main', inputs: { ref: candidate } });
  assert.equal(f.git(origin, 'rev-parse', 'main'), production);
  assert.equal(f.git(f.fork, 'rev-parse', 'main'), production);
  assert.equal(
    f.git(origin, 'show', `${candidate}:brand.txt`),
    '十三月 PDF 工具'
  );
  assert.equal(requests.filter((r) => r.method !== 'GET').length, 2);
});

test('a PR already under human review is never overwritten', async (t) => {
  const f = fixture(t);
  const production = f.git(f.fork, 'rev-parse', 'main');
  const requests = [];
  await proposeUpdate({
    cwd: f.fork,
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'bigzhihui/bentopdf',
      GITHUB_TOKEN: 'fixture-only-token',
      GITHUB_STEP_SUMMARY: '',
    },
    request: async (url, options) => {
      requests.push(options.method);
      return Response.json([
        {
          draft: false,
          user: { login: 'github-actions[bot]' },
          html_url: 'https://example.invalid/pull/1',
        },
      ]);
    },
  });
  assert.deepEqual(requests, ['GET']);
  assert.equal(f.git(f.fork, 'rev-parse', 'main'), production);
  assert.equal(f.git(f.fork, 'status', '--porcelain'), '');
});
