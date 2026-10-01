/**
 * The local server's public interface (M2.1, M2.6): `startEditor` for
 * `papeleria edit`, `startServe` for `papeleria serve`.
 */
export {startEditor, type EditorOptions, type EditorSession, type LaunchReason, type SessionHooks} from './editor.js';
export {FIRST_LAUNCH_LIFETIME_MS, RESUME_TOKEN_LIMIT} from './session.js';
export {startServe, type ServeHooks, type ServeOptions, type ServeSession} from './serve.js';
export {ServerStartError, validPort, type StartErrorCode} from './common.js';
export {REQUEST_LIMITS, TOKEN_HEADER} from './http.js';
export {revisionOf} from './files.js';
