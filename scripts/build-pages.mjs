import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Public defaults shared by local verification and CI. Hosting environment
// variables take precedence; credentials never belong in this file.
const defaults = JSON.parse(
  readFileSync(
    new URL('../cloudflare/pages-config.json', import.meta.url),
    'utf8'
  )
);
const env = { ...defaults, ...process.env };
const cwd = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli)
  throw new Error('Please run this entry point with npm run build:pages');

for (const [command, args] of [
  [process.execPath, [npmCli, 'run', 'build']],
  [process.execPath, ['scripts/cloudflare-pages.mjs']],
  [process.execPath, ['scripts/seo-audit.mjs']],
]) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
