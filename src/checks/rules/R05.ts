/**
 * R05: A chart has no summary.
 *
 * The schema mapping reports a missing, blank or invisible summary (D149, D164(c)); the chart module never writes one (D44). This module passes the findings through and checks nothing again.
 */
import {coreFindingsFor, type SourceRule} from '../rule.js';

export const rule: SourceRule = {
  id: 'R05',
  phase: 'source',
  check: (context) => coreFindingsFor(context, 'R05'),
};
