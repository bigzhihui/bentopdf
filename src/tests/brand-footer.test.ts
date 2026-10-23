import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Handlebars from 'handlebars';

const handlebars = Handlebars.create();
const partial = readFileSync(
  resolve('src/partials/footer-simple.html'),
  'utf8'
);
handlebars.registerPartial('footer-simple', partial);
handlebars.registerPartial('settings-modal', '');
handlebars.registerPartial('warning-modal', '');
handlebars.registerPartial(
  'tool-links-static',
  readFileSync(resolve('src/partials/tool-links-static.html'), 'utf8')
);
const renderers = [
  { name: 'tool footer', render: handlebars.compile(partial) },
  {
    name: 'simple-mode homepage',
    render: handlebars.compile(
      readFileSync(resolve('simple-index.html'), 'utf8')
    ),
  },
];
const source = 'https://github.com/bigzhihui/bentopdf';

describe.each(renderers)('$name source access', ({ render }) => {
  it.each([
    '',
    '基于开源项目 BentoPDF（AGPL-3.0），源码：github.com/bigzhihui/bentopdf',
  ])('keeps one clickable source link with custom footer %j', (footerText) => {
    const doc = new DOMParser().parseFromString(
      render({ brandName: '十三月 PDF 工具', footerText, appVersion: '2.8.8' }),
      'text/html'
    );
    expect(doc.querySelectorAll(`a[href="${source}"]`)).toHaveLength(1);
    expect(doc.querySelector('footer')?.textContent).toContain(
      '十三月 PDF 工具'
    );
    if (footerText)
      expect(doc.querySelector('footer')?.textContent).toContain(footerText);
  });

  it('still escapes custom footer text', () => {
    const doc = new DOMParser().parseFromString(
      render({
        brandName: '十三月 PDF 工具',
        footerText: '<script>unexpected()</script>',
      }),
      'text/html'
    );
    expect(doc.querySelector('footer script')).toBeNull();
    expect(doc.querySelectorAll(`a[href="${source}"]`)).toHaveLength(1);
  });

  it('preserves the original unbranded footer attribution', () => {
    const doc = new DOMParser().parseFromString(render({}), 'text/html');
    expect(doc.querySelector('footer')?.textContent).toContain('2026 BentoPDF');
    expect(doc.querySelector(`a[href="${source}"]`)).toBeNull();
  });
});
