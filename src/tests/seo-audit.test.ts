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

function fixture(
  targetExists: boolean,
  body = '<a href="/word-to-pdf">Word to PDF</a>',
  localized?: 'covered' | 'missing'
) {
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
    `<html><head><title>PDF tools</title><link rel="canonical" href="https://pdf.afeiii.com"></head><body>${body}</body></html>`
  );
  writeFileSync(
    join(root, 'dist/sitemap.xml'),
    '<urlset><url><loc>https://pdf.afeiii.com</loc></url></urlset>'
  );
  if (targetExists) {
    // This page is excluded from its own SEO audit, but remains a real link target.
    writeFileSync(join(root, 'dist/word-to-pdf.html'), '<html></html>');
  }
  if (localized) {
    mkdirSync(join(root, 'dist/zh'));
    mkdirSync(join(root, 'public/locales/zh'), { recursive: true });
    writeFileSync(join(root, 'public/locales/zh/tools.json'), '{}');
    writeFileSync(
      join(root, 'dist/zh/index.html'),
      '<html><head><title>工具</title><link rel="canonical" href="https://pdf.afeiii.com/zh/"></head><body>工具</body></html>'
    );
    if (localized === 'covered') {
      writeFileSync(
        join(root, 'dist/sitemap.xml'),
        '<urlset><url><loc>https://pdf.afeiii.com</loc></url><url><loc>https://pdf.afeiii.com/zh/</loc></url></urlset>'
      );
    }
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
  it('rejects a localized canonical URL omitted from sitemap', () => {
    const result = fixture(true, 'PDF tools', 'missing');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[sitemap-coverage]');
    expect(result.stderr).toContain('https://pdf.afeiii.com/zh/');
  });

  it('accepts independent language URLs without XML hreflang duplication', () => {
    const result = fixture(true, 'PDF tools', 'covered');
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects an empty homepage tool grid that requires JavaScript for discovery', () => {
    const result = fixture(true, '<div class="grid" id="tool-grid"></div>');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[tool-links]');
  });

  it('accepts a homepage with static links inside its tool grid', () => {
    const result = fixture(
      true,
      '<div id="tool-grid"><a href="/word-to-pdf">Word to PDF</a></div>'
    );
    expect(result.status, result.stderr).toBe(0);
  });

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
