/**
 * M4.4: what a comic does in the editor's preview and nowhere else (D117).
 *
 * `scripts/bundle-clients.mjs` bundles this file into `reader-preview.js`,
 * after the reader and the preview bridge; `reader.js`, the published script,
 * never holds it, and nothing here is in a stylesheet a piece publishes. It
 * waits for the bridge's events, so a preview opened on its own (Open in a
 * new tab) behaves as the published page.
 *
 * - Grid (UX §08, D3): `papeleria-preview-grid` with `{on}` lays a 10% grid,
 *   labelled in percent, over every page's art and over guided view's lens,
 *   drawn with elements styled through the CSSOM, which the preview's policy
 *   allows (IC06). The lens's grid follows the art it covers.
 * - Pointer: while the grid is on, where the pointer is over a page image, in
 *   percent of that image, clamped to 0–100, goes to the bridge as a
 *   `papeleria-preview-pointer` event `{page, x, y}`, at most once a frame;
 *   the bridge sends it to the editor as `pointer` (IC06). When the pointer
 *   then leaves the page images, or the frame, `papeleria-preview-pointer-left`
 *   goes once, which the bridge sends as `pointerLeft` (D174): the editor's
 *   readout no longer keeps a place the pointer has left (W5R-20).
 * - goto: a page or panel target shows its page through
 *   `papeleriaReader.goTo`, which takes no focus, in page view; a panel
 *   target also marks its panel with the outline a hover draws, until the
 *   next target. The bridge's default, scrolling to the element the fragment
 *   names, would scroll to the transcript under the book.
 *
 * Own code, Apache-2.0.
 */
import type {Target} from '../../shared/preview-protocol.js';
import type {PapeleriaReader} from './reader-logic.js';

/** The grid's lines and labels: ink with a paper halo, so they read on any art. */
const INK = 'rgba(29, 29, 26, 0.72)';
const PAPER = 'rgba(252, 252, 250, 0.9)';
const STEPS = [10, 20, 30, 40, 50, 60, 70, 80, 90] as const;

/** Marks an element as the preview's, so the reader's own lookups and the tests can tell it apart. */
const OWN = 'data-papeleria-preview';

function reader(): PapeleriaReader | undefined {
  return (window as unknown as {papeleriaReader?: PapeleriaReader}).papeleriaReader;
}

function styled<K extends keyof HTMLElementTagNameMap>(tag: K, declarations: Readonly<Record<string, string>>): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  for (const [property, value] of Object.entries(declarations)) {
    made.style.setProperty(property, value);
  }
  return made;
}

/** A 10% grid with its labels, covering its positioned parent. */
function makeGrid(): HTMLElement {
  const grid = styled('div', {position: 'absolute', inset: '0', 'pointer-events': 'none', 'z-index': '20', overflow: 'hidden'});
  grid.setAttribute(OWN, 'grid');
  grid.setAttribute('aria-hidden', 'true');
  for (const step of STEPS) {
    const line = {position: 'absolute', 'box-shadow': `0 0 0 1px ${PAPER}`, background: INK};
    grid.append(
      styled('div', {...line, left: `${step}%`, top: '0', bottom: '0', width: '1px'}),
      styled('div', {...line, top: `${step}%`, left: '0', right: '0', height: '1px'}),
    );
    const label = {position: 'absolute', font: '600 10px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace', color: 'rgb(29, 29, 26)', background: PAPER, padding: '0 2px'};
    const top = styled('span', {...label, left: `${step}%`, top: '2px', transform: 'translateX(-50%)'});
    top.textContent = String(step);
    const left = styled('span', {...label, top: `${step}%`, left: '2px', transform: 'translateY(-50%)'});
    left.textContent = String(step);
    grid.append(top, left);
  }
  return grid;
}

function start(): void {
  let on = false;
  const grids: HTMLElement[] = [];
  let lensGrid: HTMLElement | null = null;
  let lensWatch: MutationObserver | null = null;
  let marked: HTMLElement | null = null;

  /** Keeps the lens's grid over the lens's art, whose size and offset the reader sets inline. */
  const followLens = (): void => {
    const art = document.querySelector<HTMLElement>('.comic-lens-art');
    if (lensGrid === null || art === null) {
      return;
    }
    lensGrid.style.setProperty('inset', 'auto');
    lensGrid.style.setProperty('left', '0');
    lensGrid.style.setProperty('top', '0');
    lensGrid.style.setProperty('width', art.style.width);
    lensGrid.style.setProperty('height', art.style.height);
    lensGrid.style.setProperty('transform', art.style.transform);
    lensGrid.style.setProperty('transform-origin', '0 0');
    lensGrid.style.setProperty('overflow', 'visible');
  };

  const show = (): void => {
    for (const art of Array.from(document.querySelectorAll<HTMLElement>('.comic-art'))) {
      const grid = makeGrid();
      art.appendChild(grid);
      grids.push(grid);
    }
    const lens = document.getElementById('comic-lens');
    const art = document.querySelector<HTMLElement>('.comic-lens-art');
    if (lens !== null && art !== null) {
      lensGrid = makeGrid();
      lens.insertBefore(lensGrid, art.nextSibling);
      followLens();
      lensWatch = new MutationObserver(followLens);
      lensWatch.observe(art, {attributes: true, attributeFilter: ['style']});
    }
  };

  const hide = (): void => {
    for (const grid of grids.splice(0)) {
      grid.remove();
    }
    lensWatch?.disconnect();
    lensWatch = null;
    lensGrid?.remove();
    lensGrid = null;
  };

  document.addEventListener('papeleria-preview-grid', (event: Event) => {
    const wanted = (event as CustomEvent<{on?: unknown}>).detail?.on === true;
    if (wanted === on) {
      return;
    }
    on = wanted;
    if (on) {
      show();
    } else {
      hide();
    }
  });

  // The pointer over a page image, in percent of it: the page's art in page view, the lens's art in guided view.
  let pending: {page: number; x: number; y: number} | null = null;
  // Whether the editor may show a place the pointer has left, which it is told once (D174). A new generation starts as
  // if it had told one: the readout may still show the place the generation before it reported.
  let placed = true;
  const percent = (value: number): number => Math.min(100, Math.max(0, Math.round(value * 10) / 10));
  const left = (): void => {
    pending = null;
    if (placed) {
      placed = false;
      document.dispatchEvent(new CustomEvent('papeleria-preview-pointer-left'));
    }
  };
  document.addEventListener(
    'pointermove',
    (event: PointerEvent) => {
      if (!on) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      let art: Element | null = null;
      let page: number | null = null;
      const inArt = target?.closest<HTMLElement>('.comic-art') ?? null;
      if (inArt !== null) {
        art = inArt;
        page = Number(inArt.closest<HTMLElement>('figure.comic-figure')?.dataset['page']);
      } else if (target?.closest('#comic-lens') !== null && target !== null) {
        art = document.querySelector('.comic-lens-art');
        page = reader()?.page ?? null;
      }
      if (art === null || page === null || !(page >= 1)) {
        left();
        return;
      }
      const rect = art.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) {
        left();
        return;
      }
      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      if (x < 0 || x > 100 || y < 0 || y > 100) {
        left();
        return;
      }
      const queued = pending === null;
      pending = {page, x: percent(x), y: percent(y)};
      if (queued) {
        requestAnimationFrame(() => {
          const point = pending;
          pending = null;
          if (point !== null) {
            placed = true;
            document.dispatchEvent(new CustomEvent('papeleria-preview-pointer', {detail: point}));
          }
        });
      }
    },
    {passive: true},
  );
  // Out of the frame: no move inside it says so, only the boundary event that names nothing it enters, the long-standing
  // sign in every engine that the mouse has left the page.
  document.addEventListener(
    'mouseout',
    (event: MouseEvent) => {
      if (on && event.relatedTarget === null) {
        left();
      }
    },
    {passive: true},
  );

  // A page or panel the editor's cursor is on: its page, and the panel marked.
  document.addEventListener('papeleria-preview-goto', (event: Event) => {
    const target = (event as CustomEvent<Target>).detail;
    const current = reader();
    if (current === undefined || (target.kind !== 'page' && target.kind !== 'panel')) {
      return;
    }
    event.preventDefault();
    current.goTo(target.page);
    if (marked !== null) {
      for (const property of ['outline', 'outline-offset', 'box-shadow']) {
        marked.style.removeProperty(property);
      }
      marked.removeAttribute(OWN);
      marked = null;
    }
    if (target.kind === 'panel') {
      const panel = document.getElementById(`page-${target.page}-panel-${target.panel}`);
      if (panel !== null) {
        panel.style.setProperty('outline', `2px solid ${INK}`);
        panel.style.setProperty('outline-offset', '2px');
        panel.style.setProperty('box-shadow', `0 0 0 2px ${PAPER}`);
        panel.setAttribute(OWN, 'marked');
        marked = panel;
      }
    }
  });
}

start();
