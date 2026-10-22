// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: { files: [] as File[] },
  getDocument: vi.fn(),
  showAlert: vi.fn(),
}));
vi.mock('../js/state.js', () => ({ state: mocks.state }));
vi.mock('pdfjs-dist', () => ({ getDocument: mocks.getDocument }));
vi.mock('../js/ui.js', () => ({
  showAlert: mocks.showAlert,
  showLoader: vi.fn(),
  hideLoader: vi.fn(),
}));
vi.mock('../js/utils/password-prompt.js', () => ({
  batchDecryptIfNeeded: async (files: File[]) => files,
}));
vi.mock('../js/utils/render-utils.js', () => ({
  renderPagesProgressively: vi.fn(),
  cleanupLazyRendering: vi.fn(),
}));
vi.mock('../js/utils/page-preview.js', () => ({ initPagePreview: vi.fn() }));
vi.mock('../js/utils/cpdf-helper.js', () => ({ isCpdfAvailable: () => true }));
vi.mock('../js/utils/wasm-provider.js', () => ({
  showWasmRequiredDialog: vi.fn(),
  WasmProvider: {},
}));
vi.mock('../js/utils/setup-pdf-worker.js', () => ({}));
vi.mock('lucide', () => ({ createIcons: vi.fn(), icons: {} }));
vi.mock('sortablejs', () => ({
  default: { create: () => ({ destroy: vi.fn() }) },
}));

describe('merge readiness', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal(
      'Worker',
      class {
        postMessage() {}
      }
    );
    document.body.innerHTML = `<div id="merge-options" class="hidden"></div><button id="process-btn">Merge</button><button id="file-mode-btn"></button><button id="page-mode-btn"></button><div id="file-mode-panel"></div><div id="page-mode-panel"></div><ul id="file-list"></ul>`;
    mocks.state.files = [
      {
        name: 'sample.pdf',
        arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
      } as File,
    ];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('disables merge until document loading and the selectable file list are ready', async () => {
    let resolveDocument!: (document: { numPages: number }) => void;
    const pending = new Promise<{ numPages: number }>((resolve) => {
      resolveDocument = resolve;
    });
    mocks.getDocument.mockReturnValue({ promise: pending });
    const { refreshMergeUI } = await import('../js/logic/merge-pdf-page.js');
    const refresh = refreshMergeUI();
    const button = document.querySelector<HTMLButtonElement>('#process-btn')!;
    expect(button.disabled).toBe(true);
    await vi.waitFor(() => expect(mocks.getDocument).toHaveBeenCalled());
    expect(document.querySelector('#file-list')!.children).toHaveLength(0);
    resolveDocument({ numPages: 3 });
    await refresh;
    expect(button.disabled).toBe(false);
    expect(document.querySelector('#file-list')!.children).toHaveLength(1);
    expect(document.querySelector('#file-list')!.textContent).toContain(
      'Total: 3'
    );
  });

  it('leaves merge disabled after unreadable input instead of allowing an empty merge', async () => {
    mocks.getDocument.mockImplementation(() => ({
      promise: Promise.reject(Error('invalid input')),
    }));
    const { refreshMergeUI } = await import('../js/logic/merge-pdf-page.js');
    await refreshMergeUI();
    expect(mocks.showAlert).toHaveBeenCalledWith(
      'Error',
      'Failed to load one or more PDF files'
    );
    expect(
      document.querySelector<HTMLButtonElement>('#process-btn')!.disabled
    ).toBe(true);
  });

  it('does not enable an empty file list', async () => {
    mocks.state.files = [];
    const { refreshMergeUI } = await import('../js/logic/merge-pdf-page.js');
    await refreshMergeUI();
    expect(
      document.querySelector<HTMLButtonElement>('#process-btn')!.disabled
    ).toBe(true);
  });
});
