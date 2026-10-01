/**
 * M2.1: reading server-sent events from a fetch stream (IC06, D80).
 *
 * The editor reads its event stream with `fetch`, so the session token goes
 * in a header and never in an address, which `EventSource` would need. This
 * is the text/event-stream format's parser, fed the decoded text as it
 * arrives: lines end at CR, LF or CRLF; a blank line ends an event; `data`
 * lines join with a line break; a line starting with a colon is a comment.
 * Pure, and tested in Node.
 */

export type ServerEvent = {readonly id: string | null; readonly event: string; readonly data: string};

export class SseParser {
  #buffer = '';
  #event = '';
  #data: string[] = [];
  #id: string | null = null;
  #sawField = false;

  /** Parses a chunk of text and returns the events it completed. */
  push(chunk: string): ServerEvent[] {
    this.#buffer += chunk;
    const events: ServerEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.#buffer);
      if (match === null) {
        break;
      }
      // A lone CR at the very end may be half of a CRLF still to come.
      if (match[0] === '\r' && match.index === this.#buffer.length - 1) {
        break;
      }
      const line = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      const event = this.#line(line);
      if (event !== null) {
        events.push(event);
      }
    }
    return events;
  }

  #line(line: string): ServerEvent | null {
    if (line === '') {
      if (!this.#sawField) {
        return null;
      }
      const event: ServerEvent = {id: this.#id, event: this.#event === '' ? 'message' : this.#event, data: this.#data.join('\n')};
      this.#event = '';
      this.#data = [];
      this.#sawField = false;
      return event;
    }
    if (line.startsWith(':')) {
      return null;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    switch (field) {
      case 'event':
        this.#event = value;
        this.#sawField = true;
        break;
      case 'data':
        this.#data.push(value);
        this.#sawField = true;
        break;
      case 'id':
        if (!value.includes('\u0000')) {
          this.#id = value;
        }
        this.#sawField = true;
        break;
      default:
        // `retry` and unknown fields mean nothing to a fetch reader.
        break;
    }
    return null;
  }
}
