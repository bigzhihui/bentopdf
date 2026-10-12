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
//   so the CSP follows whatever WASM and OCR URLs the build was given. The CSP
//   also lets in the beacon of Cloudflare Web Analytics.
// - Removes the .br and .gz copies made for nginx's precompressed serving:
//   Cloudflare compresses responses itself and never serves them.
// - With VITE_BRAND_NAME set, puts the brand into the static titles and site
//   names that search engines and link previews read. VITE_BRAND_NAME only
//   reaches the page at runtime, so the generated HTML still says BentoPDF.
//   Author and structured data keep crediting BentoPDF. SITE_DESCRIPTION, if
//   set, replaces the English description of the home pages.
// - Removes the pages of the tools turned off with DISABLE_TOOLS, which the
//   build still generates and which would fail without their engine, and the
//   pages listed in EXCLUDE_PAGES. The five afeiii information pages are kept
//   even when an older deployment setting still lists their upstream versions.
//   Each goes in every language, a directory name such as
//   "blog" goes as a whole, and all are dropped from the sitemap.
// - Points robots.txt at this site's sitemap when SITE_URL is set.
// - Hosts the WASM engines, OCR data and fonts on this site when their URLs
//   point under SITE_URL, instead of loading them from jsDelivr and githack,
//   which many networks in mainland China cannot reach.
// - Fails early if a file is still too large or there are too many files,
//   rather than at deploy time.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
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
const ownedPages = new Set(['about', 'contact', 'faq', 'privacy', 'terms']);
const disabledTools = new Set(listFrom(process.env.DISABLE_TOOLS));
const excludedPages = [
  ...disabledTools,
  ...listFrom(process.env.EXCLUDE_PAGES),
].filter((page) => !ownedPages.has(page));
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

// Self-hosted assets. For each of the asset URLs below that points under
// SITE_URL, the files it expects are fetched here, at the versions this build
// loads from jsDelivr and githack by default, and put at that path. They must
// be full URLs rather than paths: the PDF editor fetches its fonts from a
// blob: worker, where a path cannot resolve.
const siteOrigin = siteUrl && new URL(siteUrl).origin;
const cacheDir = join(repoRoot, 'node_modules', '.cache', 'cloudflare-pages');
const readSource = (file) => readFileSync(join(repoRoot, file), 'utf8');

// The file or directory in dist/ that an asset URL on this site stands for.
function selfHostedPath(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    return null;
  }
  if (!URL.canParse(value)) {
    throw new Error(`${name} must be a full URL: ${value}`);
  }
  const url = new URL(value);
  return url.origin === siteOrigin ? join(dist, url.pathname) : null;
}

// Splits a jsDelivr npm path, such as @bentopdf/gs-wasm@0.1.1/assets/, into
// the package to install and where the path is once it is installed.
function splitNpmPath(path) {
  const match = path.match(/^((?:@[\w.-]+\/)?[\w.-]+)@([\w.-]+)\/(.*)$/);
  if (!match) {
    throw new Error(`Not a jsDelivr npm path: ${path}`);
  }
  const [, name, version, inner] = match;
  return {
    spec: `${name}@${version}`,
    installed: join(cacheDir, 'node_modules', name, inner),
  };
}

const packages = new Set();
const copies = [];
const downloads = [];

const wasmProvider = readSource('src/js/utils/wasm-provider.ts');
for (const [name, engine] of [
  ['VITE_WASM_PYMUPDF_URL', 'pymupdf'],
  ['VITE_WASM_GS_URL', 'ghostscript'],
  ['VITE_WASM_CPDF_URL', 'cpdf'],
]) {
  const target = selfHostedPath(name);
  if (!target) {
    continue;
  }
  const path = wasmProvider.match(
    new RegExp(`${engine}: 'https://cdn\\.jsdelivr\\.net/npm/([^']+)'`)
  )?.[1];
  if (!path) {
    throw new Error(`No jsDelivr URL for ${engine} in wasm-provider.ts`);
  }
  const { spec, installed } = splitNpmPath(path);
  packages.add(spec);
  copies.push([installed, target]);
  if (engine === 'ghostscript') {
    const libraryRoot = target.replace(/[\\/]assets[\\/]?$/, '');
    copies.push([join(dirname(installed), 'dist'), join(libraryRoot, 'dist')]);
    if (libraryRoot === target) {
      copies.push([installed, join(target, 'assets')]);
    }
  }
}

const tesseractWorker = selfHostedPath('VITE_TESSERACT_WORKER_URL');
if (tesseractWorker) {
  copies.push([
    join(repoRoot, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js'),
    tesseractWorker,
  ]);
}
const tesseractCore = selfHostedPath('VITE_TESSERACT_CORE_URL');
if (tesseractCore) {
  copies.push([
    join(repoRoot, 'node_modules', 'tesseract.js-core'),
    tesseractCore,
  ]);
}
// The OCR runs Tesseract's LSTM engine alone (OEM 1), for which Tesseract.js
// loads the 4.0.0_best_int data of each language.
const tesseractData = selfHostedPath('VITE_TESSERACT_LANG_URL');
if (tesseractData) {
  const ocrLanguages = (process.env.VITE_TESSERACT_AVAILABLE_LANGUAGES || '')
    .split(/[+,]/)
    .map((code) => code.trim())
    .filter(Boolean);
  if (ocrLanguages.length === 0) {
    throw new Error(
      'List the OCR languages to host in VITE_TESSERACT_AVAILABLE_LANGUAGES'
    );
  }
  for (const language of ocrLanguages) {
    const file = `${language}.traineddata.gz`;
    const data = `@tesseract.js-data/${language}`;
    packages.add(data);
    copies.push([
      join(cacheDir, 'node_modules', data, '4.0.0_best_int', file),
      join(tesseractData, file),
    ]);
  }
}

const editorFonts = selfHostedPath('VITE_EMBEDPDF_FONTS_URL');
if (editorFonts) {
  if (process.env.VITE_EMBEDPDF_FONTS_URL.trim().endsWith('/')) {
    throw new Error(
      'VITE_EMBEDPDF_FONTS_URL must not end in /: the editor adds one before each font'
    );
  }
  const source = readSource('src/js/config/editor-fonts.ts');
  const scope = source.match(
    /'https:\/\/cdn\.jsdelivr\.net\/npm\/(@[\w.-]+)'/
  )?.[1];
  const fonts = [...source.matchAll(/'(fonts-[\w.-]+@[\w.-]+\/[^']+)'/g)].map(
    ([, font]) => font
  );
  if (!scope || fonts.length === 0) {
    throw new Error('No jsDelivr fonts found in editor-fonts.ts');
  }
  for (const font of fonts) {
    const { spec, installed } = splitNpmPath(`${scope}/${font}`);
    packages.add(spec);
    copies.push([installed, join(editorFonts, font)]);
  }
}

const ocrFonts = selfHostedPath('VITE_OCR_FONT_BASE_URL');
if (ocrFonts) {
  const urls = readSource('src/js/config/font-mappings.ts').matchAll(
    /'(https:\/\/[^']+)'/g
  );
  for (const url of new Set([...urls].map(([, url]) => url))) {
    // Fetch the same pinned GitHub font through jsDelivr; githack may be
    // unreachable from the build machine even when the final site hosts it.
    const downloadUrl = url.replace(
      /^https:\/\/rawcdn\.githack\.com\/([^/]+)\/([^/]+)\/([^/]+)\//,
      'https://cdn.jsdelivr.net/gh/$1/$2@$3/'
    );
    downloads.push([downloadUrl, join(ocrFonts, url.split('/').pop())]);
  }
}

if (packages.size > 0) {
  const specs = [...packages];
  const invalid = specs.find(
    (spec) => !/^(?:@[\w.-]+\/)?[\w.-]+(?:@[\w.-]+)?$/.test(spec)
  );
  if (invalid) {
    throw new Error(`Not a package name: ${invalid}`);
  }
  // A package.json of its own keeps npm from installing into the project.
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'package.json'), '{ "private": true }\n');
  const args = [
    'install',
    '--prefix',
    cacheDir,
    '--no-save',
    '--no-package-lock',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    ...specs,
  ];
  // npm is a .cmd script on Windows, which only runs through a shell.
  const result =
    process.platform === 'win32'
      ? spawnSync(`npm ${args.map((arg) => `"${arg}"`).join(' ')}`, {
          stdio: 'inherit',
          shell: true,
        })
      : spawnSync('npm', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error('Could not install the self-hosted assets');
  }
}

for (const [from, to] of copies) {
  if (!existsSync(from)) {
    throw new Error(`Missing self-hosted asset: ${relative(repoRoot, from)}`);
  }
  cpSync(from, to, { recursive: true });
}

async function downloadAsset(url, to) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, bytes);
      return;
    } catch (cause) {
      if (attempt === 3) {
        throw new Error(`Could not download ${url} after ${attempt} attempts`, {
          cause,
        });
      }
      console.warn(`Retrying ${url} after download attempt ${attempt} failed`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
}

// Bound concurrent TLS connections and large font buffers on build machines.
for (let offset = 0; offset < downloads.length; offset += 4) {
  await Promise.all(
    downloads
      .slice(offset, offset + 4)
      .map(([url, to]) => downloadAsset(url, to))
  );
}

// Cloudflare Web Analytics, when it is on for the project or the zone, puts a
// beacon into each page, which loads its script from and reports to
// cloudflareinsights.com.
const webAnalyticsSources = {
  'script-src': 'https://static.cloudflareinsights.com',
  'connect-src': 'https://cloudflareinsights.com',
};
const allowWebAnalytics = (policy) =>
  policy
    .split('; ')
    .map((directive) => {
      const source = webAnalyticsSources[directive.split(' ')[0]];
      return source ? `${directive} ${source}` : directive;
    })
    .join('; ');

const securityHeaders = readFileSync(
  join(repoRoot, 'security-headers.conf'),
  'utf8'
)
  .split('\n')
  .map((line) => line.match(/^add_header\s+(\S+)\s+"(.*)"\s+always;$/))
  .filter(Boolean)
  .map(
    ([, name, value]) =>
      `  ${name}: ${name === 'Content-Security-Policy' ? allowWebAnalytics(value) : value}`
  );

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
const brandMetaKeys = new Set([
  'author',
  'title',
  'og:title',
  'twitter:title',
  'og:site_name',
  'apple-mobile-web-app-title',
  'application-name',
]);
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
  const homeLanguage = page.includes('/')
    ? page.split('/')[0]
    : defaultLanguage;
  const simpleHomeTitle =
    homeLanguage === 'zh'
      ? `${name} - 免费在线 PDF 合并、拆分、压缩与转换工具`
      : `${name} - Free Online PDF Merge, Split, Compress and Convert Tools`;
  let html = original
    .replace(
      /<title>([\s\S]*?)<\/title>/gi,
      (_, title) => `<title>${title.replaceAll('BentoPDF', name)}</title>`
    )
    .replace(
      '<title>PDF Tools</title>',
      () => `<title>${simpleHomeTitle}</title>`
    )
    .replace(/<meta\b[^>]*>/gi, (tag) => {
      const key = tag.match(/\b(?:name|property)="([^"]+)"/i)?.[1];
      if (!key || !brandMetaKeys.has(key)) {
        return tag;
      }
      return tag.replace(
        /\bcontent="([^"]*)"/i,
        (_, value) =>
          `content="${
            value === 'PDF Tools'
              ? ['title', 'og:title', 'twitter:title'].includes(key)
                ? simpleHomeTitle
                : name
              : value.replaceAll('BentoPDF', name)
          }"`
      );
    })
    .replace(
      /<meta\s+name="twitter:(?:site|creator)"\s+content="@BentoPDF"\s*\/?>/gi,
      ''
    );

  html = html.replace(
    /(<script\b[^>]*type="application\/ld\+json"[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (tag, open, json, close) => {
      let data;
      try {
        data = JSON.parse(json);
      } catch {
        return tag;
      }
      if (data?.['@type'] === 'Organization' && data.name === 'BentoPDF') {
        return '';
      }
      if (
        ['WebSite', 'SoftwareApplication', 'WebApplication'].includes(
          data?.['@type']
        ) &&
        typeof data.name === 'string' &&
        data.name.includes('BentoPDF')
      ) {
        data.name = data.name.replaceAll('BentoPDF', brand);
        return `${open}${JSON.stringify(data, null, 2)}${close}`;
      }
      return tag;
    }
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

function removeDisabledToolLinks(path) {
  if (disabledTools.size === 0) return;
  const original = readFileSync(path, 'utf8');
  const localized = relative(dist, path).replace(/\\/g, '/').startsWith('zh/');
  const suffix = localized ? '（本站暂不可用）' : ' (unavailable on this site)';
  const html = original.replace(
    /<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    (anchor, href, body) => {
      if (/^(?:https?:|\/\/|mailto:|tel:|#)/i.test(href)) return anchor;
      const slug = href
        .split(/[?#]/, 1)[0]
        .split('/')
        .filter(Boolean)
        .pop()
        ?.replace(/\.html$/, '');
      if (!slug || !disabledTools.has(slug)) return anchor;
      if (/<h[1-6]\b/i.test(body)) return '';
      return `<span class="text-gray-500">${body}${suffix}</span>`;
    }
  );
  if (html !== original) writeFileSync(path, html);
}

if (brand) {
  const manifestPath = join(dist, 'site.webmanifest');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.name = brand;
    manifest.short_name = brand;
    if (siteDescription) manifest.description = siteDescription;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
      if (path.endsWith('.html')) removeDisabledToolLinks(path);
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
  `Cloudflare Pages: ${files.length} files (${excludedFiles} excluded pages removed, ${copies.length + downloads.length} assets self-hosted, ${precompressedRemoved} precompressed copies removed, ${rebranded} pages rebranded), largest ${relative(dist, largest.path)} (${(largest.size / 1048576).toFixed(1)} MiB), _headers written`
);
