import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* THE ASHBY OPTION-READ GAP, pinned where it can regress silently.
 *
 * Application e4b0420c (OpenAI, Ashby) stopped on "One field needs a fresh read" naming the
 * required control "Applicant Arbitration Agreement Acknowledgement". Not a discovery failure - the
 * gate NAMED the control, so the DOM walk had read it - and not Litos's attestation policy either,
 * which surfaces a held consent as an answerable question rather than a metadata blocker. The cause
 * was that NO pass in this runner ever reads an Ashby control's options: managedOptionProbeTargets
 * is gated to ['greenhouse','rippling','paylocity'] and pushManagedReactSelectOptionProbeActions
 * returns early off the greenhouse family. Ashby ships its choice lists only when a menu is opened,
 * so the control reached the packet empty and blocked. The dashboard's reread button re-enters
 * prepareManaged, so every retry reproduced it: a hold with no exit.
 *
 * WHY A SOURCE TEST. prepareManaged has no executed-path coverage through the managed provider, and
 * the behaviour that matters is a join between an employer-published list and the discovered field
 * list. ashbyPublicApplication.test.ts holds the parse and the blocker-clearing behaviour with
 * executed assertions; these hold the three wiring facts that file cannot see.
 */

async function runnerSource(): Promise<string> {
  return readFile('src/routes/submissionRunner.ts', 'utf8');
}

test('the Ashby prepare path reads the employer-published form schema', async () => {
  const source = await runnerSource();
  assert.match(source, /import \{\s*ashbyPublicApplicationSchema,\s*ashbyPublicQuestionLabelKey,\s*\} from '\.\.\/lib\/ashbyPublicApplication';/);
  assert.match(
    source,
    /if \(portal === 'ashby' \|\| portal === 'controlled_ashby'\) \{[\s\S]{0,400}?ashbyPublicApplicationSchema\(applicationUrl\)/,
    'the Ashby schema read is not reached from the Ashby prepare path',
  );
  /* The read can never take the run down with it. An employer board that is slow, renamed or
   * simply not serving the form must leave the live DOM read exactly as it was. */
  assert.match(
    source,
    /ashbyPublicApplicationSchema\(applicationUrl\);[\s\S]{0,700}?\} catch \(error\) \{[\s\S]{0,300}?keeping the live DOM read/,
    'the Ashby schema read is not wrapped so a failure keeps the live DOM read',
  );
});

/* optionsComplete IS THE FIX. questionMetadataBlockerForDiscovered files missing_exact_options
 * whenever optionsComplete === false REGARDLESS of whether options are present, so a join that
 * attaches a list without clearing the flag leaves the packet blocked exactly where it was and
 * looks, from every log line, like it worked. */
test('the Ashby join marks the published list complete', async () => {
  const source = await runnerSource();
  const start = source.indexOf('const publicSchemaDiscoveredFields');
  assert.ok(start > 0, 'the Ashby join is gone');
  const join = source.slice(start, source.indexOf('const discoveredForOptionProbe', start));
  assert.match(join, /options\?\.length \? \{ \.\.\.field, options, optionsComplete: true \} : field/);
  /* The join reads whichever published schema the family's reader produced - Ashby's, or since
   * 2026-09-04 Lever's - through one `publishedSchema` pair of list and label key, so the Ashby
   * schema still reaches this exact line: the pair is built from it first. */
  assert.match(join, /publishedSchema\.optionsByLabel\[labelKey\]/);
  assert.match(
    source,
    /const publishedSchema = ashbySchema\s*\n\s*\? \{ optionsByLabel: ashbySchema\.optionsByLabel, labelKey: ashbyPublicQuestionLabelKey \}/,
    'the Ashby schema no longer feeds the published-schema join',
  );
  // Ambiguity guard: one published list is never attached to two identically labelled controls.
  assert.match(join, /publishedDiscoveredLabelCounts\.get\(labelKey\) !== 1/);
  // A list the live page already carried completely is never overwritten by the published one.
  assert.match(join, /if \(field\.options\?\.length && field\.optionsComplete !== false\) return field;/);
});

/* The join is inert unless what it produces is what the rest of the run consumes, and the split is
 * deliberate rather than incidental.
 *
 * ENRICHED, because these decide what the applicant is shown: discoveredFields feeds
 * discoverAndResolveQuestions, which is the call that turns a control with a known option list into
 * an answerable question instead of a metadata blocker, and discoveredForOptionProbe should not
 * plan a read for a list already known.
 *
 * PROVIDER-NORMALIZED, because these two report what the PROVIDER'S OWN PROBE did with a control.
 * submissionRunner.test.ts pins the second by name for that reason. Both read only label, selector
 * and input type, so enrichment could not change their output anyway; naming the unenriched list
 * keeps the reporting honest about whose measurement it is.
 *
 * Reverting discoveredFields to the unenriched list restores the original bug while every other
 * assertion in this file still passes, which is why it is asserted by name. */
test('the enriched list feeds resolution while probe-failure reporting stays provider-normalized', async () => {
  const source = await runnerSource();
  const start = source.indexOf('const publicSchemaDiscoveredFields');
  const after = source.slice(start);
  for (const enriched of [
    /const discoveredForOptionProbe = discoveredQuestionsForExactOptionProbe\(\s*publicSchemaDiscoveredFields,/,
    /const discoveredFields = attachManagedFieldOptions\(publicSchemaDiscoveredFields, fieldOptions\)/,
  ]) {
    assert.match(after, enriched, `a resolution consumer still reads the unenriched list: ${enriched}`);
  }
  for (const providerNormalized of [
    /const failedFields = normalizedDiscoveredFields\.flatMap/,
    /questionMetadataBlockersForOptionProbeFailures\(\s*portal,\s*normalizedDiscoveredFields,/,
  ]) {
    assert.match(after, providerNormalized, `probe-failure reporting no longer names the provider list: ${providerNormalized}`);
  }
});
