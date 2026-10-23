import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// Exercise the shipped viewer helper without starting the full PDF application.
const source = readFileSync('public/pdfjs-viewer/viewer.mjs', 'utf8');
const start = source.indexOf('function toggleExpandedBtn(');
const end = source.indexOf('\nconst calcRound', start);
if (start < 0 || end < 0) throw new Error('Viewer toolbar helper not found');
const toggle = runInNewContext(
  `${source.slice(start, end)}; toggleExpandedBtn`
) as (button: HTMLButtonElement, active: boolean, panel: HTMLElement) => void;

describe('PDF viewer toolbar state', () => {
  it('reports selected editor modes as checked and keeps their panel in sync', () => {
    const button = document.createElement('button');
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    const panel = document.createElement('div');
    panel.classList.add('hidden');

    toggle(button, true, panel);
    expect(button.getAttribute('aria-checked')).toBe('true');
    expect(button.hasAttribute('aria-expanded')).toBe(false);
    expect(button.classList.contains('toggled')).toBe(true);
    expect(panel.classList.contains('hidden')).toBe(false);

    toggle(button, false, panel);
    expect(button.getAttribute('aria-checked')).toBe('false');
    expect(button.classList.contains('toggled')).toBe(false);
    expect(panel.classList.contains('hidden')).toBe(true);
  });

  it('preserves expanded state for ordinary disclosure buttons', () => {
    const button = document.createElement('button');
    const panel = document.createElement('div');

    toggle(button, true, panel);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.hasAttribute('aria-checked')).toBe(false);
    expect(panel.classList.contains('hidden')).toBe(false);

    toggle(button, false, panel);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(panel.classList.contains('hidden')).toBe(true);
  });
});
