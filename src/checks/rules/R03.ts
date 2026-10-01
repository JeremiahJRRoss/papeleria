/**
 * R03: An image has neither alt text nor a decorative mark, or has both.
 *
 * The schema mapping reports it for images, comic pages and logos (D149, D164(c)), so this module passes those findings through and checks nothing again.
 */
import {coreFindingsFor, type SourceRule} from '../rule.js';

export const rule: SourceRule = {
  id: 'R03',
  phase: 'source',
  check: (context) => coreFindingsFor(context, 'R03'),
};
