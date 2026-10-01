/**
 * M2.1: one queue per session for everything that reads or writes the piece
 * (IC05, IC06, D80).
 *
 * Saves, previews, checks and builds run one at a time, in the order they
 * arrived, so a build never reads a file a save is replacing and preview
 * generations are kept in order. Previews are the exception to first come,
 * first served: only the latest is worth building. A new preview replaces a
 * preview still waiting, which is answered as superseded, and aborts a
 * preview already running, which stops at the pipeline's next stage and is
 * answered the same way. Nothing else is ever dropped.
 */

/** `scan` looks at the disk after the watcher saw a change, so it never runs in the middle of a save. */
export type JobKind = 'preview' | 'check' | 'build' | 'save' | 'scan';

/** The answer for a preview a newer one replaced. */
export type Superseded = {readonly superseded: true};
export const SUPERSEDED: Superseded = Object.freeze({superseded: true});

/** The queue was closed: the session is stopping. */
export class QueueClosedError extends Error {
  constructor() {
    super('The session is stopping.');
    this.name = 'QueueClosedError';
  }
}

type Job = {
  readonly kind: JobKind;
  readonly controller: AbortController;
  readonly run: (signal: AbortSignal) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
};

export class SessionQueue {
  readonly #pending: Job[] = [];
  #running: Job | null = null;
  #closed = false;
  #drained: (() => void)[] = [];

  /**
   * Runs `run` once every job queued before it has finished. A preview first
   * replaces any preview still waiting and aborts a running one. A job whose
   * signal was aborted resolves as superseded, whatever it threw.
   */
  schedule<T>(kind: JobKind, run: (signal: AbortSignal) => Promise<T>): Promise<T | Superseded> {
    if (this.#closed) {
      return Promise.reject(new QueueClosedError());
    }
    if (kind === 'preview') {
      for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
        const waiting = this.#pending[index]!;
        if (waiting.kind === 'preview') {
          this.#pending.splice(index, 1);
          waiting.controller.abort();
          waiting.resolve(SUPERSEDED);
        }
      }
      if (this.#running?.kind === 'preview') {
        this.#running.controller.abort();
      }
    }
    return new Promise<T | Superseded>((resolve, reject) => {
      this.#pending.push({kind, controller: new AbortController(), run, resolve: resolve as (value: unknown) => void, reject});
      this.#next();
    });
  }

  #next(): void {
    if (this.#running !== null) {
      return;
    }
    const job = this.#pending.shift();
    if (job === undefined) {
      for (const done of this.#drained.splice(0)) {
        done();
      }
      return;
    }
    this.#running = job;
    void (async () => {
      try {
        const value = await job.run(job.controller.signal);
        job.resolve(job.controller.signal.aborted ? SUPERSEDED : value);
      } catch (error) {
        if (job.controller.signal.aborted) {
          job.resolve(SUPERSEDED);
        } else {
          job.reject(error);
        }
      } finally {
        this.#running = null;
        this.#next();
      }
    })();
  }

  /** Resolves once nothing is running or waiting. */
  idle(): Promise<void> {
    if (this.#running === null && this.#pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#drained.push(resolve));
  }

  /** Refuses new jobs, supersedes the waiting ones, aborts a running preview, and resolves once the running job has finished. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const waiting of this.#pending.splice(0)) {
      waiting.controller.abort();
      waiting.reject(new QueueClosedError());
    }
    if (this.#running?.kind === 'preview') {
      this.#running.controller.abort();
    }
    await this.idle();
  }
}
