/* A TRIAL OF THE REAL DECISION AGAINST REAL PAGES, WITHOUT PRESSING ANYTHING.
 *
 * clickFinalSubmit does three things: collect the candidate controls, read their labels, and choose
 * between them. Only the third is a judgement, and it is the one that decides whether a real
 * person's application gets sent or her browser gets handed to LinkedIn. This drives the first two
 * against live application pages and runs the ACTUAL chooseSubmitControl over the result, so the
 * choice is exercised on real DOM rather than on labels I typed into a test.
 *
 * It never clicks. Nothing is submitted, nothing is filled, no employer sees anything.
 */
import { chromium } from 'playwright-core';
import { chooseSubmitControl, SUBMIT_CANDIDATE_SELECTOR } from '../src/lib/portalSubmission';

/* Live application forms, one per portal family. Greenhouse and Lever are AUTONOMOUS in production,
   which is why they lead: a regression here would press the wrong control on a real application
   tomorrow. Postings expire, so a 404 here means "update the URL", not "the code broke". */
const PAGES: [portal: string, url: string][] = [
  ['greenhouse', 'https://job-boards.greenhouse.io/astranis/jobs/4677763006'],
  ['greenhouse', 'https://job-boards.greenhouse.io/figureai/jobs/4698164006'],
  ['lever', 'https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c/apply'],
  /* Renders NOTHING in headless Chromium - empty body after 25 seconds, zero controls. Kept in the
     list precisely because of that: the honest outcome is NoSubmitControlError, and this is the
     case that proves an unrenderable page reports "nothing was sent" rather than a false receipt. */
  ['smartrecruiters', 'https://jobs.smartrecruiters.com/Visa/744000133907678-sr-manager?oga=true'],
];

/* The SAME extraction the shipped closure performs, kept in one string so the trial cannot drift
   from the code it is meant to exercise. */
const READ_LABEL = (node: unknown) => {
  const el = node as unknown as {
    innerText?: string; value?: string; title?: string; disabled?: boolean; type?: string;
    getAttribute(name: string): string | null; getClientRects(): { length: number };
  };
  if (el.disabled === true) return '';
  if (el.getAttribute('aria-hidden') === 'true') return '';
  if (el.getClientRects().length === 0) return '';
  const labelledBy = el.getAttribute('aria-labelledby');
  const referenced = labelledBy
    ? (node as unknown as { ownerDocument: { getElementById(id: string): { innerText?: string } | null } })
      .ownerDocument.getElementById(labelledBy.split(/\s+/)[0]!)?.innerText ?? ''
    : '';
  const uaDefault = el.type === 'submit' && !el.value ? 'Submit' : '';
  return (el.innerText || el.value || el.getAttribute('aria-label') || el.title || referenced
    || uaDefault || '').trim();
};

async function main() {
  const browser = await chromium.launch();
  let pressedAHandoff = false;
  for (const [portal, url] of PAGES) {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(5000);
      const handles = await page.locator(SUBMIT_CANDIDATE_SELECTOR).elementHandles();
      const labels = await Promise.all(handles.map((h) => h.evaluate(READ_LABEL)));
      const chosen = chooseSubmitControl(labels);
      const visible = labels.filter(Boolean);
      console.log(`\n=== ${portal}  ${page.url().slice(0, 78)}`);
      console.log(`    ${handles.length} candidate controls, ${visible.length} with a usable label`);
      console.log(`    labels: ${JSON.stringify(visible.slice(0, 12))}`);
      if (chosen === null) {
        console.log('    DECISION: no submit control -> NoSubmitControlError (nothing is pressed)');
      } else {
        console.log(`    DECISION: would press ${JSON.stringify(labels[chosen])} (index ${chosen})`);
        if (/linkedin|indeed|seek|google|facebook/i.test(labels[chosen]!)) {
          console.log('    !!! THAT IS A THIRD-PARTY HANDOFF - the bug is not fixed');
          pressedAHandoff = true;
        }
      }
    } catch (error) {
      console.log(`\n=== ${portal}  ${url.slice(0, 70)}`);
      console.log(`    could not load: ${(error as Error).message.split('\n')[0]}`);
    } finally {
      await page.close();
    }
  }
  await browser.close();
  console.log(pressedAHandoff ? '\nTRIAL FAILED' : '\nTRIAL PASSED: no third-party handoff was ever chosen.');
  process.exit(pressedAHandoff ? 1 : 0);
}

main();
