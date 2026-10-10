/**
 * Service Worker Registration
 * Registers the service worker to enable offline caching
 *
 * Note: Service Worker is disabled in development mode to prevent
 * conflicts with Vite's HMR (Hot Module Replacement)
 */

import i18next from 'i18next';
import { t } from './i18n/index.js';

declare const __BRAND_NAME__: string;

// Skip service worker registration in development mode
const isDevelopment =
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.port !== '';

function collectTrustedWasmHosts(): string[] {
  const hosts = new Set<string>();
  const candidates = [
    import.meta.env.VITE_WASM_PYMUPDF_URL,
    import.meta.env.VITE_WASM_GS_URL,
    import.meta.env.VITE_WASM_CPDF_URL,
    import.meta.env.VITE_TESSERACT_WORKER_URL,
    import.meta.env.VITE_TESSERACT_CORE_URL,
    import.meta.env.VITE_TESSERACT_LANG_URL,
    import.meta.env.VITE_OCR_FONT_BASE_URL,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).origin);
    } catch {
      console.warn(
        `[SW] Ignoring malformed VITE_* URL for SW trusted-hosts: ${raw}`
      );
    }
  }
  return Array.from(hosts);
}

// The update prompt is translated, and on a slow network the page can still be
// loading its translations when the worker finds an update.
function whenTranslated(): Promise<void> {
  if (i18next.isInitialized) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    i18next.on('initialized', () => resolve());
  });
}

function sendTrustedHostsToSw(target: ServiceWorker | null | undefined) {
  if (!target) return;
  const hosts = collectTrustedWasmHosts();
  if (hosts.length === 0) return;
  target.postMessage({ type: 'SET_TRUSTED_CDN_HOSTS', hosts });
}

if (isDevelopment) {
  console.log('[Dev Mode] Service Worker registration skipped in development');
  console.log('Service Worker will be active in production builds');
} else if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const swPath = `${import.meta.env.BASE_URL}sw.js`;
    console.log('[SW] Registering Service Worker at:', swPath);
    navigator.serviceWorker
      .register(swPath)
      .then((registration) => {
        console.log(
          '[SW] Service Worker registered successfully:',
          registration.scope
        );

        sendTrustedHostsToSw(
          registration.active || registration.waiting || registration.installing
        );

        setInterval(
          () => {
            registration.update();
          },
          24 * 60 * 60 * 1000
        );

        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'activated') {
                sendTrustedHostsToSw(newWorker);
              }
              if (
                newWorker.state === 'installed' &&
                navigator.serviceWorker.controller
              ) {
                console.log('[SW] New version available! Reload to update.');

                whenTranslated().then(() => {
                  const brand = __BRAND_NAME__ || 'BentoPDF';
                  if (confirm(t('serviceWorker.updateAvailable', { brand }))) {
                    newWorker.postMessage({ type: 'SKIP_WAITING' });
                    window.location.reload();
                  }
                });
              }
            });
          }
        });
      })
      .catch((error) => {
        console.error('[SW] Service Worker registration failed:', error);
      });

    navigator.serviceWorker.ready.then((registration) => {
      sendTrustedHostsToSw(registration.active);
    });

    // The page does not reload when a new worker takes control. On a first
    // visit that worker takes over a page already running the current code,
    // and after an update the visitor chose above whether to reload. The
    // worker skips waiting, so it takes control either way.
  });
}
