// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

let processFileForLanguage;
let updateEnglishFile;
const temporaryRoots = [];
const locales = resolve('public/locales');
const load = (lang, namespace) =>
  JSON.parse(readFileSync(join(locales, lang, `${namespace}.json`), 'utf8'));

beforeAll(async () => {
  vi.stubEnv('SITE_URL', 'https://pdf.afeiii.com');
  vi.stubEnv('BASE_URL', '/');
  vi.stubEnv('VITE_BRAND_NAME', '十三月 PDF 工具');
  ({ processFileForLanguage, updateEnglishFile } =
    await import('../../scripts/generate-i18n-pages.mjs'));
});

afterAll(() => vi.unstubAllEnvs());

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(basename(root)).toMatch(/^afeiii-home-localization-/);
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'afeiii-home-localization-'));
  temporaryRoots.push(root);
  const catalog = readFileSync('src/partials/tool-links-static.html', 'utf8');
  const html = `<html lang="en"><head><title>PDF Tools</title>
    <meta name="title" content="PDF Tools">
    <meta name="description" content="English fallback">
    <link rel="canonical" href="https://pdf.afeiii.com"></head><body>
    <div id="tools-header"><h1 data-i18n="simpleMode.title">PDF Tools</h1></div>
    <p data-i18n="afeiiiIntro.tasks">Choose a PDF tool by task.</p>
    <p data-i18n="afeiiiIntro.privacy">Most file processing runs in your browser.</p>
    <div id="tool-grid">${catalog}</div></body></html>`;
  return { root, html };
}

describe('generated homepage language', () => {
  it('only emits tool translation keys present in the English catalog', () => {
    const dom = new JSDOM(
      readFileSync('src/partials/tool-links-static.html', 'utf8')
    );
    try {
      const tools = load('en', 'tools');
      for (const element of dom.window.document.querySelectorAll(
        '[data-i18n^="tools:"]'
      )) {
        const key = element.getAttribute('data-i18n').slice('tools:'.length);
        const value = key
          .split('.')
          .reduce((node, part) => node?.[part], tools);
        expect(value, key).toBeTypeOf('string');
      }
    } finally {
      dom.window.close();
    }
  });

  it.each([
    ['zh', '合并 PDF', '热门工具'],
    ['ar', 'دمج PDF', 'الأدوات الشائعة'],
    ['be', "Аб'яднаць PDF", 'Папулярныя інструменты'],
    ['da', 'Flet PDF', 'Populære værktøjer'],
  ])(
    'renders %s tool names and descriptions without JavaScript',
    (lang, name, category) => {
      const { root, html } = fixture();
      processFileForLanguage(
        html,
        'index.html',
        lang,
        {
          [lang]: { common: load(lang, 'common'), tools: load(lang, 'tools') },
        },
        root,
        ['en', lang]
      );
      const dom = new JSDOM(readFileSync(join(root, 'index.html'), 'utf8'));
      try {
        const document = dom.window.document;
        expect(document.documentElement.lang).toBe(lang);
        expect(
          document.querySelector(`a[href="/${lang}/merge-pdf"] h3`).textContent
        ).toBe(name);
        expect(document.querySelector('#tool-grid h2').textContent).toBe(
          category
        );
        expect(
          document.querySelector(`a[href="/${lang}/merge-pdf"] p`).textContent
        ).not.toBe('Combine multiple PDFs into one file. Preserves Bookmarks.');
        expect(document.querySelector('meta[name="description"]').content).toBe(
          load(lang, 'common').afeiiiIntro.tasks
        );
        expect(document.title).toBe(
          `十三月 PDF 工具 - ${load(lang, 'common').simpleMode.title}`
        );
        expect(document.querySelector('link[rel="canonical"]').href).toBe(
          `https://pdf.afeiii.com/${lang}/`
        );
        if (lang === 'ar') expect(document.documentElement.dir).toBe('rtl');
      } finally {
        dom.window.close();
      }
    }
  );

  it('keeps the English root metadata consistent with its declared language', () => {
    const { root, html } = fixture();
    const file = join(root, 'index.html');
    updateEnglishFile(file, html, ['en', 'zh']);
    const dom = new JSDOM(readFileSync(file, 'utf8'));
    try {
      const document = dom.window.document;
      expect(document.documentElement.lang).toBe('en');
      expect(document.title).toBe('十三月 PDF 工具 - PDF Tools');
      expect(document.querySelector('meta[name="description"]').content).toBe(
        load('en', 'common').afeiiiIntro.tasks
      );
    } finally {
      dom.window.close();
    }
  });

  it('provides translated introductions for every published language homepage', () => {
    for (const lang of readdirSync(locales)) {
      const common = load(lang, 'common');
      expect(common.afeiiiIntro?.tasks, lang).toBeTypeOf('string');
      expect(common.afeiiiIntro?.privacy, lang).toBeTypeOf('string');
      if (lang !== 'en') {
        expect(common.afeiiiIntro.tasks, lang).not.toBe(
          load('en', 'common').afeiiiIntro.tasks
        );
      }
    }
  });
});
