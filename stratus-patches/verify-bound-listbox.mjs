/* WHAT 0001-bound-listbox-wherever-mounted.patch BUYS, AND WHAT IT REFUSES TO BUY.
 *
 * Exercises the stratus runner's optionsOf against seven stub DOMs, extracting the function from
 * the shipped runner string exactly the way test/question-label-dom.test.js does it - a copy would
 * let this keep passing while the reader drifted, which is the failure mode that whole file exists
 * to catch.
 *
 * Run it against BOTH revisions; the pair is the evidence:
 *   node verify-bound-listbox.mjs /path/to/stratus/src/managed-browser.js
 * On origin/main five of these seven come back with an EMPTY option list. With the patch applied
 * all seven are correct, and the two that already passed - two listboxes naming one opener, and a
 * portal listbox that does not name the opener - still refuse, unchanged.
 *
 * Stubs rather than Chromium because no browser binary was available where this was written; the
 * shapes below are branch coverage, and test/question-label-dom.test.js is where the same
 * assertions belong against a real tree once a browser is present. */
import assert from 'node:assert/strict';
const runnerPath = process.argv[2];
if (!runnerPath) {
  console.error('usage: node verify-bound-listbox.mjs <path to stratus src/managed-browser.js>');
  process.exit(2);
}
const { SANDBOX_RUNNER } = await import(runnerPath);

function extractBraced(prefix) {
  const start = SANDBOX_RUNNER.indexOf(prefix);
  assert.notEqual(start, -1, `${prefix} must still be in the runner`);
  const open = SANDBOX_RUNNER.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SANDBOX_RUNNER.length; i += 1) {
    const ch = SANDBOX_RUNNER[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return SANDBOX_RUNNER.slice(start, i + 1); }
  }
  throw new Error(`could not find the end of ${prefix}`);
}

const SRC = [
  extractBraced('function clean(s) {'),
  extractBraced('function renderedText(node) {'),
  extractBraced('function optionsOf(el, block) {'),
].join('\n');

/** Minimal element stub: enough surface for the custom-list branch of optionsOf. */
function node({ role = null, id = null, attrs = {}, children = [], text = '', tagName = 'DIV' }) {
  const all = { ...(role ? { role } : {}), ...(id ? { id } : {}), ...attrs };
  const self = {
    tagName,
    id: id ?? '',
    type: undefined,
    parentElement: null,
    textContent: text,
    innerText: text,
    children,
    attributes: Object.entries(all).map(([name, value]) => ({ name, value })),
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(all, name) ? String(all[name]) : null),
    hasAttribute: (name) => Object.prototype.hasOwnProperty.call(all, name),
    closest: () => null,
    querySelector: (sel) => self.querySelectorAll(sel)[0] ?? null,
    querySelectorAll: (sel) => {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (sel === '[role="option"]' && c.getAttribute('role') === 'option') out.push(c);
          if (sel === 'li' && c.tagName === 'LI') out.push(c);
          if (sel === '[role="listbox"]' && c.getAttribute('role') === 'listbox') out.push(c);
          walk(c);
        }
      };
      walk(self);
      return out;
    },
  };
  for (const c of children) c.parentElement = self;
  return self;
}

const option = (t) => node({ role: 'option', text: t, attrs: { value: t } });
const li = (t) => node({ tagName: 'LI', text: t });

function run(opener, roots) {
  const registry = new Map();
  const index = (n) => { if (n.id) registry.set(n.id, n); for (const c of n.children) index(c); };
  for (const r of roots) index(r);
  const listboxes = [];
  const collect = (n) => {
    if (n.getAttribute('role') === 'listbox' && n.getAttribute('aria-labelledby')) listboxes.push(n);
    for (const c of n.children) collect(c);
  };
  for (const r of roots) collect(r);
  const document = {
    getElementById: (id) => registry.get(id) ?? null,
    querySelectorAll: (sel) => (sel === '[role="listbox"][aria-labelledby]' ? listboxes : []),
  };
  const fn = new Function('document', `${SRC}\nreturn optionsOf;`)(document);
  return fn(opener, node({ children: [] }));
}

let failures = 0;
const check = (name, actual, expected) => {
  try { assert.deepEqual(actual, expected); console.log(`  ok  ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL  ${name}\n      actual=${JSON.stringify(actual)}\n      expect=${JSON.stringify(expected)}`); }
};

// 1. The Recruitee shape, PORTALLED: the opener sits in its question block and the popper-positioned
//    menu is appended near <body>, so they share no parent and the only binding is aria-labelledby.
{
  const opener = node({ tagName: 'BUTTON', id: 'input-candidate.salutation-2', attrs: { 'aria-haspopup': 'listbox' } });
  const questionBlock = node({ id: 'question-block', children: [opener] });
  const menu = node({ role: 'listbox', id: 'popper-1', attrs: { 'aria-labelledby': 'supporting input-candidate.salutation-2' },
    children: ['Herr', 'Frau', 'Kein/e'].map(option) });
  const portalRoot = node({ id: 'popper-root', children: [menu] });
  check('portalled listbox bound by aria-labelledby',
    run(opener, [questionBlock, portalRoot]).values, ['Herr', 'Frau', 'Kein/e']);
}
// 2. aria-owns, the ARIA 1.0 spelling this read ignored entirely.
{
  const menu = node({ role: 'listbox', id: 'select2-results', children: ['Yes', 'No'].map(option) });
  const opener = node({ tagName: 'SPAN', id: 'sel2', attrs: { role: 'combobox', 'aria-owns': 'select2-results' } });
  check('aria-owns resolves the popup', run(opener, [opener, menu]).values, ['Yes', 'No']);
}
// 3. aria-controls naming the popup CONTAINER, with the listbox one node inside it.
{
  const inner = node({ role: 'listbox', children: ['Bachelors', 'Masters'].map(option) });
  const wrapper = node({ id: 'menu-wrap', attrs: { role: 'presentation' }, children: [inner] });
  const opener = node({ tagName: 'INPUT', id: 'degree', attrs: { role: 'combobox', 'aria-controls': 'menu-wrap' } });
  check('aria-controls to a wrapper still finds the list', run(opener, [opener, wrapper]).values, ['Bachelors', 'Masters']);
}
// 4. A <ul role="listbox"> whose rows are plain <li>.
{
  const menu = node({ tagName: 'UL', role: 'listbox', id: 'ul-menu', attrs: { 'aria-labelledby': 'ul-opener' },
    children: ['3.5 - 4.0', '3.0 - 3.49'].map(li) });
  const opener = node({ tagName: 'BUTTON', id: 'ul-opener', attrs: { 'aria-haspopup': 'listbox' } });
  check('li rows in a declared listbox are options', run(opener, [opener, menu]).values, ['3.5 - 4.0', '3.0 - 3.49']);
}
// 5. THE DISCIPLINE HOLDS: two listboxes naming the same opener stay ambiguous, and nothing is read.
{
  const opener = node({ tagName: 'BUTTON', id: 'amb', attrs: { 'aria-haspopup': 'listbox' } });
  const a = node({ role: 'listbox', id: 'm1', attrs: { 'aria-labelledby': 'amb' }, children: [option('A')] });
  const b = node({ role: 'listbox', id: 'm2', attrs: { 'aria-labelledby': 'amb' }, children: [option('B')] });
  const out = run(opener, [opener, a, b]);
  check('two bound listboxes refuse rather than guess', { values: out.values, complete: out.complete }, { values: [], complete: false });
}
// 6. A portal listbox that does NOT name the opener is never touched.
{
  const opener = node({ tagName: 'BUTTON', id: 'mine', attrs: { 'aria-haspopup': 'listbox' } });
  const foreign = node({ role: 'listbox', id: 'other', attrs: { 'aria-labelledby': 'somebody-else' }, children: [option('X')] });
  check('an unrelated page list is ignored', run(opener, [opener, foreign]).values, []);
}
// 7. An empty popup shell is not a vocabulary and is not an ambiguity either.
{
  const opener = node({ tagName: 'BUTTON', id: 'empty', attrs: { 'aria-haspopup': 'listbox' } });
  const shell = node({ role: 'listbox', id: 'shell', attrs: { 'aria-labelledby': 'empty' }, children: [] });
  const real = node({ role: 'listbox', id: 'real', attrs: { 'aria-labelledby': 'empty' }, children: [option('Only')] });
  check('an empty shell does not create an ambiguity', run(opener, [opener, shell, real]).values, ['Only']);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
