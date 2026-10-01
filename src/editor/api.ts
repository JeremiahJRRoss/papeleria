/**
 * M2.1, M2.2: the editor's side of the API (IC06).
 *
 * Every request carries the session token in `X-Papeleria-Token`; the token
 * lives in this module's closure only, never in an address, storage, a
 * cookie or a message. The page gets it once, by redeeming the launch token
 * from its address or its tab's resume token (`redeemLaunchToken`, D192,
 * D195). The event stream is read with
 * `fetch` for the same reason. A failure to reach the server at all is a
 * `ConnectionError`, which the editor shows as "Papeleria stopped"; a reply
 * with an error status is an `ApiError` carrying the reply's code and fields.
 */
import {SseParser, type ServerEvent} from './sse.js';

/** The server answered with an error status. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Readonly<Record<string, unknown>>;

  constructor(status: number, body: Readonly<Record<string, unknown>>) {
    super(typeof body['message'] === 'string' ? body['message'] : `The server answered ${status}.`);
    this.name = 'ApiError';
    this.status = status;
    this.code = typeof body['errorCode'] === 'string' ? body['errorCode'] : `HTTP_${status}`;
    this.body = body;
  }
}

/** The server could not be reached, or the connection broke. */
export class ConnectionError extends Error {
  constructor(message = 'The connection to Papeleria was lost.') {
    super(message);
    this.name = 'ConnectionError';
  }
}

export type EventSubscription = {close(): void};

export type Api = {
  get<T>(path: string): Promise<T>;
  send<T>(method: 'PUT' | 'POST', path: string, body: unknown): Promise<T>;
  /** Opens the event stream; `onEvent` for each event, `onEnd` once when the stream ends for any reason but `close()`. */
  events(onEvent: (event: ServerEvent) => void, onEnd: () => void): EventSubscription;
};

async function reply<T>(response: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new ApiError(response.status, typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {});
  }
  return body as T;
}

/** What a redemption gives the page: the session token, kept in memory, and its tab's next resume token (D192, D195). */
export type SessionKeys = {readonly token: string; readonly resumeToken: string};

/**
 * Redeems a launch token from the page's address, or the resume token its tab
 * kept, for the session token and the next resume token (D192, D195): once,
 * with the editor's own Origin, which the browser sends on a POST, and no
 * credentials, cache or redirect.
 */
export async function redeemLaunchToken(launchToken: string): Promise<SessionKeys> {
  let response: Response;
  try {
    response = await fetch('/api/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({launchToken}),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
  } catch {
    throw new ConnectionError();
  }
  const {token, resumeToken} = await reply<{token?: unknown; resumeToken?: unknown}>(response);
  const key = /^[0-9a-f]{64}$/;
  if (typeof token !== 'string' || !key.test(token) || typeof resumeToken !== 'string' || !key.test(resumeToken)) {
    throw new ApiError(response.status, {message: 'Papeleria answered without a session key.'});
  }
  return {token, resumeToken};
}

export function createApi(token: string): Api {
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({'X-Papeleria-Token': token, ...extra});
  const request = async <T>(path: string, init: RequestInit): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(path, {...init, cache: 'no-store', credentials: 'omit', redirect: 'error'});
    } catch {
      throw new ConnectionError();
    }
    return reply<T>(response);
  };
  return {
    get: <T>(path: string) => request<T>(path, {headers: headers()}),
    send: <T>(method: 'PUT' | 'POST', path: string, body: unknown) =>
      request<T>(path, {method, headers: headers({'Content-Type': 'application/json'}), body: JSON.stringify(body)}),
    events(onEvent, onEnd) {
      const controller = new AbortController();
      let closed = false;
      const end = (): void => {
        if (!closed) {
          closed = true;
          onEnd();
        }
      };
      void (async () => {
        try {
          // `redirect: 'error'`, as every other request: the token header follows no redirect, same-origin or not.
          const response = await fetch('/api/events', {headers: headers(), cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal});
          if (!response.ok || response.body === null) {
            end();
            return;
          }
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          const parser = new SseParser();
          for (;;) {
            const {value, done} = await reader.read();
            if (done) {
              break;
            }
            for (const event of parser.push(value)) {
              if (!closed) {
                onEvent(event);
              }
            }
          }
        } catch {
          // An aborted or broken stream ends the same way.
        }
        end();
      })();
      return {
        close(): void {
          closed = true;
          controller.abort();
        },
      };
    },
  };
}
