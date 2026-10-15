import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import {
  deploymentSha,
  REPOSITORY,
  requireDeploymentId,
  requirePreviewUrl,
  requireProduction,
  requireSha,
} from './maintenance-policy.mjs';
import { apiClients, pauseAutomation } from './maintenance-api.mjs';

export async function prepareWatch({
  commit,
  previous,
  github,
  cloudflare,
  wait = setTimeout,
  attempts = 45,
} = {}) {
  requireSha(commit);
  requireDeploymentId(previous);
  const prior = requireProduction(await cloudflare(`/deployments/${previous}`));
  if (deploymentSha(prior) === commit)
    throw new Error('Rollback target must precede the update');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const main = await github(`/repos/${REPOSITORY}/git/ref/heads/main`);
    if (main.object.sha !== commit) return { state: 'superseded' };
    const project = await cloudflare();
    const canonical = project.canonical_deployment;
    if (
      deploymentSha(canonical) === commit &&
      canonical.environment === 'production' &&
      canonical.latest_stage?.status === 'success'
    ) {
      requireProduction(canonical);
      if (!(Date.parse(prior.created_on) < Date.parse(canonical.created_on)))
        throw new Error('Rollback target is not older than the new deployment');
      return {
        state: 'ready',
        deployment: canonical.id,
        url: requirePreviewUrl(canonical.url),
      };
    }
    const deployments = await cloudflare(
      '/deployments?env=production&per_page=100'
    );
    const target = deployments.find(
      (item) =>
        item.environment === 'production' && deploymentSha(item) === commit
    );
    if (target && ['failure', 'canceled'].includes(target.latest_stage?.status))
      return {
        state: 'build-failed',
        deployment: requireDeploymentId(target.id),
      };
    if (attempt + 1 < attempts) await wait(20000);
  }
  return { state: 'timeout' };
}

export async function finishWatch({
  commit,
  previous,
  deployment,
  state,
  smokeResult,
  errorKind,
  github,
  cloudflare,
  env = process.env,
} = {}) {
  requireSha(commit);
  requireDeploymentId(previous);
  const main = await github(`/repos/${REPOSITORY}/git/ref/heads/main`);
  if (main.object.sha !== commit || state === 'superseded')
    return { result: 'superseded' };
  const project = await cloudflare();
  const current = project.canonical_deployment;
  if (state === 'ready' && smokeResult === 'success') {
    if (current?.id !== deployment || deploymentSha(current) !== commit)
      return { result: 'superseded' };
    requireProduction(current);
    return { result: 'healthy', deployment };
  }
  // Persist the pause before rollback. Opening this issue also supplies a
  // durable recovery instruction instead of relying only on transient logs.
  await pauseAutomation(
    github,
    `生产验收未通过：${commit}；部署状态 ${state || 'unknown'}，验收 ${smokeResult || 'not-run'}。` +
      (errorKind === 'access'
        ? '访问被验证或网络阻断，不能据此判定新版功能故障。'
        : ''),
    env
  );
  // Build failures leave the old production serving. Network/challenge errors
  // pause updates but never roll back an otherwise untested deployment.
  if (state !== 'ready' || errorKind !== 'functional')
    return { result: 'paused' };
  requireDeploymentId(deployment);
  if (current?.id !== deployment || deploymentSha(current) !== commit)
    return { result: 'superseded' };
  requireProduction(current);
  const target = requireProduction(
    await cloudflare(`/deployments/${previous}`)
  );
  if (
    target.id === current.id ||
    deploymentSha(target) === commit ||
    !(Date.parse(target.created_on) < Date.parse(current.created_on))
  )
    throw new Error('Unsafe rollback target');
  // Recheck both providers immediately before acting. A later manual fix or
  // another deployment must not be reverted by an older monitor.
  const freshMain = await github(`/repos/${REPOSITORY}/git/ref/heads/main`);
  const freshProject = await cloudflare();
  if (
    freshMain.object.sha !== commit ||
    freshProject.canonical_deployment?.id !== deployment
  )
    return { result: 'superseded' };
  const rolledBack = requireProduction(
    await cloudflare(`/deployments/${target.id}/rollback`, 'POST')
  );
  if (
    rolledBack.id !== target.id ||
    deploymentSha(rolledBack) !== deploymentSha(target)
  )
    throw new Error('Cloudflare did not confirm the expected rollback');
  const verified = await cloudflare();
  if (verified.canonical_deployment?.id !== target.id)
    throw new Error('Rollback is not the canonical production deployment');
  return { result: 'rolled-back', deployment: target.id };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const env = process.env;
  if (
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.ENABLE_UPSTREAM_AUTOMERGE !== 'true' ||
    env.ENABLE_PDF_ROLLBACK !== 'true'
  ) {
    console.log('自动上线与回退开关尚未启用。');
  } else {
    const clients = apiClients();
    const args = {
      ...clients,
      commit: env.UPDATE_COMMIT,
      previous: env.PREVIOUS_DEPLOYMENT,
    };
    const operation =
      process.argv[2] === 'prepare'
        ? prepareWatch(args)
        : process.argv[2] === 'finish'
          ? finishWatch({
              ...args,
              state: env.DEPLOYMENT_STATE,
              deployment: env.DEPLOYMENT_ID,
              smokeResult: env.SMOKE_RESULT,
              errorKind: env.SMOKE_ERROR_KIND,
            })
          : Promise.reject(new Error('Expected prepare or finish'));
    operation
      .then((result) => {
        console.log(JSON.stringify(result));
        if (env.GITHUB_STEP_SUMMARY)
          appendFileSync(
            env.GITHUB_STEP_SUMMARY,
            `生产验收：${JSON.stringify(result)}\n`
          );
        if (env.GITHUB_OUTPUT)
          for (const [key, value] of Object.entries(result))
            appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
        if (
          ['paused', 'rolled-back', 'build-failed', 'timeout'].includes(
            result.result ?? result.state
          )
        )
          process.exitCode = 1;
      })
      .catch(async (error) => {
        console.error(error.message);
        try {
          await pauseAutomation(
            clients.github,
            `生产验收或回退流程中止：${error.message}`
          );
        } catch {
          console.error('无法创建暂停 Issue；需检查 Actions 运行记录。');
        }
        process.exitCode = 1;
      });
  }
}
