import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  readFileSync,
  statSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import {
  SITE_URL,
  requirePreviewUrl,
  requireSha,
} from './maintenance-policy.mjs';

class SmokeAccessError extends Error {}

function checkedBase(value) {
  const url = new URL(value);
  if (
    url.origin === SITE_URL &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash
  )
    return url.origin;
  if (
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    url.port &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password
  )
    return url.origin;
  return requirePreviewUrl(value);
}

export async function serveDistribution(directory) {
  const root = resolve(directory);
  if (!existsSync(resolve(root, 'index.html')))
    throw new Error('Build dist before browser verification');
  const mime = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.otf': 'font/otf',
    '.ttf': 'font/ttf',
  };
  const server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, 'http://localhost').pathname
      );
      let path = resolve(root, `.${pathname}`);
      if (path !== root && !path.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end();
        return;
      }
      if (existsSync(path) && statSync(path).isDirectory())
        path = resolve(path, 'index.html');
      if (!existsSync(path) && existsSync(`${path}.html`)) path += '.html';
      if (!existsSync(path) || !statSync(path).isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(readFileSync(path));
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept()))
      ),
  };
}

export async function runPdfSmoke({
  baseUrl,
  expectedCommit,
  artifactDir,
  executablePath,
  localAssets = false,
} = {}) {
  const base = checkedBase(baseUrl);
  if (expectedCommit) requireSha(expectedCommit);
  const [{ chromium }, { PDFDocument, StandardFonts }] = await Promise.all([
    import('playwright'),
    import('pdf-lib'),
  ]);
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    acceptDownloads: true,
    serviceWorkers: 'block',
  });
  const errors = [];
  const checks = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const pass = (text) => {
    checks.push(text);
    console.log(`PASS: ${text}`);
  };
  const visit = async (path) => {
    let response;
    try {
      response = await page.goto(`${base}${path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
    } catch {
      throw new SmokeAccessError('Page could not be reached');
    }
    if (response?.status() === 404 && expectedCommit)
      throw new Error(
        `Required page is missing from the verified build: ${path}`
      );
    if (
      !response ||
      response.status() >= 400 ||
      response.headers()['cf-mitigated'] === 'challenge'
    )
      throw new SmokeAccessError(
        `Page access did not succeed: ${response?.status()}`
      );
    if (
      /just a moment|attention required|verify you are human/i.test(
        await page.title()
      )
    )
      throw new SmokeAccessError(
        'Page access requires an interactive challenge'
      );
  };
  const downloadedPdf = async (download, pages) => {
    assert.equal(await download.failure(), null);
    const stream = await download.createReadStream();
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      assert.ok(size < 20 * 1024 * 1024, 'Unexpectedly large test PDF');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), pages);
  };
  try {
    if (localAssets) {
      await context.route(`${SITE_URL}/**`, async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({
          url: `${base}${url.pathname}${url.search}`,
        });
        await route.fulfill({
          response,
          headers: {
            ...response.headers(),
            'access-control-allow-origin': '*',
            'cross-origin-resource-policy': 'cross-origin',
          },
        });
      });
    }
    if (expectedCommit) {
      let identity;
      try {
        const response = await context.request.get(
          `${base}/build-info.json?verify=${expectedCommit}`,
          { timeout: 30000 }
        );
        if (!response.ok()) throw new Error('Build identity unavailable');
        identity = await response.json();
      } catch {
        throw new SmokeAccessError(
          'Cannot confirm the deployment build identity'
        );
      }
      if (identity.commit !== expectedCommit)
        throw new SmokeAccessError('Expected build is not yet visible');
      pass('deployment identity matches the exact candidate commit');
    }
    await visit('/');
    assert.ok((await page.title()).includes('十三月'));
    assert.equal(
      await page
        .locator('a[href="https://github.com/bigzhihui/bentopdf"]')
        .count(),
      1
    );
    assert.equal(await page.locator('a[href="word-to-pdf.html"]').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1
      )
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    pass('Chinese homepage, source link, disabled tool and mobile layout');
    if (artifactDir) {
      mkdirSync(artifactDir, { recursive: true });
      await page.screenshot({ path: resolve(artifactDir, 'homepage.png') });
    }
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let index = 1; index <= 2; index++)
      document
        .addPage([595, 842])
        .drawText(`Synthetic maintenance PDF ${index}`, {
          x: 50,
          y: 770,
          size: 18,
          font,
        });
    const first = Buffer.from(await document.save());
    document.setTitle('Second synthetic document');
    const second = Buffer.from(await document.save());
    await visit('/add-stamps.html');
    await page.locator('#pdfFile').setInputFiles({
      name: 'maintenance-a.pdf',
      mimeType: 'application/pdf',
      buffer: first,
    });
    await page.waitForFunction(
      () =>
        document.querySelector('#stamp-viewer-container iframe')?.contentWindow
          ?.PDFViewerApplication?.pdfDocument?.numPages === 2,
      null,
      { timeout: 90000 }
    );
    pass('same-origin blob PDF renders two pages in the real viewer');
    const [stamped] = await Promise.all([
      page.waitForEvent('download', { timeout: 90000 }),
      page.locator('#save-stamped-btn').click(),
    ]);
    await downloadedPdf(stamped, 2);
    pass('viewer export downloads a valid two-page PDF');

    const blocked = await context.newPage();
    let outside = 0;
    const messages = [];
    blocked.on('request', (request) => {
      if (request.url().startsWith('https://example.invalid/')) outside++;
    });
    blocked.on('console', (message) => messages.push(message.text()));
    blocked.on('pageerror', (error) => messages.push(error.message));
    const blockedResponse = await blocked.goto(
      `${base}/pdfjs-annotation-viewer/web/viewer.html?file=${encodeURIComponent('https://example.invalid/blocked.pdf')}`,
      { waitUntil: 'domcontentloaded', timeout: 45000 }
    );
    if (!blockedResponse || blockedResponse.status() >= 400)
      throw new SmokeAccessError('Origin test page unavailable');
    for (
      let attempt = 0;
      attempt < 100 &&
      !messages.some((text) =>
        text.includes("file origin does not match viewer's")
      );
      attempt++
    )
      await blocked.waitForTimeout(100);
    assert.equal(
      outside,
      0,
      'Viewer must reject the file before a cross-origin request'
    );
    assert.ok(
      messages.some((text) =>
        text.includes("file origin does not match viewer's")
      ),
      'Expected origin rejection'
    );
    await blocked.close();
    pass('cross-origin PDF is rejected before any external file request');

    await visit('/merge-pdf.html');
    await page.locator('#file-input').setInputFiles([
      { name: 'maintenance-a.pdf', mimeType: 'application/pdf', buffer: first },
      {
        name: 'maintenance-b.pdf',
        mimeType: 'application/pdf',
        buffer: second,
      },
    ]);
    await page.waitForFunction(
      () => document.querySelectorAll('#file-list > li').length === 2
    );
    const [merged] = await Promise.all([
      page.waitForEvent('download', { timeout: 90000 }),
      page.locator('#process-btn').click(),
    ]);
    await downloadedPdf(merged, 4);
    pass('two synthetic PDFs merge and download as a four-page PDF');
    assert.deepEqual(errors, [], 'Unexpected browser errors');
    pass('no unexpected browser page errors');
    return { status: 'success', base, commit: expectedCommit ?? null, checks };
  } catch (error) {
    if (artifactDir) {
      mkdirSync(artifactDir, { recursive: true });
      await page
        .screenshot({ path: resolve(artifactDir, 'failure.png') })
        .catch(() => {});
    }
    error.smokeKind =
      error instanceof SmokeAccessError ? 'access' : 'functional';
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let server;
  let report;
  try {
    const external = process.env.PDF_SMOKE_BASE_URL;
    if (!external) server = await serveDistribution(resolve('dist'));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        report = await runPdfSmoke({
          baseUrl: external || server.url,
          expectedCommit: process.env.PDF_SMOKE_EXPECTED_COMMIT,
          artifactDir: process.env.PDF_SMOKE_ARTIFACT_DIR,
          executablePath: process.env.PDF_SMOKE_CHROME,
          localAssets: !external,
        });
        break;
      } catch (error) {
        console.error(`Attempt ${attempt + 1}: ${error.message}`);
        report = {
          status: 'failure',
          errorKind: error.smokeKind ?? 'access',
          message: error.message,
        };
        if (attempt === 0) await setTimeout(10000);
      }
    }
    if (report.status !== 'success') process.exitCode = 1;
  } catch (error) {
    report = { status: 'failure', errorKind: 'access', message: error.message };
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (server) await server.close();
  }
  const directory = process.env.PDF_SMOKE_ARTIFACT_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      resolve(directory, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`
    );
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `error_kind=${report.errorKind ?? ''}\n`
    );
}
