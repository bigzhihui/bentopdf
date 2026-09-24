#!/usr/bin/env node
// Prepares dist/ for Cloudflare Pages. Run it after `npm run build`:
//
//   npm run build && node scripts/cloudflare-pages.mjs
//
// - Pages rejects any file over 25 MiB, and the LibreOffice WASM files are
//   larger, so they are removed. Build with the Office conversion tools listed
//   in DISABLE_TOOLS so nothing links to them.
// - Writes dist/_headers with the same security headers nginx sends in the
//   Docker image (security-headers.conf, from generate-security-headers.mjs),
//   so the CSP follows whatever WASM and OCR URLs the build was given.
// - Removes the .br and .gz copies made for nginx's precompressed serving:
//   Cloudflare compresses responses itself and never serves them.
// - With VITE_BRAND_NAME set, puts the brand into the static titles and site
//   names that search engines and link previews read. VITE_BRAND_NAME only
//   reaches the page at runtime, so the generated HTML still says BentoPDF.
//   Author and structured data keep crediting BentoPDF. SITE_DESCRIPTION, if
//   set, replaces the English description of the home pages.
// - Removes the pages of the tools turned off with DISABLE_TOOLS, which the
//   build still generates and which would fail without their engine, and the
//   pages listed in EXCLUDE_PAGES, such as bentopdf.com's own about, contact
//   and legal pages. Each goes in every language, a directory name such as
//   "blog" goes as a whole, and all are dropped from the sitemap.
// - Points robots.txt at this site's sitemap when SITE_URL is set.
// - Fails early if a file is still too large or there are too many files,
//   rather than at deploy time.
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repoRoot, 'dist');
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 20000;

rmSync(join(dist, 'libreoffice-wasm'), { recursive: true, force: true });

const listFrom = (value) =>
  (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
const excludedPages = [
  ...listFrom(process.env.DISABLE_TOOLS),
  ...listFrom(process.env.EXCLUDE_PAGES),
];
const invalidPage = excludedPages.find((page) => !/^[a-z0-9-]+$/i.test(page));
if (invalidPage) {
  throw new Error(`Not a page name: ${invalidPage}`);
}

const languages = readdirSync(join(repoRoot, 'public', 'locales'));
let excludedFiles = 0;
for (const page of excludedPages) {
  for (const language of ['', ...languages]) {
    for (const target of [
      join(dist, language, `${page}.html`),
      join(dist, language, page),
    ]) {
      if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
        excludedFiles++;
      }
    }
  }
}

const sitemapPath = join(dist, 'sitemap.xml');
if (excludedPages.length > 0 && existsSync(sitemapPath)) {
  const excluded = new Set(excludedPages);
  const sitemap = readFileSync(sitemapPath, 'utf8').replace(
    /\s*<url>[\s\S]*?<\/url>/g,
    (entry) => {
      const location = entry.match(/<loc>([^<]*)<\/loc>/)?.[1];
      const segments = location
        ? new URL(location).pathname.split('/').filter(Boolean)
        : [];
      const page = languages.includes(segments[0]) ? segments[1] : segments[0];
      return excluded.has(page) ? '' : entry;
    }
  );
  writeFileSync(sitemapPath, sitemap);
}

const siteUrl = process.env.SITE_URL?.trim().replace(/\/+$/, '');
const robotsPath = join(dist, 'robots.txt');
if (siteUrl && existsSync(robotsPath)) {
  writeFileSync(
    robotsPath,
    readFileSync(robotsPath, 'utf8').replace(
      /^Sitemap: .*$/m,
      `Sitemap: ${siteUrl}/sitemap.xml`
    )
  );
}

const securityHeaders = readFileSync(
  join(repoRoot, 'security-headers.conf'),
  'utf8'
)
  .split('\n')
  .map((line) => line.match(/^add_header\s+(\S+)\s+"(.*)"\s+always;$/))
  .filter(Boolean)
  .map(([, name, value]) => `  ${name}: ${value}`);

if (securityHeaders.length === 0) {
  throw new Error('No headers found in security-headers.conf');
}

// Caching mirrors nginx.conf: the service worker and workers revalidate on
// every load, and Vite's hashed assets never change.
const rules = [
  ['/*', securityHeaders],
  ['/sw.js', ['  Cache-Control: no-cache']],
  ['/workers/*', ['  Cache-Control: no-cache']],
  ['/assets/*', ['  Cache-Control: public, max-age=31536000, immutable']],
];

writeFileSync(
  join(dist, '_headers'),
  `${rules.map(([path, lines]) => [path, ...lines].join('\n')).join('\n\n')}\n`
);

const brand = process.env.VITE_BRAND_NAME?.trim();
const siteDescription = process.env.SITE_DESCRIPTION?.trim();
const escapeAttribute = (value) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
let rebranded = 0;

function rebrand(path) {
  const original = readFileSync(path, 'utf8');
  const name = escapeAttribute(brand);
  // SITE_DESCRIPTION is written for the default language, so only the root
  // home page and that language's home page get it.
  const page = relative(dist, path).replace(/\\/g, '/');
  const defaultLanguage = process.env.VITE_DEFAULT_LANGUAGE || 'en';
  const isHome =
    page === 'index.html' || page === `${defaultLanguage}/index.html`;
  let html = original
    .replace(
      /(<title>[^<]*?)(?: - | \| )BentoPDF<\/title>/,
      (_, title) => `${title} - ${name}</title>`
    )
    .replace('<title>PDF Tools</title>', () => `<title>${name}</title>`)
    .replace(
      /(<meta (?:name|property)="(?:title|og:title|twitter:title)" content="[^"]*?)(?: - | \| )BentoPDF"/g,
      (_, start) => `${start} - ${name}"`
    )
    .replace(
      /(<meta (?:name|property)="(?:title|og:title|twitter:title|og:site_name|apple-mobile-web-app-title|application-name)" content=")(?:BentoPDF|PDF Tools)"/g,
      (_, start) => `${start}${name}"`
    );

  if (siteDescription && isHome) {
    html = html.replace(
      /(<meta (?:name|property)="(?:description|og:description|twitter:description)" content=")[^"]*"/g,
      (_, start) => `${start}${escapeAttribute(siteDescription)}"`
    );
  }

  if (html !== original) {
    writeFileSync(path, html);
    rebranded++;
  }
}

const files = [];
let precompressedRemoved = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
    } else if (
      /\.(br|gz)$/.test(path) &&
      existsSync(path.replace(/\.(br|gz)$/, ''))
    ) {
      rmSync(path);
      precompressedRemoved++;
    } else {
      if (brand && path.endsWith('.html')) {
        rebrand(path);
      }
      files.push({ path, size: statSync(path).size });
    }
  }
};
walk(dist);

const tooLarge = files.filter((file) => file.size > MAX_FILE_BYTES);
if (tooLarge.length > 0 || files.length > MAX_FILES) {
  for (const file of tooLarge) {
    console.error(
      `Too large for Cloudflare Pages: ${relative(dist, file.path)} (${(file.size / 1048576).toFixed(1)} MiB)`
    );
  }
  if (files.length > MAX_FILES) {
    console.error(`Too many files for Cloudflare Pages: ${files.length}`);
  }
  process.exit(1);
}

const largest = files.reduce((a, b) => (b.size > a.size ? b : a));
console.log(
  `Cloudflare Pages: ${files.length} files (${excludedFiles} excluded pages removed, ${precompressedRemoved} precompressed copies removed, ${rebranded} pages rebranded), largest ${relative(dist, largest.path)} (${(largest.size / 1048576).toFixed(1)} MiB), _headers written`
);
