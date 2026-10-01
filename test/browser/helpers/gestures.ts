/**
 * Touch gestures for Playwright suites.
 *
 * `dispatchSwipe` follows Playwright's documented way to emulate touch in all
 * three engines: it dispatches touchstart, touchmove and touchend on one
 * element, as a real finger's events all target the element it first touched.
 * The browser context needs `hasTouch: true`; without it Firefox has no
 * TouchEvent at all.
 *
 * `trustedSwipe` drives Chromium's own touch input through the DevTools
 * protocol instead, so the page receives trusted events that went through the
 * browser's gesture handling. It is Chromium-only.
 */
import type {Page} from 'playwright';

export type Point = {readonly x: number; readonly y: number};
export type Delta = {readonly dx: number; readonly dy: number};
export type SwipeOptions = {
  /** touchmove events between start and end. Default 6. */
  readonly steps?: number;
  /** Fingers down together, 24 px apart. Default 1. */
  readonly fingers?: number;
};

type TouchInit = {identifier: number; clientX: number; clientY: number};

export async function dispatchSwipe(
  page: Page,
  selector: string,
  start: Point,
  delta: Delta,
  options: SwipeOptions = {},
): Promise<void> {
  const steps = options.steps ?? 6;
  const fingers = options.fingers ?? 1;
  const target = page.locator(selector).first();
  const at = (x: number, y: number): TouchInit[] =>
    Array.from({length: fingers}, (_, finger) => ({identifier: finger, clientX: x + finger * 24, clientY: y}));

  const down = at(start.x, start.y);
  await target.dispatchEvent('touchstart', {touches: down, changedTouches: down, targetTouches: down});
  for (let step = 1; step <= steps; step += 1) {
    const moved = at(start.x + (delta.dx * step) / steps, start.y + (delta.dy * step) / steps);
    await target.dispatchEvent('touchmove', {touches: moved, changedTouches: moved, targetTouches: moved});
  }
  const up = at(start.x + delta.dx, start.y + delta.dy);
  await target.dispatchEvent('touchend', {touches: [], changedTouches: up, targetTouches: []});
}

export async function trustedSwipe(page: Page, start: Point, delta: Delta, steps = 6): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: start.x, y: start.y}]});
    for (let step = 1; step <= steps; step += 1) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{x: start.x + (delta.dx * step) / steps, y: start.y + (delta.dy * step) / steps}],
      });
    }
    await session.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  } finally {
    await session.detach();
  }
}
