/* THE TRANSCRIPT THAT TOOK THE RESUME'S SLOT, DRIVEN AGAINST FORMS SHAPED LIKE THE REAL ONES.
 *
 * The defect these tests fence off shipped with a green suite. What was already covered was the
 * SHAPE of the transcript selector: that every arm mentions the word, that every arm carries the
 * name/id exclusions. Both were true, and the exclusions excluded nothing, because seven of the
 * families do not identify their resume input by a name or id containing "resume" at all:
 *
 *   Workable    data-ui="resume"                          Personio  name="documents.cv"
 *   Rippling    data-testid="input-resume"                Pinpoint  application_form[application][cv]
 *   Recruitee   name="candidate.cv"                       Comeet    name="cv"
 *   Teamtailor  #upload_resume_field input[type="file"]
 *
 * On those, `label:has-text("Transcript") input[type="file"]:not([name*="resume" i])...` matched the
 * RESUME input, setInputFiles replaced what it was holding, and the run recorded both documents as
 * attached. The employer received a transcript in the resume slot and no resume.
 *
 * A test that reads the selector cannot see any of that: the selector it reads looks correct. So
 * every test here resolves selectors against a DOM, through the same code paths a run uses, and
 * asserts which control ended up holding which file. The DOM and its selector engine are the small
 * implementation at the top of this file: attribute operators with the case-insensitive flag, the
 * descendant combinator, :not() with complex arguments, and :has-text(), which is the exact subset
 * these selectors use. Its agreement with Playwright's own engine on these fixtures was measured in
 * a real Chromium before this file was written; where the two could disagree the note says so.
 *
 * WHAT FAILS ON MAIN, before the fix, is recorded per test. In summary: all seven families fail both
 * the direct and the managed assertion, Greenhouse and Ashby pass both (their resume inputs really
 * do carry name*="resume", which is what made the exclusion look sufficient), the fail-closed case
 * fails, and the capability case fails.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright-core';
import {
  buildManagedPortalActions,
  coverLetterUploadSelector,
  fillPortal,
  hasTranscriptUpload,
  resumeUploadSelector,
  transcriptUploadSelector,
  type SubmissionPacket,
  type SupportedPortal,
} from './portalSubmission';
import { preparationEvidenceBlockers } from '../routes/submissionRunner';

// ─── a DOM, and enough of a CSS engine to resolve what this repo's selectors say ──────────────

type DomNode = {
  tag: string;
  attrs: Record<string, string>;
  children: DomNode[];
  parent: DomNode | null;
  text: string;
};

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source']);
const TAG_RE = /<(\/?)([a-zA-Z][-a-zA-Z0-9]*)((?:\s+[-a-zA-Z0-9_:.[\]]+(?:="[^"]*")?)*)\s*(\/?)>/g;
const ATTR_RE = /([-a-zA-Z0-9_:.[\]]+)(?:="([^"]*)")?/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(ATTR_RE)) attrs[match[1].toLowerCase()] = match[2] ?? '';
  return attrs;
}

function parseHtml(html: string): DomNode {
  const root: DomNode = { tag: '#root', attrs: {}, children: [], parent: null, text: '' };
  const stack: DomNode[] = [root];
  let cursor = 0;
  const pushText = (value: string) => {
    const trimmed = value.replace(/\s+/g, ' ');
    if (!trimmed.trim()) return;
    const parent = stack[stack.length - 1];
    parent.children.push({ tag: '#text', attrs: {}, children: [], parent, text: trimmed });
  };
  for (const match of html.matchAll(TAG_RE)) {
    pushText(html.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const [, closing, tag, rawAttrs, selfClosing] = match;
    const name = tag.toLowerCase();
    if (closing) {
      // Tolerate a stray close rather than corrupting the stack.
      if (stack.length > 1 && stack[stack.length - 1].tag === name) stack.pop();
      continue;
    }
    const parent = stack[stack.length - 1];
    const node: DomNode = { tag: name, attrs: parseAttrs(rawAttrs), children: [], parent, text: '' };
    parent.children.push(node);
    if (!selfClosing && !VOID_TAGS.has(name)) stack.push(node);
  }
  pushText(html.slice(cursor));
  return root;
}

function textOf(node: DomNode): string {
  if (node.tag === '#text') return node.text;
  return node.children.map(textOf).join(' ');
}

function descendants(node: DomNode): DomNode[] {
  const out: DomNode[] = [];
  for (const child of node.children) {
    if (child.tag !== '#text') out.push(child);
    out.push(...descendants(child));
  }
  return out;
}

/** Split on `separator` at nesting depth zero, so `:not(a, b)` and quoted text stay intact. */
function splitTopLevel(input: string, separator: ',' | ' '): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const char of input) {
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === '(' || char === '[')) depth += 1;
    if (!quoted && (char === ')' || char === ']')) depth -= 1;
    if (!quoted && depth === 0 && char === separator) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** The pieces of one compound selector: `input[type="file"]:not(#a b)` becomes three. */
function compoundParts(compound: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quoted = false;
  for (const char of compound) {
    if (char === '"') quoted = !quoted;
    const atTop = !quoted && depth === 0;
    if (atTop && current && (char === '#' || char === '.' || char === '[' || char === ':')) {
      parts.push(current);
      current = '';
    }
    if (!quoted && (char === '(' || char === '[')) depth += 1;
    if (!quoted && (char === ')' || char === ']')) depth -= 1;
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function attributeMatches(node: DomNode, part: string): boolean {
  const body = part.slice(1, -1);
  const match = body.match(/^([-a-zA-Z0-9_:.[\]]+)(?:([*^$|~]?=)"([^"]*)")?(\s+i)?$/);
  if (!match) throw new Error(`unsupported attribute selector: ${part}`);
  const [, name, operator, rawValue, insensitive] = match;
  const actual = node.attrs[name.toLowerCase()];
  if (actual === undefined) return false;
  if (!operator) return true;
  const left = insensitive ? actual.toLowerCase() : actual;
  const right = insensitive ? rawValue.toLowerCase() : rawValue;
  if (operator === '=') return left === right;
  if (operator === '*=') return left.includes(right);
  if (operator === '^=') return left.startsWith(right);
  if (operator === '$=') return left.endsWith(right);
  throw new Error(`unsupported attribute operator: ${part}`);
}

function matchesCompound(node: DomNode, compound: string): boolean {
  for (const part of compoundParts(compound)) {
    if (part.startsWith('#')) {
      if (node.attrs.id !== part.slice(1)) return false;
    } else if (part.startsWith('.')) {
      if (!(node.attrs.class ?? '').split(/\s+/).includes(part.slice(1))) return false;
    } else if (part.startsWith('[')) {
      if (!attributeMatches(node, part)) return false;
    } else if (part.startsWith(':not(')) {
      if (matchesComplex(node, part.slice(5, -1))) return false;
    } else if (part.startsWith(':has-text(')) {
      const needle = part.slice(10, -1).replace(/^"|"$/g, '').toLowerCase();
      if (!textOf(node).toLowerCase().includes(needle)) return false;
    } else if (part.startsWith(':')) {
      throw new Error(`unsupported pseudo-class: ${part}`);
    } else if (node.tag !== part.toLowerCase()) {
      return false;
    }
  }
  return true;
}

function matchesFrom(node: DomNode, compounds: string[], index: number): boolean {
  if (!matchesCompound(node, compounds[index])) return false;
  if (index === 0) return true;
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (matchesFrom(ancestor, compounds, index - 1)) return true;
  }
  return false;
}

/** One complex selector (descendant combinators only, which is all this repo's selectors use). */
function matchesComplex(node: DomNode, selector: string): boolean {
  for (const alternative of splitTopLevel(selector, ',')) {
    if (matchesFrom(node, splitTopLevel(alternative, ' '), splitTopLevel(alternative, ' ').length - 1)) {
      return true;
    }
  }
  return false;
}

/** Every match, in document order, exactly as a browser returns a selector list. */
function queryAll(root: DomNode, selector: string): DomNode[] {
  return descendants(root).filter((node) => matchesComplex(node, selector));
}

// ─── a Page over that DOM ────────────────────────────────────────────────────────────────────

type Harness = {
  page: Page;
  /** The file name currently held by the first control matching `selector`, or '' for none. */
  fileIn: (selector: string) => string;
  /** Which control the selector resolves to first, as a stable identifier for assertions. */
  firstMatchId: (selector: string) => string;
};

function controlId(node: DomNode | undefined): string {
  if (!node) return '';
  return node.attrs.id
    || node.attrs.name
    || node.attrs['data-ui']
    || node.attrs['data-testid']
    || `<${node.tag}>`;
}

function labelTextFor(node: DomNode, root: DomNode): string {
  const parts: string[] = [];
  if (node.attrs['aria-label']) parts.push(node.attrs['aria-label']);
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.tag === 'label') parts.push(textOf(ancestor));
  }
  if (node.attrs.id) {
    for (const label of descendants(root)) {
      if (label.tag === 'label' && label.attrs.for === node.attrs.id) parts.push(textOf(label));
    }
  }
  return parts.join(' ');
}

function harnessFor(html: string): Harness {
  const root = parseHtml(html);
  const files = new Map<DomNode, string>();
  const values = new Map<DomNode, string>();

  const makeHandle = (node: DomNode) => ({
    node,
    getAttribute: async (name: string) => node.attrs[name] ?? null,
    setInputFiles: async (file: { name: string }) => {
      files.set(node, file.name);
    },
    evaluate: async (fn: (element: DomNode, arg: unknown) => unknown, arg: unknown) => {
      const unwrapped = arg && typeof arg === 'object' && 'node' in (arg as Record<string, unknown>)
        ? (arg as { node: DomNode }).node
        : arg;
      return fn(node, unwrapped);
    },
  });

  const makeLocator = (nodes: DomNode[]): unknown => ({
    count: async () => nodes.length,
    first: () => makeLocator(nodes.slice(0, 1)),
    nth: (index: number) => makeLocator(nodes.slice(index, index + 1)),
    elementHandles: async () => nodes.map(makeHandle),
    elementHandle: async () => (nodes[0] ? makeHandle(nodes[0]) : null),
    getAttribute: async (name: string) => nodes[0]?.attrs[name] ?? null,
    setInputFiles: async (file: { name: string }) => {
      if (!nodes[0]) throw new Error('no element to upload to');
      files.set(nodes[0], file.name);
    },
    isVisible: async () => nodes.length > 0,
    inputValue: async () => (nodes[0] ? values.get(nodes[0]) ?? '' : ''),
    fill: async (value: string) => {
      if (nodes[0]) values.set(nodes[0], value);
    },
    press: async () => undefined,
    click: async () => undefined,
    check: async () => undefined,
    isChecked: async () => false,
    selectOption: async () => [],
    waitFor: async () => undefined,
    evaluate: async () => false,
    innerText: async () => nodes.map(textOf).join(' '),
    locator: (selector: string) => makeLocator(
      nodes.flatMap((node) => descendants(node).filter((child) => matchesComplex(child, selector))),
    ),
  });

  const page = {
    locator: (selector: string) => makeLocator(queryAll(root, selector)),
    getByLabel: (pattern: RegExp) => makeLocator(
      descendants(root).filter((node) => ['input', 'textarea', 'select'].includes(node.tag)
        && pattern.test(labelTextFor(node, root))),
    ),
    getByText: () => makeLocator([]),
    url: () => 'https://example.invalid/apply',
  } as unknown as Page;

  return {
    page,
    fileIn: (selector: string) => {
      const node = queryAll(root, selector)[0];
      return node ? files.get(node) ?? '' : '';
    },
    firstMatchId: (selector: string) => controlId(queryAll(root, selector)[0]),
  };
}

// The harness is load-bearing, so it is checked before anything is concluded from it. Each case is
// a property of the selectors this repo actually ships, and a wrong engine fails here rather than
// silently passing a test about the fix.
test('the selector harness resolves the constructs these selectors are built from', () => {
  const { page, firstMatchId } = harnessFor(`
    <form>
      <label id="docs">Attach your documents: resume and transcript
        <input type="file" data-ui="resume" id="input_files_input_Zos7">
        <input type="file" name="documents[1]" id="doc-two">
      </label>
      <div id="upload_resume_field"><input type="file" name="candidate[cv]"></div>
      <input type="file" name="Transcript_Upload" id="third">
    </form>`);
  assert.ok(page);
  // Attribute equality, the case-insensitive flag, and substring matching.
  assert.equal(firstMatchId('input[type="file"][data-ui="resume"]'), 'input_files_input_Zos7');
  assert.equal(firstMatchId('input[type="file"][name*="transcript" i]'), 'third');
  assert.equal(firstMatchId('input[type="file"][name*="transcript"]'), '');
  // Document order across a selector list, which is what decides the managed runner's answer.
  assert.equal(firstMatchId('input[type="file"][name="documents[1]"], input[type="file"][data-ui="resume"]'), 'input_files_input_Zos7');
  // The descendant combinator, including an id-scoped wrapper.
  assert.equal(firstMatchId('#upload_resume_field input[type="file"]'), 'candidate[cv]');
  // :has-text() over an element's whole subtree, and it reaches both inputs in that label.
  assert.equal(firstMatchId('label:has-text("Transcript") input[type="file"]'), 'input_files_input_Zos7');
  // :not() with a compound argument, and with a complex one.
  assert.equal(firstMatchId('label:has-text("Transcript") input[type="file"]:not([data-ui="resume"])'), 'doc-two');
  assert.equal(firstMatchId('input[type="file"]:not(#upload_resume_field input[type="file"]):not([data-ui="resume"])'), 'doc-two');
});

// ─── the seven families, plus the two controls that already worked ───────────────────────────

/* Each fixture is the family's real resume control, as the adapter identifies it, inside one label
 * that mentions a transcript. That is the shape the defect needs and the shape the header comment on
 * TRANSCRIPT_UPLOAD_ARMS describes: an employer's own "attach your documents" block, one label over
 * a group of file inputs.
 *
 * The transcript control in each fixture is deliberately NOT named "transcript". It is reachable
 * only through the label-scoped arm, which is what makes these tests exercise the arm that could
 * reach the resume. A transcript input carrying the word in its own name would be found by the first
 * arm on the direct path and the fixture would prove nothing about the fourth. */
type Fixture = {
  portal: SupportedPortal;
  html: string;
  /** The selector for the control the resume must still be in when the fill is done. */
  resume: string;
  /** The selector for the control the transcript must land in. */
  transcript: string;
  coverLetter?: string;
};

export const FAMILY_FIXTURES: Fixture[] = [
  {
    portal: 'workable',
    resume: 'input[data-ui="resume"]',
    transcript: 'input[name="documents[1]"]',
    html: `<form>
      <input name="firstname" type="text"><input name="email" type="text">
      <label id="docs">Documents. Upload your CV and your transcript.
        <input type="file" data-ui="resume" id="input_files_input_Zos7eYaJDFVTg6xg">
        <input type="file" name="documents[1]" id="input_files_input_Xk8sTaQpLMNRb2vc">
      </label>
    </form>`,
  },
  {
    portal: 'rippling',
    resume: 'input[data-testid="input-resume"]',
    transcript: 'input[name="documents[2]"]',
    coverLetter: 'input[data-testid="input-cover_letter"]',
    html: `<form>
      <input data-testid="input-first_name" type="text"><input data-testid="input-email" type="text">
      <label id="field-12">Attachments: CV, cover letter, transcript
        <input type="file" data-testid="input-resume" name="Z9gMtYRYFO" id="field-8">
        <input type="file" data-testid="input-cover_letter" name="Kd2pQrTUxa" id="field-9">
        <input type="file" name="documents[2]" id="field-10">
      </label>
    </form>`,
  },
  {
    portal: 'recruitee',
    resume: 'input[name="candidate.cv"]',
    transcript: 'input[name="candidate.attachment"]',
    html: `<form>
      <input name="candidate.name" type="text"><input name="candidate.email" type="text">
      <label id="docs">Your documents, including your transcript
        <input type="file" name="candidate.cv">
        <input type="file" name="candidate.attachment">
      </label>
    </form>`,
  },
  {
    portal: 'teamtailor',
    resume: '#upload_resume_field input[type="file"]',
    transcript: 'input[name="candidate[document]"]',
    html: `<form>
      <input name="candidate[first_name]" type="text"><input name="candidate[email]" type="text">
      <label id="docs">Upload your documents. A transcript is welcome.
        <span id="upload_resume_field"><input type="file" name="candidate[cv]"></span>
        <input type="file" name="candidate[document]">
      </label>
    </form>`,
  },
  {
    portal: 'personio',
    resume: 'input[name="documents.cv"]',
    transcript: 'input[name="documents.other"]',
    html: `<form>
      <input name="first_name" type="text"><input name="email" type="text">
      <label id="docs">Documents (CV, transcript)
        <input type="file" name="documents.cv">
        <input type="file" name="documents.other">
      </label>
    </form>`,
  },
  {
    portal: 'pinpoint',
    resume: 'input[name="application_form[application][cv]"]',
    transcript: 'input[name="application_form[application][attachment]"]',
    html: `<form>
      <input name="application_form[application][first_name]" type="text">
      <input name="application_form[application][email]" type="text">
      <label id="docs">Attachments, including any transcript
        <input type="file" name="application_form[application][cv]">
        <input type="file" name="application_form[application][attachment]">
      </label>
    </form>`,
  },
  {
    portal: 'comeet',
    resume: 'input[name="cv"]',
    transcript: 'input[name="attachment"]',
    html: `<form>
      <input name="firstName" type="text"><input name="email" type="text">
      <label id="docs">Upload a CV and a transcript
        <input type="file" name="cv">
        <input type="file" name="attachment">
      </label>
    </form>`,
  },
  // The two controls. Their resume inputs really do carry name*="resume", so the old spelled
  // exclusion covered them and both of these already passed before the fix. They are here to prove
  // the fix did not change what already worked.
  {
    portal: 'greenhouse',
    resume: 'input#resume',
    transcript: 'input[name="job_application[answers][1]"]',
    html: `<form>
      <input id="first_name" type="text"><input id="email" type="text">
      <label id="docs">Attachments. Resume and transcript.
        <input type="file" id="resume" name="job_application[resume]">
        <input type="file" name="job_application[answers][1]" id="answer-1">
      </label>
    </form>`,
  },
  {
    portal: 'ashby',
    resume: 'input#_systemfield_resume',
    transcript: 'input[name="a3f1c8e2"]',
    html: `<form>
      <input name="_systemfield_name" type="text"><input name="_systemfield_email" type="text">
      <label id="docs">Documents: resume, transcript
        <input type="file" id="_systemfield_resume" name="_systemfield_resume">
        <input type="file" name="a3f1c8e2">
      </label>
    </form>`,
  },
];

function packetFor(overrides: Partial<SubmissionPacket> = {}): SubmissionPacket {
  return {
    fullName: 'Mehek Mandal',
    email: 'applicant@example.invalid',
    phone: '+971 567417451',
    city: 'Dubai',
    resume: Buffer.from('%PDF resume'),
    resumeName: 'Mehek_Mandal_Resume.pdf',
    transcript: Buffer.from('%PDF transcript'),
    transcriptName: 'Mehek_Mandal_Transcript.pdf',
    questions: [],
    ...overrides,
  } as SubmissionPacket;
}

/* FAILS ON MAIN for all seven families. The transcript resolves to the resume's own control, which
 * holds Mehek_Mandal_Transcript.pdf when the fill is done, and the resume is nowhere on the form. */
for (const fixture of FAMILY_FIXTURES) {
  test(`${fixture.portal}: the transcript never lands in the resume's control (direct path)`, async () => {
    const harness = harnessFor(fixture.html);
    const packet = packetFor();
    const result = await fillPortal(harness.page, fixture.portal, packet);

    assert.equal(harness.fileIn(fixture.resume), 'Mehek_Mandal_Resume.pdf', 'the resume must survive the fill');
    assert.equal(harness.fileIn(fixture.transcript), 'Mehek_Mandal_Transcript.pdf');
    assert.ok(result.filledFields.includes('resume'));
    assert.ok(result.filledFields.includes('transcript'));
    // Nothing was in the way, so there is no collision to report.
    assert.equal(result.blockers.some((blocker) => /only upload control/.test(blocker)), false);
  });

  /* FAILS ON MAIN for the same seven. The managed runner is handed one comma-joined selector and
   * takes the first match in DOCUMENT order, so arm ordering cannot save it there either: this is
   * the same fixture answering the same question through the other path. */
  test(`${fixture.portal}: the managed transcript selector resolves past the resume control`, () => {
    const harness = harnessFor(fixture.html);
    const actions = buildManagedPortalActions(fixture.portal, packetFor());
    const transcript = actions.find((action) => action.label === 'transcript');
    assert.ok(transcript?.selector, `${fixture.portal} must still push a transcript upload`);

    const resumeControl = harness.firstMatchId(fixture.resume);
    const transcriptControl = harness.firstMatchId(fixture.transcript);
    assert.notEqual(resumeControl, transcriptControl, 'the fixture must have two distinct controls');
    assert.notEqual(harness.firstMatchId(transcript.selector!), resumeControl);
    assert.equal(harness.firstMatchId(transcript.selector!), transcriptControl);

    // And the resume action still finds the resume, so the exclusion did not simply delete both.
    const resume = actions.find((action) => action.label === 'resume');
    assert.ok(resume?.selector);
    assert.equal(harness.firstMatchId(resume.selector!), resumeControl);
  });

  // The two paths must agree. A fix that repaired one of them would leave the other sending the
  // wrong file, and the runs that use each are chosen by infrastructure, not by the applicant.
  test(`${fixture.portal}: the managed and direct paths choose the same control for the transcript`, async () => {
    const direct = harnessFor(fixture.html);
    await fillPortal(direct.page, fixture.portal, packetFor());
    const managed = harnessFor(fixture.html);
    const selector = buildManagedPortalActions(fixture.portal, packetFor())
      .find((action) => action.label === 'transcript')?.selector;
    assert.ok(selector);
    assert.equal(managed.firstMatchId(selector), direct.firstMatchId(fixture.transcript));
  });
}

/* THE COVER LETTER IS PROTECTED BY THE SAME MECHANISM, AND ON RIPPLING IT NEEDS TO BE.
 *
 * Rippling identifies its cover-letter input by data-testid, so `:not([name*="cover" i])` was as
 * inert against it as the resume exclusion was against input-resume. A transcript that displaces the
 * cover letter is the same defect one document over. FAILS ON MAIN. */
test('rippling: the transcript displaces neither the resume nor the cover letter', async () => {
  const fixture = FAMILY_FIXTURES.find((item) => item.portal === 'rippling')!;
  const harness = harnessFor(fixture.html);
  await fillPortal(harness.page, 'rippling', packetFor({
    coverLetter: Buffer.from('%PDF cover'),
    coverLetterName: 'Mehek_Mandal_Cover_Letter.pdf',
  }));
  assert.equal(harness.fileIn(fixture.resume), 'Mehek_Mandal_Resume.pdf');
  assert.equal(harness.fileIn(fixture.coverLetter!), 'Mehek_Mandal_Cover_Letter.pdf');
  assert.equal(harness.fileIn(fixture.transcript), 'Mehek_Mandal_Transcript.pdf');
});

/* Teamtailor's cover-letter equivalent, and the honest version of it: TEAMTAILOR_COVER_LETTER_
 * SELECTOR is a deliberate never-match, because neither captured tenant exposed a cover-letter file
 * input, so Litos does not upload one there at all. What has to hold instead is that the transcript
 * cannot reach the resume wrapper, whose input carries no "resume" token anywhere on itself, and
 * that a cover letter on the packet changes none of that. FAILS ON MAIN. */
test('teamtailor: an id-scoped resume wrapper is protected even with a cover letter on the packet', async () => {
  const fixture = FAMILY_FIXTURES.find((item) => item.portal === 'teamtailor')!;
  const harness = harnessFor(fixture.html);
  await fillPortal(harness.page, 'teamtailor', packetFor({
    coverLetter: Buffer.from('%PDF cover'),
    coverLetterName: 'Mehek_Mandal_Cover_Letter.pdf',
  }));
  assert.equal(harness.fileIn(fixture.resume), 'Mehek_Mandal_Resume.pdf');
  assert.equal(harness.fileIn(fixture.transcript), 'Mehek_Mandal_Transcript.pdf');
  assert.equal(coverLetterUploadSelector('teamtailor').includes('ThatDoesNotExist'), true);
});

/* FAIL CLOSED. The form has one file input and the employer's label mentions a transcript, so the
 * only control the transcript can reach is the one holding the resume. Replacing it is what shipped;
 * the alternative is to attach nothing and say so. FAILS ON MAIN, where the resume is replaced and
 * the run reports the transcript attached. */
test('a form whose only file input is the resume refuses the transcript and names the collision', async () => {
  const harness = harnessFor(`<form>
    <input name="firstname" type="text"><input name="email" type="text">
    <label id="docs">Upload your CV. Include your transcript in the same file.
      <input type="file" data-ui="resume" id="input_files_input_Zos7eYaJDFVTg6xg">
    </label>
  </form>`);
  const result = await fillPortal(harness.page, 'workable', packetFor());

  assert.equal(harness.fileIn('input[data-ui="resume"]'), 'Mehek_Mandal_Resume.pdf');
  assert.equal(result.filledFields.includes('transcript'), false);
  const conflict = result.blockers.find((blocker) => /only upload control/.test(blocker));
  assert.ok(conflict, `the collision must be reported; blockers were ${JSON.stringify(result.blockers)}`);
  assert.match(conflict!, /transcript/);
  assert.match(conflict!, /resume/);
  // Not the required-field shape, which sanitizeProviderBlockers would rewrite into its own wording.
  assert.doesNotMatch(conflict!, /is required\.?$/);
});

/* THE CAPABILITY READ, which was failing in the same direction as the upload and so could not catch
 * it. A resume control that happens to sit under a label mentioning a transcript is not a transcript
 * control, and answering yes here is what put a transcript on the packet for exactly the forms where
 * the upload would land on the resume. FAILS ON MAIN. */
test('transcript_supported is not set by a control that is the resume', async () => {
  const resumeOnly = harnessFor(`<form>
    <label id="docs">Upload your CV. Include your transcript in the same file.
      <input type="file" data-ui="resume" id="input_files_input_Zos7eYaJDFVTg6xg">
    </label>
  </form>`);
  assert.equal(await hasTranscriptUpload(resumeOnly.page, 'workable'), false);

  // And the answer is still yes when the form really does have somewhere to put one, so the test
  // above is about the resume and not about the question being answered no everywhere.
  const withTranscript = harnessFor(`<form>
    <label id="docs">Documents: CV and transcript
      <input type="file" data-ui="resume" id="input_files_input_Zos7eYaJDFVTg6xg">
      <input type="file" name="documents[1]" id="input_files_input_Xk8sTaQpLMNRb2vc">
    </label>
  </form>`);
  assert.equal(await hasTranscriptUpload(withTranscript.page, 'workable'), true);

  // Including through the label association a CSS arm cannot see, which is what the fallback is for.
  const labelledByFor = harnessFor(`<form>
    <input type="file" data-ui="resume" id="input_files_input_Zos7eYaJDFVTg6xg">
    <label for="doc-2">Unofficial transcript</label>
    <input type="file" name="documents[1]" id="doc-2">
  </form>`);
  assert.equal(await hasTranscriptUpload(labelledByFor.page, 'workable'), true);
});

/* THE MAP MUST KEEP NAMING WHAT THE FILL PATH ACTUALLY USES, or the exclusions protect a control
 * nobody uploads to. Measured over every portal rather than a list of the ones someone thought of:
 * the selectors the managed builder really pushes resume uploads to must all be arms of
 * resumeUploadSelector. This is the check that keeps a family added later from quietly reintroducing
 * the defect by declaring its resume control in one place and uploading to another. */
test('every portal resume upload goes to a selector the resume map declares', () => {
  const portals: SupportedPortal[] = [
    'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'jazzhr', 'paylocity', 'rippling',
    'breezy', 'bamboohr', 'recruitee', 'manual_recruitee', 'teamtailor', 'personio', 'pinpoint',
    'comeet', 'zoho_recruit', 'bullhorn', 'controlled_test', 'controlled_lever', 'controlled_ashby',
    'controlled_smartrecruiters', 'controlled_workable', 'controlled_jazzhr', 'controlled_paylocity',
    'controlled_rippling', 'controlled_breezy', 'controlled_bamboohr',
  ];
  for (const portal of portals) {
    const declared = new Set(resumeUploadSelector(portal).split(', '));
    const used = buildManagedPortalActions(portal, packetFor())
      .filter((action) => action.label === 'resume')
      .map((action) => action.selector ?? '');
    assert.ok(used.length > 0, `${portal} must upload a resume somewhere`);
    // Arm by arm: an upload action's selector can itself be a list, and every alternative in it is a
    // control the resume can land in.
    for (const arm of used.flatMap((selector) => selector.split(', '))) {
      assert.ok(
        declared.has(arm),
        `${portal} uploads the resume to ${arm}, which resumeUploadSelector does not declare`,
      );
    }
  }
});

/* THE OTHER HALF: NOTICING IT, on the path that cannot prevent it by holding the page.
 *
 * The managed runner is a remote process. Its protection is the derived selector, and this is the
 * measurement that says whether the protection held on the form actually in front of the run: the
 * resume's own control, read back after the last upload that could have taken it. Every case below
 * would report a clean, sendable, ready packet on main, because the run's filled fields say 'resume'
 * and 'transcript' and there was nothing else to consult.
 *
 * All four of these FAIL ON MAIN in the sense that main has no such read to consult: the first case
 * returns [] there rather than the sentence, which is the silence being fixed. */
test('a resume displaced by a later upload is reported, not counted as attached', () => {
  const packet = packetFor({
    coverLetter: Buffer.from('%PDF cover'),
    coverLetterName: 'Mehek_Mandal_Cover_Letter.pdf',
  });
  const text = 'Apply for this job. First Name Last Name Email Resume Cover Letter Transcript Submit application';
  const run = (value: string | null) => preparationEvidenceBlockers(
    {
      text,
      filledFields: ['first_name', 'last_name', 'email', 'resume', 'cover_letter', 'transcript'],
      blockers: [],
      discovered: [],
      extracted: [{ label: 'resume_upload_verify', value }],
    },
    packet,
  );

  // The resume's control is holding the transcript. Both uploads returned cleanly and both labels
  // reached filled_fields, so this read is the only thing that knows.
  const displaced = run('C:\\fakepath\\Mehek_Mandal_Transcript.pdf');
  assert.equal(displaced.length, 1, JSON.stringify(displaced));
  assert.match(displaced[0], /resume control is holding your transcript/);
  assert.match(displaced[0], /without a resume/);

  // The cover letter is the same failure one document over.
  assert.match(run('C:\\fakepath\\Mehek_Mandal_Cover_Letter.pdf')[0] ?? '', /holding your cover letter/);

  // The resume is where it should be, so there is nothing to say.
  assert.deepEqual(run('C:\\fakepath\\Mehek_Mandal_Resume.pdf'), []);

  /* AND THE TWO READINGS THAT MUST NOT BE TREATED AS A FINDING. An uploader that consumes the file
     and resets its own input reads back empty on a form where everything worked, and an employer
     script that rewrites the value reads back as something we cannot identify. Calling either one a
     lost resume would block correct runs, and a genuinely missing upload is already covered by the
     filled fields. */
  assert.deepEqual(run(''), []);
  assert.deepEqual(run(null), []);
  assert.deepEqual(run('C:\\fakepath\\uploaded-1.pdf'), []);
});

/* And the exclusion is derived, not spelled. Each family's transcript selector must subtract that
 * family's own resume arms, which is the property that makes the next ATS safe without an edit. */
test('each transcript selector subtracts its own family resume control', () => {
  for (const fixture of FAMILY_FIXTURES) {
    const selector = transcriptUploadSelector(fixture.portal);
    for (const arm of resumeUploadSelector(fixture.portal).split(', ')) {
      // Text-scoped arms name a region rather than a control and are excluded by identity on the
      // direct path instead; everything else must be subtracted here.
      if (arm.includes('(')) continue;
      assert.ok(
        selector.includes(`:not(${arm})`),
        `${fixture.portal} transcript selector does not subtract its resume arm ${arm}`,
      );
    }
    // Still one comma-free arm per alternative, which every caller that splits on ', ' relies on.
    for (const arm of selector.split(', ')) assert.doesNotMatch(arm, /,/);
  }
});
