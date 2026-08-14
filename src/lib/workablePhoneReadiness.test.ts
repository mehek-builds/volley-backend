import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { chromium } from 'playwright-core';

import { READ_SUBMIT_READINESS_SCRIPT } from './portalSubmission';

const BROWSER_EXECUTABLE = [
  process.env.LITOS_TEST_BROWSER_EXECUTABLE,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

type FakeControl = {
  disabled: boolean;
  id: string;
  required: boolean;
  value: string;
  getAttribute: (name: string) => string | null;
};

type FakeMarker = {
  contains: (candidate: FakeControl) => boolean;
  getAttribute: (name: string) => string | null;
};

const control = ({
  id,
  value = '',
  required = false,
  ariaRequired = false,
}: {
  id: string;
  value?: string;
  required?: boolean;
  ariaRequired?: boolean;
}): FakeControl => ({
  disabled: false,
  id,
  required,
  value,
  getAttribute: (name) => (name === 'aria-required' && ariaRequired ? 'true' : null),
});

const NOTE_MARKED_LABEL_START = '  const noteMarkedLabel = (marker, widgetFallback) => {';
const NOTE_MARKED_LABEL_END = '\n  for (const marker of scanRoot.querySelectorAll(';

function selectMarkedTarget({
  controls,
  markerFor = null,
  markerOwnedIds = controls.map((candidate) => candidate.id),
}: {
  controls: FakeControl[];
  markerFor?: string | null;
  markerOwnedIds?: string[];
}): FakeControl | null {
  const start = READ_SUBMIT_READINESS_SCRIPT.indexOf(NOTE_MARKED_LABEL_START);
  const end = READ_SUBMIT_READINESS_SCRIPT.indexOf(NOTE_MARKED_LABEL_END, start);
  assert.notEqual(start, -1, 'the shipped readiness script must contain noteMarkedLabel');
  assert.ok(end > start, 'the shipped noteMarkedLabel declaration must have a stable boundary');

  const declaration = READ_SUBMIT_READINESS_SCRIPT.slice(start, end);
  const widget = {
    querySelectorAll: (selector: string) => {
      assert.equal(
        selector,
        'input:not([type="hidden"]):not([type="file"]), textarea, select, [role="combobox"]',
      );
      return controls;
    },
    querySelector: (selector: string) => {
      if (!selector.startsWith('#')) return null;
      return controls.find((candidate) => `#${candidate.id}` === selector) || null;
    },
  };
  const marker: FakeMarker = {
    contains: (candidate) => markerOwnedIds.includes(candidate.id),
    getAttribute: (name: string) => (name === 'for' ? markerFor : null),
  };
  let selected: FakeControl | null = null;

  // Evaluate the exact declaration embedded in the production browser script. This repository
  // intentionally has no DOM test library, so the small objects above implement only the four DOM
  // reads that noteMarkedLabel performs and keep this regression independent of a browser binary.
  const makeNoteMarkedLabel = new Function(
    'widgetOf',
    'isVisible',
    'note',
    'CSS',
    `${declaration}\nreturn noteMarkedLabel;`,
  ) as (
    widgetOf: () => typeof widget,
    isVisible: () => boolean,
    note: (_widget: typeof widget, target: FakeControl) => void,
    css: { escape: (value: string) => string },
  ) => (marker: FakeMarker, widgetFallback: boolean) => void;

  const noteMarkedLabel = makeNoteMarkedLabel(
    () => widget,
    () => true,
    (_widget, target) => { selected = target; },
    { escape: (value) => value },
  );
  noteMarkedLabel(marker, false);
  return selected;
}

const workablePhoneControls = (value: string) => [
  control({ id: 'country-trigger', value: '+1' }),
  control({ id: 'phone', value, required: true, ariaRequired: true }),
];

test('the backend mirror selects a filled live-shaped Workable telephone input', () => {
  const target = selectMarkedTarget({ controls: workablePhoneControls('2135746270') });
  assert.equal(target?.id, 'phone');
  assert.equal(target?.value, '2135746270');
});

test('the backend mirror selects an empty live-shaped Workable telephone input', () => {
  const target = selectMarkedTarget({ controls: workablePhoneControls('') });
  assert.equal(target?.id, 'phone');
  assert.equal(target?.value, '');
});

test('a valid for target stays authoritative over the required-descendant heuristic', () => {
  const controls = workablePhoneControls('2135746270');
  assert.equal(selectMarkedTarget({ controls, markerFor: 'country-trigger' })?.id, 'country-trigger');
});

test('zero or multiple marked descendants preserve the first-control fail-closed fallback', () => {
  const countryTrigger = control({ id: 'country-trigger', value: '' });
  assert.equal(
    selectMarkedTarget({ controls: [countryTrigger, control({ id: 'phone', value: '2135746270' })] })?.id,
    'country-trigger',
  );
  assert.equal(
    selectMarkedTarget({
      controls: [
        countryTrigger,
        control({ id: 'phone', value: '2135746270', required: true }),
        control({ id: 'phone-confirmation', value: '2135746270', ariaRequired: true }),
      ],
    })?.id,
    'country-trigger',
  );
});

test('a starred wrapping label cannot borrow an unrelated required field from its parent form', () => {
  const markerInput = control({ id: 'marker-input', value: '' });
  const unrelatedRequired = control({ id: 'unrelated-required', value: 'filled', required: true });
  assert.equal(
    selectMarkedTarget({
      controls: [markerInput, unrelatedRequired],
      markerOwnedIds: ['marker-input'],
    })?.id,
    'marker-input',
  );
});

test(
  'the full readiness script keeps an empty marked scalar blocked inside a broad parent form',
  { skip: BROWSER_EXECUTABLE ? false : 'No Chromium executable is installed' },
  async () => {
    assert.ok(BROWSER_EXECUTABLE);
    const browser = await chromium.launch({ executablePath: BROWSER_EXECUTABLE, headless: true });
    try {
      const page = await browser.newPage();
      const readinessOf = async (markup: string) => {
        await page.setContent(markup);
        return await page.evaluate(READ_SUBMIT_READINESS_SCRIPT) as {
          blocking: string[];
          stale: string[];
        };
      };
      const readiness = await readinessOf(`
        <form data-litos-submit-scope-v1="active">
          <label>* Marker only<input value=""></label>
          <input required value="filled">
        </form>
      `);
      assert.deepEqual(readiness.blocking, ['"* Marker only" is required and is still empty']);
      assert.deepEqual(readiness.stale, []);

      const answeredReactSelect = await readinessOf(`
        <form data-litos-submit-scope-v1="active">
          <div class="field">
            <label for="office">Office</label>
            <div class="select__container">
              <span class="select__single-value">New York</span>
              <input id="office" role="combobox" aria-required="true" value="">
            </div>
          </div>
        </form>
      `);
      assert.deepEqual(answeredReactSelect.blocking, []);

      const answeredUpload = await readinessOf(`
        <form data-litos-submit-scope-v1="active">
          <div class="file-upload" aria-label="Resume" aria-required="true">
            <span class="file-upload__filename">resume.pdf</span>
          </div>
        </form>
      `);
      assert.deepEqual(answeredUpload.blocking, []);

      const answeredChoiceGroup = await readinessOf(`
        <form data-litos-submit-scope-v1="active">
          <fieldset>
            <legend>* Preferred office</legend>
            <label><input name="office" type="radio" required>New York</label>
            <label><input name="office" type="radio" checked>San Francisco</label>
          </fieldset>
        </form>
      `);
      assert.deepEqual(answeredChoiceGroup.blocking, []);
    } finally {
      await browser.close();
    }
  },
);
