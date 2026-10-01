/**
 * R17: The manifest's schema is newer than the tool.
 *
 * The manifest loader decides it before every other check but the size limit (D164(b)), so this module passes the finding through and checks nothing again.
 */
import {coreFindingsFor, type SourceRule} from '../rule.js';

export const rule: SourceRule = {
  id: 'R17',
  phase: 'source',
  check: (context) => coreFindingsFor(context, 'R17'),
};
