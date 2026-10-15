import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyUpdate,
  deploymentSha,
  readEvent,
  REPOSITORY,
  requireProduction,
  requireSha,
  UPDATE_BRANCH,
  VALIDATION_CONTEXT,
  plainTranslationChange,
} from './maintenance-policy.mjs';
import { apiClients, findPause, pauseAutomation } from './maintenance-api.mjs';

export async function assessAndMerge({
  env = process.env,
  event = readEvent(env),
  cwd = process.cwd(),
  github,
  cloudflare,
  git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(),
  summary = console.log,
} = {}) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY)
    throw new Error('Unexpected repository');
  if (
    env.ENABLE_UPSTREAM_AUTOMERGE !== 'true' ||
    env.ENABLE_PDF_ROLLBACK !== 'true'
  ) {
    summary('自动上线未启用：只保留现有草稿 PR 和只读验证。');
    return { result: 'disabled' };
  }
  const runId = event.workflow_run?.id;
  if (!Number.isSafeInteger(runId) || runId <= 0)
    throw new Error('Invalid validation run ID');
  const run = await github(`/repos/${REPOSITORY}/actions/runs/${runId}`);
  // Only the workflow explicitly dispatched from our trusted main branch may
  // authorize a merge. PR workflows, artifacts and candidate scripts cannot.
  if (
    run.event !== 'workflow_dispatch' ||
    run.head_branch !== 'main' ||
    run.head_repository?.full_name !== REPOSITORY ||
    run.path !== '.github/workflows/tests.yml' ||
    run.status !== 'completed'
  )
    return { result: 'untrusted-run' };
  const paused = await findPause(github);
  if (paused) {
    summary(`自动更新已暂停：${paused.html_url}`);
    return { result: 'paused' };
  }
  const prs = await github(
    `/repos/${REPOSITORY}/pulls?state=open&head=bigzhihui:${UPDATE_BRANCH}&base=main`
  );
  if (prs.length !== 1) return { result: 'no-single-update-pr' };
  const pr = prs[0];
  if (
    pr.user?.login !== 'github-actions[bot]' ||
    pr.head?.repo?.full_name !== REPOSITORY ||
    pr.head.ref !== UPDATE_BRANCH ||
    pr.base?.ref !== 'main' ||
    !pr.draft
  )
    return { result: 'human-review' };
  const candidate = requireSha(pr.head.sha);
  const base = requireSha(
    (await github(`/repos/${REPOSITORY}/git/ref/heads/main`)).object.sha
  );
  if (run.head_sha !== base) return { result: 'stale-validation-workflow' };
  if (run.conclusion !== 'success') {
    await pauseAutomation(
      github,
      `更新 PR #${pr.number} 的自动验证失败，未合并或发布。`,
      env
    );
    return { result: 'validation-failed' };
  }
  const details = await github(`/repos/${REPOSITORY}/pulls/${pr.number}`);
  if (
    details.head.sha !== candidate ||
    details.base.sha !== base ||
    details.state !== 'open' ||
    !details.draft ||
    details.mergeable !== true
  )
    return { result: 'pr-not-ready' };
  if (details.changed_files > 20)
    return { result: 'manual-risk', reasons: ['超过 20 个文件'] };
  const files = await github(
    `/repos/${REPOSITORY}/pulls/${pr.number}/files?per_page=100`
  );
  if (files.length !== details.changed_files)
    throw new Error('Incomplete PR file list');
  const risk = classifyUpdate(files);
  if (!risk.automatic) {
    summary(`PR #${pr.number} 保留人工审查：${risk.reasons.join('；')}`);
    return { result: 'manual-risk', ...risk };
  }
  git(
    'fetch',
    '--no-tags',
    'origin',
    'refs/heads/main:refs/remotes/origin/main',
    `refs/heads/${UPDATE_BRANCH}:refs/remotes/origin/${UPDATE_BRANCH}`
  );
  if (
    git('rev-parse', `refs/remotes/origin/${UPDATE_BRANCH}`) !== candidate ||
    git('rev-parse', 'refs/remotes/origin/main') !== base
  )
    return { result: 'branch-moved' };
  const parents = git('show', '-s', '--format=%P', candidate).split(' ');
  if (parents.length !== 2 || parents[0] !== base)
    return { result: 'unexpected-candidate-history' };
  for (const file of files) {
    if (
      !git('ls-tree', candidate, '--', file.filename).startsWith('100644 blob ')
    )
      return {
        result: 'manual-risk',
        reasons: [`文件类型或权限需检查：${file.filename}`],
      };
    if (
      file.filename.startsWith('public/locales/') &&
      !plainTranslationChange(
        git('show', `${base}:${file.filename}`),
        git('show', `${candidate}:${file.filename}`)
      )
    )
      return {
        result: 'manual-risk',
        reasons: [`语言包结构、链接、HTML 或占位符需审查：${file.filename}`],
      };
  }
  git(
    'fetch',
    '--no-tags',
    'https://github.com/alam00000/bentopdf.git',
    'main'
  );
  git('merge-base', '--is-ancestor', parents[1], 'FETCH_HEAD');
  const statuses = await github(
    `/repos/${REPOSITORY}/commits/${candidate}/statuses?per_page=100`
  );
  const validation = statuses.find(
    (status) => status.context === VALIDATION_CONTEXT
  );
  if (
    validation?.state !== 'success' ||
    validation.creator?.login !== 'github-actions[bot]' ||
    validation.target_url !==
      `https://github.com/${REPOSITORY}/actions/runs/${runId}`
  )
    return { result: 'missing-exact-validation' };
  const jobs = await github(
    `/repos/${REPOSITORY}/actions/runs/${runId}/jobs?per_page=100`
  );
  if (
    !['test', 'pages / audit'].every((name) =>
      jobs.jobs.some((job) => job.name === name && job.conclusion === 'success')
    )
  )
    return { result: 'missing-required-jobs' };
  const protection = await github(
    `/repos/${REPOSITORY}/branches/main/protection/required_status_checks`
  );
  const required = [
    ...(protection.contexts ?? []),
    ...(protection.checks ?? []).map((check) => check.context),
  ];
  if (protection.strict !== true || !required.includes(VALIDATION_CONTEXT))
    throw new Error(
      'main must require up-to-date PDF validation before automatic merging'
    );
  const project = await cloudflare();
  const previous = requireProduction(project.canonical_deployment);
  if (deploymentSha(previous) !== base)
    throw new Error(
      'Production and main differ; inspect before enabling updates'
    );
  // Refuse overlap with a queued or running deployment monitor.
  for (const status of [
    'queued',
    'in_progress',
    'waiting',
    'pending',
    'requested',
  ]) {
    const monitors = await github(
      `/repos/${REPOSITORY}/actions/workflows/pages-watch.yml/runs?status=${status}&per_page=1`
    );
    if (monitors.total_count) return { result: 'monitor-active' };
  }
  const fresh = await github(`/repos/${REPOSITORY}/pulls/${pr.number}`);
  if (
    fresh.head.sha !== candidate ||
    fresh.base.sha !== base ||
    !fresh.draft ||
    fresh.state !== 'open'
  )
    return { result: 'pr-moved' };
  await github('/graphql', 'POST', {
    query:
      'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}',
    variables: { id: pr.node_id },
  });
  const merged = await github(
    `/repos/${REPOSITORY}/pulls/${pr.number}/merge`,
    'PUT',
    {
      sha: candidate,
      merge_method: 'merge',
      commit_title: `chore: validated upstream update (#${pr.number})`,
    }
  );
  if (merged.merged !== true)
    throw new Error('GitHub did not confirm the merge');
  const commit = requireSha(merged.sha);
  await github(
    `/repos/${REPOSITORY}/actions/workflows/pages-watch.yml/dispatches`,
    'POST',
    {
      ref: 'main',
      inputs: { commit, previous_deployment: previous.id },
    }
  );
  await github(
    `/repos/${REPOSITORY}/actions/workflows/tests.yml/dispatches`,
    'POST',
    {
      ref: 'main',
      inputs: { ref: commit },
    }
  );
  summary(`已合并 PR #${pr.number}，安排生产验收：${commit}。`);
  return { result: 'merged', commit, previous: previous.id };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const clients = apiClients();
  assessAndMerge({
    ...clients,
    summary(text) {
      console.log(text);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    },
  }).catch(async (error) => {
    console.error(error.message);
    if (
      process.env.ENABLE_UPSTREAM_AUTOMERGE === 'true' &&
      process.env.ENABLE_PDF_ROLLBACK === 'true'
    ) {
      try {
        await pauseAutomation(clients.github, `自动合并中止：${error.message}`);
      } catch {
        console.error('无法创建暂停 Issue；需检查 Actions 运行记录。');
      }
    }
    process.exitCode = 1;
  });
}
