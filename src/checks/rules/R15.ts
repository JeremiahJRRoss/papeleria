/**
 * R15: A slide's column count does not match its layout.
 *
 * The schema mapping reports it (D148, D149), and the renderer refuses a piece that would break it. This module passes the findings through and checks nothing again.
 */
import {coreFindingsFor, type SourceRule} from '../rule.js';

export const rule: SourceRule = {
  id: 'R15',
  phase: 'source',
  check: (context) => coreFindingsFor(context, 'R15'),
};
