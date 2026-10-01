/**
 * M2.1: the session token (IC06, D77), and the launch tokens that bring a page
 * to it (security audit F10, D192).
 *
 * One random 256-bit token per editor session, written as 64 hexadecimal
 * digits. It is compared in constant time and never written to a log, a file,
 * a query string, a cookie, storage, a piece or a message, nor put in an
 * address: the launch address carries a launch token instead, which a page
 * redeems once, over `POST /api/session`, for the session token, and keeps
 * that in memory. What the launch address meets on its way (the browser
 * opener's command line, a browser it starts, the history) is then a key that
 * has already been used, not the session's.
 *
 * With the session token each page gets a resume token, one-time too, which
 * it keeps in its tab's session storage, so that a reload reopens the editor
 * by itself (D195): the reloaded page redeems it the same way and gets the
 * next. The session token itself is never stored.
 */
import {Buffer} from 'node:buffer';
import {randomBytes, timingSafeEqual} from 'node:crypto';

/** A fresh session or launch token: 32 random bytes as lower-case hexadecimal. */
export function createToken(): string {
  return randomBytes(32).toString('hex');
}

/** Whether `supplied` is the token, compared in constant time for tokens of the right length. */
export function tokenMatches(token: string, supplied: string): boolean {
  const expected = Buffer.from(token, 'utf8');
  const actual = Buffer.from(supplied, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A launch address: the editor origin with a launch token in the fragment, which a browser never sends to a server. */
export function launchUrl(origin: string, launchToken: string): string {
  return `${origin}/#token=${launchToken}`;
}

/**
 * How long the first launch token works: long enough for a browser to start
 * and open the page, short enough that one left unused in a browser's command
 * line, or in the process list another user can read, soon opens nothing.
 */
export const FIRST_LAUNCH_LIFETIME_MS = 2 * 60_000;

/**
 * The most resume tokens a session keeps, one for each tab that opened the
 * editor and has not reloaded since; beyond it the oldest stops working, and
 * that tab asks for an address when it reloads (D195).
 */
export const RESUME_TOKEN_LIMIT = 32;

/** Why the terminal shows a launch address after the first: the one before it opened the editor, or came after its time. */
export type LaunchReason = 'redeemed' | 'expired';

/**
 * What presenting a token did: a launch token opened the session once or came
 * too late, a tab's resume token reopened it (D195), or the token was none of
 * the current ones. An opening gives the page its next resume token.
 */
export type Redemption =
  | {readonly outcome: 'redeemed'; readonly resumeToken: string}
  | {readonly outcome: 'resumed'; readonly resumeToken: string}
  | {readonly outcome: 'expired'}
  | {readonly outcome: 'refused'};

/**
 * The launch tokens of one session (D192). One is current at a time. The
 * current one redeemed, or presented after its time, is replaced by a fresh
 * one, which `announce` shows in the terminal; any other token changes
 * nothing. Only the first, the one handed to the browser opener, has a
 * lifetime: the ones after it are shown in the terminal alone.
 *
 * Each opening also gives out a resume token, which the page keeps for its
 * tab and presents when it reloads (D195). A resume token works once, like a
 * launch token, and gives the next; it is shown nowhere, so presenting one
 * announces nothing.
 */
export class LaunchTokens {
  #current = createToken();
  #expiresAt: number | null;
  /** The resume tokens given out and not yet presented, oldest first. */
  readonly #resumes: string[] = [];
  readonly #announce: (launchToken: string, reason: LaunchReason) => void;
  readonly #now: () => number;

  constructor(announce: (launchToken: string, reason: LaunchReason) => void, now: () => number = Date.now) {
    this.#announce = announce;
    this.#now = now;
    this.#expiresAt = now() + FIRST_LAUNCH_LIFETIME_MS;
  }

  /** The launch token a new page may redeem. */
  get current(): string {
    return this.#current;
  }

  redeem(supplied: string): Redemption {
    if (tokenMatches(this.#current, supplied)) {
      const expired = this.#expiresAt !== null && this.#now() > this.#expiresAt;
      this.#current = createToken();
      this.#expiresAt = null;
      this.#announce(this.#current, expired ? 'expired' : 'redeemed');
      return expired ? {outcome: 'expired'} : {outcome: 'redeemed', resumeToken: this.#resume()};
    }
    const index = this.#resumes.findIndex((resumeToken) => tokenMatches(resumeToken, supplied));
    if (index === -1) {
      return {outcome: 'refused'};
    }
    this.#resumes.splice(index, 1);
    return {outcome: 'resumed', resumeToken: this.#resume()};
  }

  /** A fresh resume token; the oldest outstanding one stops working when there would be more than the limit. */
  #resume(): string {
    const resumeToken = createToken();
    this.#resumes.push(resumeToken);
    if (this.#resumes.length > RESUME_TOKEN_LIMIT) {
      this.#resumes.shift();
    }
    return resumeToken;
  }
}
