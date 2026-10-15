import {
  CLOUDFLARE_ACCOUNT,
  CLOUDFLARE_PROJECT,
  PAUSE_MARKER,
  REPOSITORY,
} from './maintenance-policy.mjs';

export function apiClients({ env = process.env, request = fetch } = {}) {
  const github = async (path, method = 'GET', body) => {
    if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required');
    const response = await request(`https://api.github.com${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Do not log response bodies: provider errors can contain request details.
    if (!response.ok)
      throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const cloudflare = async (path = '', method = 'GET') => {
    if (!env.CLOUDFLARE_API_TOKEN)
      throw new Error('CLOUDFLARE_API_TOKEN is required');
    const response = await request(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT}/pages/projects/${CLOUDFLARE_PROJECT}${path}`,
      {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      }
    );
    if (!response.ok)
      throw new Error(`Cloudflare ${method}: HTTP ${response.status}`);
    const result = await response.json();
    if (result.success !== true)
      throw new Error('Cloudflare API did not confirm success');
    return result.result;
  };
  return { github, cloudflare };
}

export async function findPause(github) {
  for (let page = 1; page <= 20; page++) {
    const issues = await github(
      `/repos/${REPOSITORY}/issues?state=open&per_page=100&page=${page}`
    );
    const found = issues.find(
      (issue) => !issue.pull_request && issue.body?.includes(PAUSE_MARKER)
    );
    if (found) return found;
    if (issues.length < 100) return null;
  }
  throw new Error('Too many open issues to verify the automation pause state');
}

export async function pauseAutomation(github, reason, env = process.env) {
  const existing = await findPause(github);
  if (existing) return existing;
  const run = /^\d+$/.test(env.GITHUB_RUN_ID ?? '')
    ? `https://github.com/${REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : '';
  return github(`/repos/${REPOSITORY}/issues`, 'POST', {
    title: 'PDF 自动更新已暂停，需要检查',
    labels: ['maintenance'],
    body: [
      PAUSE_MARKER,
      '自动合并已暂停；每周上游检查仍可继续。',
      '',
      reason,
      '',
      run ? `运行记录：${run}` : '',
      '',
      '处理后先核对 main、Cloudflare 当前版本和 PDF 验收结果，再关闭本 Issue 恢复自动合并。',
    ]
      .filter(Boolean)
      .join('\n\n'),
  });
}
