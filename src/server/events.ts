/**
 * M2.1: server-sent events (IC06, D80).
 *
 * One stream per connected page. Every event has an id that increases for the
 * whole session, so a page can tell what it has seen. The editor reads its
 * stream with `fetch`, which lets it send the session token in a header; the
 * token never goes into an address. `serve`'s read-only shell reads its
 * stream with `EventSource` and no token: that stream carries only reloads.
 * A comment line every 15 seconds keeps idle connections from being closed
 * by anything between the page and the server.
 */
import type {ServerResponse} from 'node:http';

import {baseHeaders} from './http.js';

const KEEP_ALIVE_MS = 15_000;

export class EventHub {
  readonly #clients = new Set<ServerResponse>();
  #lastId = 0;
  #timer: NodeJS.Timeout | null = null;

  /** The id of the last event sent, 0 before the first. */
  get lastId(): number {
    return this.#lastId;
  }

  /** How many streams are open. */
  get size(): number {
    return this.#clients.size;
  }

  /**
   * Opens a stream on `response` and greets it with a `hello` event carrying
   * the last id sent so far and whatever else `greeting` holds.
   */
  attach(response: ServerResponse, greeting: Readonly<Record<string, unknown>> = {}): void {
    response.writeHead(200, {
      ...baseHeaders(),
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write(`: papeleria\n\n`);
    this.#clients.add(response);
    response.on('close', () => {
      this.#clients.delete(response);
      this.#stopTimerWhenIdle();
    });
    this.#write(response, this.#lastId, 'hello', {...greeting, lastEventId: this.#lastId});
    this.#timer ??= setInterval(() => {
      for (const client of this.#clients) {
        client.write(': keep-alive\n\n');
      }
    }, KEEP_ALIVE_MS);
    this.#timer.unref();
  }

  /** Sends an event to every open stream and returns its id. */
  send(event: string, data: unknown): number {
    this.#lastId += 1;
    for (const client of this.#clients) {
      this.#write(client, this.#lastId, event, data);
    }
    return this.#lastId;
  }

  /** Ends every open stream: a page then sees its connection close. */
  closeAll(): void {
    for (const client of [...this.#clients]) {
      client.end();
    }
    this.#clients.clear();
    this.#stopTimerWhenIdle();
  }

  #write(client: ServerResponse, id: number, event: string, data: unknown): void {
    // JSON.stringify escapes line breaks, so the data is one line.
    client.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  #stopTimerWhenIdle(): void {
    if (this.#clients.size === 0 && this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
