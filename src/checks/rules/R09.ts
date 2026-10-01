/**
 * R09: A field is unknown or missing against the schema, or a file breaks an input rule.
 *
 * Load, validation and resolve report it at every stage (D145, D146, D149, D152); the build's media stage reports an image it cannot derive. This module passes the core's findings through and checks nothing again.
 */
import {coreFindingsFor, type SourceRule} from '../rule.js';

export const rule: SourceRule = {
  id: 'R09',
  phase: 'source',
  check: (context) => coreFindingsFor(context, 'R09'),
};
