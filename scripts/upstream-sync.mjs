import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const upstream = 'alam00000/bentopdf';
const baseBranch = 'main';
const updateBranch = 'automation/sync-upstream';

function git(cwd, args, env = process.env) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

// Git-only preparation: no candidate code is installed or executed, and the
// production branch is never checked out for writing, reset, or pushed.
export function prepareUpstreamMerge({ cwd, remote, branch, baseRef }) {
  if (git(cwd, ['status', '--porcelain'])) {
    throw new Error('Working tree must be clean before preparing an update');
  }
  git(cwd, ['fetch', '--no-tags', remote, branch]);
  const base = git(cwd, ['rev-parse', baseRef]);
  const head = git(cwd, ['rev-parse', 'FETCH_HEAD']);
  const count = Number(git(cwd, ['rev-list', '--count', `${base}..${head}`]));
  if (count === 0) return null;
  const mergeBase = git(cwd, ['merge-base', base, head]);
  git(cwd, ['checkout', '--detach', base]);
  try {
    git(cwd, [
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'merge',
      '--no-commit',
      '--no-ff',
      head,
    ]);
  } catch (error) {
    const conflicts = git(cwd, ['diff', '--name-only', '--diff-filter=U']);
    git(cwd, ['merge', '--abort']);
    throw new Error(
      `Upstream merge stopped; resolve conflicts manually: ${conflicts || error.message}`,
      { cause: error }
    );
  }
  git(cwd, [
    '-c',
    'user.name=github-actions[bot]',
    '-c',
    'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit',
    '-m',
    `chore: merge upstream ${head.slice(0, 12)}`,
  ]);
  return {
    base,
    upstream: head,
    mergeBase,
    count,
    candidate: git(cwd, ['rev-parse', 'HEAD']),
    commits: git(cwd, [
      'log',
      '--format=%h %s',
      '--max-count=30',
      `${base}..${head}`,
    ]),
  };
}

export async function proposeUpdate({
  cwd = process.cwd(),
  env = process.env,
  request = fetch,
} = {}) {
  const repo = env.GITHUB_REPOSITORY;
  if (repo !== 'bigzhihui/bentopdf')
    throw new Error('This workflow is configured for bigzhihui/bentopdf');
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required');
  const [owner] = repo.split('/');
  const summary = (text) => {
    console.log(text);
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  };
  async function api(path, method = 'GET', body) {
    const response = await request(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(`GitHub API ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }

  git(cwd, [
    'fetch',
    '--no-tags',
    'origin',
    `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
  ]);
  if (env.UPSTREAM_REPORT_ONLY === 'true') {
    git(cwd, [
      'fetch',
      '--no-tags',
      `https://github.com/${upstream}.git`,
      'main',
    ]);
    const current = git(cwd, [
      'rev-parse',
      `refs/remotes/origin/${baseBranch}`,
    ]);
    const latest = git(cwd, ['rev-parse', 'FETCH_HEAD']);
    const count = git(cwd, ['rev-list', '--count', `${current}..${latest}`]);
    const release = await api(`/repos/${upstream}/releases/latest`);
    summary(
      `上游最新正式版：[${release.tag_name}](${release.html_url})。\n\n上游 main 有 ${count} 个尚未包含的提交。\n\n[查看上游](https://github.com/${upstream})；自动创建 PR 由仓库变量 ENABLE_UPSTREAM_SYNC 控制。`
    );
    return;
  }
  const prs = await api(
    `/repos/${repo}/pulls?state=open&head=${owner}:${updateBranch}&base=${baseBranch}`
  );
  const existing = prs[0];
  if (
    existing &&
    (existing.user.login !== 'github-actions[bot]' || !existing.draft)
  ) {
    summary(`已有更新 PR 正在人工审查，自动更新暂停：${existing.html_url}`);
    return;
  }

  const prepared = prepareUpstreamMerge({
    cwd,
    remote: `https://github.com/${upstream}.git`,
    branch: 'main',
    baseRef: `refs/remotes/origin/${baseBranch}`,
  });
  if (!prepared) {
    summary('上游主分支已包含在本站生产分支中，本次没有需要创建的更新 PR。');
    return;
  }

  const remoteLine = git(cwd, [
    'ls-remote',
    '--heads',
    'origin',
    `refs/heads/${updateBranch}`,
  ]);
  const oldHead = remoteLine.split(/\s/)[0];
  if (oldHead && !existing) {
    throw new Error(
      'Update branch already exists without a bot-owned draft PR; inspect it manually'
    );
  }
  if (existing && oldHead !== existing.head.sha)
    throw new Error('Update branch changed during inspection; retry later');
  if (oldHead) {
    git(cwd, ['fetch', '--no-tags', 'origin', `refs/heads/${updateBranch}`]);
    if (
      git(cwd, ['show', '-s', '--format=%ce', oldHead]) !==
      '41898282+github-actions[bot]@users.noreply.github.com'
    ) {
      summary(`更新分支含有人工提交，自动更新暂停：${existing.html_url}`);
      return;
    }
    const unchanged = ['base', 'upstream'].every((key) => {
      return (
        spawnSync(
          'git',
          ['merge-base', '--is-ancestor', prepared[key], oldHead],
          { cwd }
        ).status === 0
      );
    });
    if (unchanged) {
      summary(
        `更新草稿 PR 已是最新，保留现有候选和验证结果：${existing.html_url}`
      );
      return;
    }
  }

  // The encoded credential is passed only through the child environment, never
  // via command arguments, a persisted git config, log output, or source files.
  const pushEnv = {
    ...env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.GITHUB_TOKEN}`).toString('base64')}`,
  };
  git(
    cwd,
    [
      'push',
      `--force-with-lease=refs/heads/${updateBranch}:${oldHead}`,
      'origin',
      `HEAD:refs/heads/${updateBranch}`,
    ],
    pushEnv
  );

  const release = await api(`/repos/${upstream}/releases/latest`);
  const runUrl = `https://github.com/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
  const body = [
    '## 上游更新候选',
    '',
    `最新正式版：[${release.tag_name}](${release.html_url})。本 PR 包含上游 main 的 ${prepared.count} 个新提交，可能包含正式版后的改动。`,
    `上游提交：\`${prepared.upstream}\`；本站基线：\`${prepared.base}\`。`,
    '',
    `[查看上游差异](https://github.com/${upstream}/compare/${prepared.mergeBase}...${prepared.upstream}) · [检查运行](${runUrl})`,
    '',
    '```text',
    prepared.commits,
    '```',
    '',
    '## 合并前检查',
    '',
    '- [ ] 查看自动验证工作流的类型检查、测试、Pages 构建和 SEO 结果。',
    '- [ ] 检查本站中文品牌、内容页、许可证和源码链接。',
    '- [ ] 检查 WASM、字体、OCR、13 个禁用 Office 工具及安全头。',
    '- [ ] 使用脱敏 PDF 验证受影响操作和下载结果；检查 Cloudflare 预览（如有）。',
    '',
    '这是待审草稿：自动化只更新专用分支，不自动合并或发布。候选代码在独立、只读权限的验证工作流执行。',
  ].join('\n');
  const pr = existing
    ? await api(`/repos/${repo}/pulls/${existing.number}`, 'PATCH', {
        title: `chore: 同步上游 ${prepared.upstream.slice(0, 12)}`,
        body,
      })
    : await api(`/repos/${repo}/pulls`, 'POST', {
        title: `chore: 同步上游 ${prepared.upstream.slice(0, 12)}`,
        body,
        head: updateBranch,
        base: baseBranch,
        draft: true,
      });

  // Dispatch the trusted workflow definition on main, then check out the exact
  // candidate SHA with a read-only token. No extra PAT or writable test token.
  await api(`/repos/${repo}/actions/workflows/tests.yml/dispatches`, 'POST', {
    ref: baseBranch,
    inputs: { ref: prepared.candidate },
  });
  summary(
    `已准备草稿 PR：${pr.html_url}\n\n已安排候选 ${prepared.candidate} 的验证：[验证工作流](https://github.com/${repo}/actions/workflows/tests.yml)。`
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  proposeUpdate().catch((error) => {
    console.error(error.message);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\n检查未完成：${error.message}\n`
      );
    process.exitCode = 1;
  });
}
