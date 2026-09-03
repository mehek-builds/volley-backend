import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { chromium } from 'playwright-core';

import { READ_SUBMIT_READINESS_SCRIPT } from './portalSubmission';

/* A REQUIRED UPLOAD THAT IS THE ONLY CONTROL IN ITS BLOCK.
 *
 * The readiness gate excludes file inputs when it picks the control a marked label speaks for, so
 * that a block holding a real control prefers that one. On the asterisk arm, which passes no widget
 * fallback, a block whose ONLY control is the upload used to resolve to nothing at all - so the
 * field was not judged empty, it was skipped, and a run pressed submit against a form with no
 * resume on it. That is the DSI Innovations / Recruitee failure of 2026-09-02: filled_fields
 * recorded the resume because setInputFiles returned cleanly, the gate stayed silent, and the
 * employer form had nothing to accept.
 *
 * These run the REAL script against a real DOM rather than a hand-rolled stand-in, because the bug
 * lived in which node the chain selected, and only a live querySelectorAll can answer that.
 */

const BROWSER_EXECUTABLE = [
  process.env.LITOS_TEST_BROWSER_EXECUTABLE,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

test(
  'a starred upload block is judged rather than skipped, and a recorded upload stays silent',
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

      // The shape DSI Innovations submitted against: a starred label, a styled dropzone, and a
      // bare file input carrying no id for the label to name. This returned zero blockers.
      const emptyRequiredUpload = await readinessOf(`
        <form data-litos-submit-scope-v1="active">
          <div class="field">
            <label>CV or resume *</label>
            <div class="dropzone">Upload a file or drag and drop here</div>
            <input type="file" name="candidate[cv]">
          </div>
        </form>
      `);
      assert.deepEqual(emptyRequiredUpload.blocking, ['"CV or resume" is required and is still empty']);

      // An uploader that consumes the file and resets its own input reads back empty on a form
      // where everything worked. The block's rendered filename is the evidence, and widgetHasAnswer
      // reads it, so this must stay silent - a false blocker here would refuse correct runs.
      const consumedAndReset = await readinessOf(`
        <form data-litos-submit-scope-v1="active">
          <div class="field">
            <label>CV or resume *</label>
            <span class="file-upload__filename">Mehek Mandal Resume.pdf</span>
            <input type="file" name="candidate[cv]">
          </div>
        </form>
      `);
      assert.deepEqual(consumedAndReset.blocking, []);

      // A file actually sitting in the input is the other half of that evidence.
      await page.setContent(`
        <form data-litos-submit-scope-v1="active">
          <div class="field">
            <label>CV or resume *</label>
            <input type="file" name="candidate[cv]">
          </div>
        </form>
      `);
      await page.setInputFiles('input[type="file"]', {
        name: 'Mehek Mandal Resume.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 test'),
      });
      const heldFile = await page.evaluate(READ_SUBMIT_READINESS_SCRIPT) as { blocking: string[] };
      assert.deepEqual(heldFile.blocking, []);

      // An upload the employer did not mark carries nothing for either marker loop to find.
      const optionalUpload = await readinessOf(`
        <form data-litos-submit-scope-v1="active">
          <div class="field">
            <label>Cover letter</label>
            <input type="file" name="candidate[cover]">
          </div>
        </form>
      `);
      assert.deepEqual(optionalUpload.blocking, []);

      // The block that holds a real control still prefers it: this adds an arm where the chain
      // resolved to nothing, and changes the target on no path that already had one.
      const uploadBesideAnsweredText = await readinessOf(`
        <form data-litos-submit-scope-v1="active">
          <div class="field">
            <label>Full name *</label>
            <input type="text" value="Mehek Mandal">
            <input type="file" name="candidate[cv]">
          </div>
        </form>
      `);
      assert.deepEqual(uploadBesideAnsweredText.blocking, []);
    } finally {
      await browser.close();
    }
  },
);
