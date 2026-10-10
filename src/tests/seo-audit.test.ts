import { afterEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(basename(root)).toMatch(/^afeiii-seo-audit-/);
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(targetExists: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'afeiii-seo-audit-'));
  temporaryRoots.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'dist'));
  mkdirSync(join(root, 'public/locales/en'), { recursive: true });
  copyFileSync(
    join(process.cwd(), 'scripts/seo-audit.mjs'),
    join(root, 'scripts/seo-audit.mjs')
  );
  writeFileSync(join(root, 'public/locales/en/tools.json'), '{}');
  writeFileSync(
    join(root, 'dist/index.html'),
    '<html><head><title>PDF tools</title><link rel="canonical" href="https://pdf.afeiii.com"></head><body><a href="/word-to-pdf">Word to PDF</a></body></html>'
  );
  writeFileSync(
    join(root, 'dist/sitemap.xml'),
    '<urlset><url><loc>https://pdf.afeiii.com</loc></url></urlset>'
  );
  if (targetExists) {
    // This page is excluded from its own SEO audit, but remains a real link target.
    writeFileSync(join(root, 'dist/word-to-pdf.html'), '<html></html>');
  }
  return spawnSync(process.execPath, [join(root, 'scripts/seo-audit.mjs')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SITE_URL: 'https://pdf.afeiii.com',
      BASE_URL: '/',
      DISABLE_TOOLS: 'word-to-pdf',
      EXCLUDE_PAGES: '',
    },
  });
}

describe('SEO audit deployment phases', () => {
  it('accepts links to excluded files before deployment preparation', () => {
    const result = fixture(true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('1 HTML files passed');
  });

  it('rejects leftover links after an excluded file has been removed', () => {
    const result = fixture(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[dead-link]');
    expect(result.stderr).toContain('/word-to-pdf');
  });
});
