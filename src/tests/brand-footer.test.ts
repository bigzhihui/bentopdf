import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Handlebars from 'handlebars';

const render = Handlebars.compile(
  readFileSync(resolve('src/partials/footer-simple.html'), 'utf8')
);
const source = 'https://github.com/bigzhihui/bentopdf';

describe('branded footer source access', () => {
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
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelectorAll(`a[href="${source}"]`)).toHaveLength(1);
  });

  it('preserves the original unbranded footer attribution', () => {
    const doc = new DOMParser().parseFromString(render({}), 'text/html');
    expect(doc.querySelector('footer')?.textContent).toContain('2026 BentoPDF');
    expect(doc.querySelector(`a[href="${source}"]`)).toBeNull();
  });
});
