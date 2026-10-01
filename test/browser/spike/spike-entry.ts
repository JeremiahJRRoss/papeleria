/**
 * The DEP05 spike's own code (M4.1). page-flip.test.ts bundles it with the
 * adapter by esbuild into a classic IIFE and writes spike.js as the vendored
 * engine's pinned bytes, verbatim, followed by that bundle: one classic
 * script whose engine part is checked by its hash and whose rest passes the
 * published-client scan with no exception (D101). The engine sets the global
 * `St` as it runs; this code takes `St.PageFlip` from there.
 *
 * It wires the spike page's bar to the adapter, follows
 * prefers-reduced-motion live (A14), and exposes `window.papeleriaSpike` so a
 * test can start the book with options of its own. The engine it hands the
 * adapter is a subclass that counts the calls that animate (flipNext,
 * flipPrev and the renderer's startAnimation, which every curl goes through)
 * and those that do not (turnToPage). This is test code: the reader is W4's.
 */
import {
  create,
  type AdapterOptions,
  type AdapterState,
  type EngineAdapter,
  type EngineCorner,
  type EngineRender,
  type EngineSettings,
  type PageFlipConstructor,
  type PageFlipEngine,
} from '../../../templates/comic/client/engine-adapter.js';

export type EngineCalls = {flipNext: number; flipPrev: number; startAnimation: number; turnToPage: number};

export type Spike = {
  readonly PageFlip: PageFlipConstructor;
  /** The counting subclass `start` uses unless told otherwise. */
  readonly CountingPageFlip: PageFlipConstructor;
  adapter: EngineAdapter | null;
  /** The engine the last `start` made. */
  engine: PageFlipEngine | null;
  readonly calls: EngineCalls;
  readonly changes: AdapterState[];
  readonly panelClicks: string[];
  start(options?: Partial<AdapterOptions>): EngineAdapter;
  resetCalls(): void;
  engineState(): string | null;
};

declare global {
  interface Window {
    papeleriaSpike?: Spike;
    /** Set by the vendored engine, which runs first in the same script. */
    St?: {readonly PageFlip: PageFlipConstructor};
  }
}

type AnimatingRender = EngineRender & {startAnimation(...args: unknown[]): void};

const PageFlip = window.St?.PageFlip;
if (PageFlip === undefined) {
  throw new Error('the vendored engine did not run ahead of the spike');
}
const stage = document.getElementById('stage');
const status = document.getElementById('status');
const previous = document.getElementById('previous');
const next = document.getElementById('next');
if (stage === null || status === null || previous === null || next === null) {
  throw new Error('the spike page is missing its stage or its bar');
}
const pages = Array.from(stage.querySelectorAll<HTMLElement>('.spike-page'));
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
document.documentElement.classList.add('js');

const calls: EngineCalls = {flipNext: 0, flipPrev: 0, startAnimation: 0, turnToPage: 0};

class CountingPageFlip extends PageFlip {
  constructor(block: HTMLElement, settings: Partial<EngineSettings>) {
    super(block, settings);
    spike.engine = this;
  }

  override loadFromHTML(items: HTMLElement[]): void {
    super.loadFromHTML(items);
    const render = this.getRender() as AnimatingRender;
    const startAnimation = render.startAnimation.bind(render);
    render.startAnimation = (...args: unknown[]): void => {
      calls.startAnimation += 1;
      startAnimation(...args);
    };
  }

  override flipNext(corner?: EngineCorner): void {
    calls.flipNext += 1;
    super.flipNext(corner);
  }

  override flipPrev(corner?: EngineCorner): void {
    calls.flipPrev += 1;
    super.flipPrev(corner);
  }

  override turnToPage(index: number): void {
    calls.turnToPage += 1;
    super.turnToPage(index);
  }
}

function describePosition(adapter: EngineAdapter): string {
  const [first, second] = adapter.visible;
  return second === undefined ? `Page ${first} of ${adapter.total}` : `Pages ${first}–${second} of ${adapter.total}`;
}

const spike: Spike = {
  PageFlip,
  CountingPageFlip,
  adapter: null,
  engine: null,
  calls,
  changes: [],
  panelClicks: [],
  start(options: Partial<AdapterOptions> = {}): EngineAdapter {
    spike.adapter?.destroy();
    spike.changes.length = 0;
    const adapter = create(stage, pages, {
      engine: CountingPageFlip,
      pageWidth: 1600,
      pageHeight: 2200,
      instant: motion.matches,
      ...options,
      onChange: (state) => {
        spike.changes.push(state);
        status.textContent = describePosition(adapter);
        options.onChange?.(state);
      },
    });
    spike.adapter = adapter;
    status.textContent = describePosition(adapter);
    return adapter;
  },
  resetCalls(): void {
    calls.flipNext = 0;
    calls.flipPrev = 0;
    calls.startAnimation = 0;
    calls.turnToPage = 0;
  },
  engineState(): string | null {
    return spike.engine?.getState() ?? null;
  },
};
window.papeleriaSpike = spike;

stage.addEventListener('click', (event) => {
  const panel = event.target instanceof Element ? event.target.closest<HTMLElement>('.spike-panel') : null;
  if (panel !== null) {
    spike.panelClicks.push(panel.dataset['panel'] ?? '');
  }
});
previous.addEventListener('click', () => spike.adapter?.previous());
next.addEventListener('click', () => spike.adapter?.next());
motion.addEventListener('change', (event) => spike.adapter?.setInstant(event.matches));

if (!new URLSearchParams(window.location.search).has('manual')) {
  spike.start();
}
