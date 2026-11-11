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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const load = (language, namespace) =>
  JSON.parse(
    readFileSync(`public/locales/${language}/${namespace}.json`, 'utf8')
  );
const resources = {
  ar: { common: load('ar', 'common'), tools: load('ar', 'tools') },
};
const temporary = [];
let processFileForLanguage;

beforeAll(async () => {
  vi.stubEnv('SITE_URL', 'https://pdf.afeiii.com');
  vi.stubEnv('VITE_BRAND_NAME', '十三月 PDF 工具');
  ({ processFileForLanguage } =
    await import('../../scripts/generate-i18n-pages.mjs'));
});
afterAll(() => vi.unstubAllEnvs());
afterEach(() => {
  for (const root of temporary.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(basename(root)).toMatch(/^afeiii-ar-localization-/);
    rmSync(root, { recursive: true, force: true });
  }
});

function generate(source, filename) {
  const root = mkdtempSync(join(tmpdir(), 'afeiii-ar-localization-'));
  temporary.push(root);
  processFileForLanguage(source, filename, 'ar', resources, root, ['en', 'ar']);
  return new JSDOM(readFileSync(join(root, filename), 'utf8'));
}

describe('Arabic generated pages', () => {
  it.each(['merge', 'compress'])(
    'translates %s instructions and FAQ while retaining links and icons',
    (tool) => {
      const filename = `${tool}-pdf.html`;
      // The production SEO stage inserts these schemas before locale generation.
      const schemas = ['FAQPage', 'HowTo']
        .map(
          (type) =>
            `<script type="application/ld+json">${JSON.stringify({ '@type': type })}</script>`
        )
        .join('');
      const dom = generate(
        readFileSync(`src/pages/${filename}`, 'utf8').replace(
          '</body>',
          `${schemas}</body>`
        ),
        filename
      );
      try {
        const d = dom.window.document;
        expect(d.documentElement.lang).toBe('ar');
        expect(d.documentElement.dir).toBe('rtl');
        for (const element of d.querySelectorAll('[data-i18n]')) {
          const key = element.getAttribute('data-i18n');
          const [namespace, path] = key.includes(':')
            ? key.split(':')
            : ['common', key];
          const value = path
            .split('.')
            .reduce((node, part) => node?.[part], resources.ar[namespace]);
          expect(value, key).toBeTypeOf('string');
          expect(element.textContent, key).toBe(value);
        }
        const questions = [...d.querySelectorAll('.faq-d-q')];
        expect(questions).toHaveLength(8);
        for (const question of questions) {
          expect(question.textContent).toMatch(/[\u0600-\u06ff]/);
          expect(question.querySelector('[data-lucide="plus"]')).not.toBeNull();
        }
        const faqLink = d.querySelector('.faq-list a');
        expect(faqLink).not.toBeNull();
        expect(faqLink.getAttribute('href')).toMatch(/^\/ar\//);
        expect(faqLink.textContent).toMatch(/[\u0600-\u06ff]/);
        const schema = [
          ...d.querySelectorAll('script[type="application/ld+json"]'),
        ].map((node) => JSON.parse(node.textContent));
        const faq = schema.find((item) => item['@type'] === 'FAQPage');
        expect(faq.mainEntity[0].name).toBe(
          questions[0].textContent.replace(/\s+/g, ' ').trim()
        );
        expect(
          schema.find((item) => item['@type'] === 'HowTo').step[0].name
        ).toBe('رفع ملفات PDF');
      } finally {
        dom.window.close();
      }
    }
  );

  it('translates footer navigation and its accessible name without JavaScript', () => {
    const partial = readFileSync('src/partials/footer-simple.html', 'utf8');
    const dom = generate(
      `<html><head></head><body>${partial}</body></html>`,
      'index.html'
    );
    try {
      const nav = dom.window.document.querySelector('footer nav');
      expect(nav.getAttribute('aria-label')).toBe(
        resources.ar.common.afeiiiFooter.navigation
      );
      expect(nav.textContent).not.toMatch(/[\u4e00-\u9fff]/);
      for (const link of nav.querySelectorAll('a'))
        expect(link.textContent).toMatch(/[\u0600-\u06ff]/);
    } finally {
      dom.window.close();
    }
  });
});

describe('localized feedback keeps the existing privacy boundary', () => {
  it.each([
    ['ar', 'الإبلاغ عن مشكلة', 'إغلاق الملاحظات'],
    ['en', 'Report an issue', 'Close feedback'],
    ['zh', '反馈问题', '关闭反馈'],
  ])(
    'opens %s feedback without sending a message or usage event',
    async (language, title, close) => {
      const dom = new JSDOM(`<html lang="${language}"><body></body></html>`, {
        url: 'https://pdf.afeiii.com/ar/',
        runScripts: 'outside-only',
      });
      try {
        const w = dom.window;
        w.HTMLDialogElement.prototype.showModal = function () {
          this.open = true;
        };
        w.HTMLDialogElement.prototype.close = function () {
          this.open = false;
        };
        w.fetch = vi.fn(async () => ({
          ok: true,
          json: async () => ({ pdf: { home: 'Home' } }),
        }));
        w.eval(readFileSync('public/engagement/feedbackfin.js', 'utf8'));
        await vi.waitFor(() =>
          expect(
            w.document.querySelector('.feedbackfin-trigger')
          ).not.toBeNull()
        );
        const button = w.document.querySelector('.feedbackfin-trigger');
        expect(button.textContent).toBe(title);
        button.click();
        expect(w.document.querySelector('dialog').open).toBe(true);
        expect(w.document.querySelector('input[type="checkbox"]').checked).toBe(
          false
        );
        expect(w.document.querySelector('textarea').maxLength).toBe(2000);
        expect(w.fetch).toHaveBeenCalledTimes(1);
        expect(w.fetch.mock.calls[0][0]).toBe('/engagement/catalog.json');
        if (language === 'ar')
          expect(w.document.body.textContent).not.toMatch(/[\u4e00-\u9fff]/);
        w.document.querySelector(`[aria-label="${close}"]`).click();
        expect(w.document.querySelector('dialog').open).toBe(false);
      } finally {
        dom.window.close();
      }
    }
  );
});
