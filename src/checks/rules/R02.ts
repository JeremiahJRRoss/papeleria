/**
 * R02: A referenced file is missing.
 *
 * Resolve reports it at the manifest token that names the file (D152), so this module passes those findings through and checks nothing again.
 */
import {coreFindingsFor, type SourceRule} from '../rule.js';

export const rule: SourceRule = {
  id: 'R02',
  phase: 'source',
  check: (context) => coreFindingsFor(context, 'R02'),
};
