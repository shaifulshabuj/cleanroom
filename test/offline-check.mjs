/**
 * offline-check.mjs — dependency-free sanity check.
 *
 * `npm test` runs the real 32-assertion suite in Chromium and is the one that
 * counts. This is the version you can run anywhere, instantly, with nothing
 * installed: it imports the pure modules directly and proves the engine is
 * intact. Use it to confirm a checkout is healthy before doing anything else.
 *
 *   node test/offline-check.mjs
 */

import { parseDelimited, toCSV } from '../js/csv.js';
import { detectIssues, profileColumn, coerceNumber, coerceDate } from '../js/profile.js';
import { applyOp, buildDiff, OPS } from '../js/transforms.js';
import { SAMPLE_CSV, SAMPLE_NAME } from '../js/sample.js';

let failures = 0;
const check = (name, pass, detail = '') => {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures++;
};

const { columns, rows } = parseDelimited(SAMPLE_CSV);
check('sample parses', columns.length === 10 && rows.length === 76, `${rows.length}x${columns.length}`);

const issues = detectIssues({ columns, rows });
const kinds = new Set(issues.map((i) => i.kind));
for (const k of ['duplicate_rows', 'missing_values', 'whitespace', 'formatted_numbers', 'mixed_date_formats', 'inconsistent_categories']) {
  check(`detects ${k}`, kinds.has(k));
}
check('every issue carries a suggested fix', issues.every((i) => i.suggested_fix?.op));

check('parses currency', coerceNumber('¥39,545') === 39545);
check('parses parenthesised negatives', coerceNumber('(30548)') === -30548);
check('parses ISO dates', coerceDate('2026-01-01') === '2026-01-01');
check('parses text-month dates', coerceDate('15 Jul 2026') === '2026-07-15');
check('parses dotted dates', coerceDate('22.10.2026') === '2026-10-22');

const dedup = applyOp(columns, rows, 'deduplicate', {});
check('deduplicate removes the 4 planted duplicates', dedup.rows.length === 72, `${rows.length} -> ${dedup.rows.length}`);
check('transforms are pure — source untouched', rows.length === 76);

const trimmed = applyOp(columns, rows, 'trim_whitespace', {});
check('trim reports cells changed', trimmed.cells_changed > 0, `${trimmed.cells_changed} cells`);

const diff = buildDiff(columns, rows, trimmed.columns, trimmed.rows);
check('diff builds before/after examples', diff.examples.length > 0, JSON.stringify(diff.examples[0]));

const parsedNums = applyOp(columns, rows, 'parse_numbers', { column: 'amount_jpy' });
const prof = profileColumn(parsedNums.rows, 'amount_jpy');
check('amounts sum after parsing', prof.stats && prof.stats.sum > 0, `sum=${prof.stats?.sum}`);

let threw = '';
try { applyOp(columns, rows, 'trim_whitespace', { column: 'reigon' }); } catch (e) { threw = e.message; }
check('errors name the valid columns', /does not exist/.test(threw) && /order_id/.test(threw), threw);

check('15 transform ops registered', Object.keys(OPS).length === 15, `${Object.keys(OPS).length}`);
check('round-trips to CSV', toCSV(columns, rows).split('\n').length === 77);
check('sample name is set', SAMPLE_NAME === 'sales_messy.csv');

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll offline checks passed. Run `npm test` for the full browser suite.');
process.exit(failures ? 1 : 0);
