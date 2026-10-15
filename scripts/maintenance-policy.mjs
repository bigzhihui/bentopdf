import { readFileSync } from 'node:fs';

export const REPOSITORY = 'bigzhihui/bentopdf';
export const UPDATE_BRANCH = 'automation/sync-upstream';
export const PAUSE_MARKER = '<!-- pdf-maintenance-paused -->';
export const SITE_URL = 'https://pdf.afeiii.com';
export const CLOUDFLARE_ACCOUNT = 'fe2ce26b90c09bdfa08ce9e553f6d219';
export const CLOUDFLARE_PROJECT = 'bentopdf';
export const VALIDATION_CONTEXT = 'PDF validation';

// An allowlist applies to the entire update. Any unknown or critical file
// keeps the whole PR for review, even when the remaining files are low risk.
export function classifyUpdate(files) {
  const reasons = [];
  if (!files.length) reasons.push('没有可分类的改动');
  if (files.length > 20) reasons.push('超过 20 个改动文件');
  let lines = 0;
  for (const file of files) {
    const name = file.filename ?? '';
    const translation =
      /^public\/locales\/(ar|be|da|de|es|fr|id|it|ja|ko|nl|pl|pt|ru|sk|sv|tr|uk|vi)\/(common|tools)\.json$/.test(
        name
      );
    const guide = /^docs\/tools\/[a-z0-9-]+\.md$/.test(name);
    if (!translation && !guide) reasons.push(`需审查的文件：${name}`);
    if (!['modified', 'added'].includes(file.status) || file.previous_filename)
      reasons.push(`删除、重命名或未知改动类型：${name}`);
    if (translation && file.status !== 'modified')
      reasons.push(`新增语言包需审查：${name}`);
    if (typeof file.patch !== 'string')
      reasons.push(`缺少可审查的文本差异：${name}`);
    if (
      !Number.isSafeInteger(file.additions) ||
      file.additions < 0 ||
      !Number.isSafeInteger(file.deletions) ||
      file.deletions < 0
    )
      reasons.push(`无法核对改动行数：${name}`);
    else lines += file.additions + file.deletions;
  }
  if (lines > 400) reasons.push('超过 400 行增删');
  return {
    automatic: reasons.length === 0,
    reasons,
    fileCount: files.length,
    lines,
  };
}

export function plainTranslationChange(beforeText, afterText) {
  if (
    [beforeText, afterText].some((text) => Buffer.byteLength(text) > 256 * 1024)
  )
    return false;
  try {
    const compare = (before, after, depth = 0) => {
      if (depth > 30 || typeof before !== typeof after) return false;
      if (before === after) return true;
      if (typeof before === 'string')
        return (
          after.length <= 2000 &&
          ![before, after].some((text) =>
            /[<>\u0000-\u001f]|(?:https?|javascript|data|mailto):|\{\{|\}\}|%\w/i.test(
              text
            )
          )
        );
      if (
        !before ||
        !after ||
        Array.isArray(before) ||
        Array.isArray(after) ||
        typeof before !== 'object'
      )
        return false;
      const keys = Object.keys(before).sort();
      if (JSON.stringify(keys) !== JSON.stringify(Object.keys(after).sort()))
        return false;
      return keys.every((key) => compare(before[key], after[key], depth + 1));
    };
    return compare(JSON.parse(beforeText), JSON.parse(afterText));
  } catch {
    return false;
  }
}

export function requireSha(value) {
  if (!/^[a-f0-9]{40}$/.test(value ?? ''))
    throw new Error('Invalid commit SHA');
  return value;
}

export function requireDeploymentId(value) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value ?? ''))
    throw new Error('Invalid Cloudflare deployment ID');
  return value;
}

export function deploymentSha(deployment) {
  return deployment?.deployment_trigger?.metadata?.commit_hash;
}

export function requireProduction(deployment) {
  requireDeploymentId(deployment?.id);
  requireSha(deploymentSha(deployment));
  if (
    deployment.environment !== 'production' ||
    deployment.latest_stage?.status !== 'success'
  )
    throw new Error('Deployment is not a successful production deployment');
  return deployment;
}

export function requirePreviewUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !/^[a-f0-9]+\.bentopdf-ejf\.pages\.dev$/.test(url.hostname) ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Unexpected Pages deployment URL');
  return url.origin;
}

export function readEvent(env = process.env) {
  return env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    : {};
}
