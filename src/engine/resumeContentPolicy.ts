/* THE ONE PLACE BOTH RESUME GENERATORS READ, and it has to stay the one place.
 *
 * The tailored generator (llm/resumeSpec.ts, what onboarding builds with) and the base-resume
 * generator (llm/baseResume.ts, what the platform builds with) both take their bullet counts from
 * here, as do the floor enforcement in engine/resumePolicy.ts, the validator and the renderer.
 * A number typed into either prompt instead of read from here is how the two drift into being two
 * different products.
 */
export const RESUME_CONTENT_LIMITS = {
  maxEntries: 4,
  /* TWO, not three. Mehek's call 2026-08-20, from looking at a generated resume with one job on it.
   *
   * An entry that could not reach the floor was DROPPED ENTIRELY (engine/resumePolicy.ts), so a
   * student whose second job carried two bullets on their own resume lost that job from the
   * document altogether. Measured across ten real generations: every one printed a single
   * experience while the parse had found two, because every second entry had two bullets.
   *
   * Hiding a real job is worse than printing a short one. It reads as less experience than the
   * student has and opens a gap on the page that nothing explains.
   *
   * ONE IS STILL NEVER ENOUGH. A single-bullet entry looks like an afterthought and weakens the
   * page around it, which is why the floor exists at all; the student is asked to add a second
   * rather than having the entry quietly disappear. */
  minBulletsPerEntry: 2,
  /* WHAT THE MODEL SELECTS. Three is the right default: the strongest three lines of an entry are
     what a reader gets through, and asking for more up front produces filler. */
  maxBulletsPerEntry: 3,
  /* WHAT THE PAGE MAY HOLD once it turns out to be empty, and it is a different question.
   *
   * Measured on ten real generations 2026-08-20: every one filled 0.69 of the page with the
   * expansion search pinned at its maximum, leaving 222pt - over three inches - blank at the
   * bottom. Reaching the design's own 0.94 target by spacing alone would need roughly 15pt body
   * type, which is a poster rather than a resume.
   *
   * So the room gets spent on the student's OWN unused evidence instead of on air. The bank holds
   * bullets the selection did not print; a page with three inches to spare and the applicant's real
   * work sitting unused is padding with whitespace while discarding substance. Five is the ceiling
   * because a six-bullet entry stops being read.
   *
   * This is the mirror of the trimmer that already runs above it in planResumeLayout: one removes
   * the lowest-value bullet while the page overflows, the other restores the highest-value unused
   * one while the page is empty. Both stop at a measurement, neither invents anything. */
  expandedBulletsPerEntry: 5,
} as const;

/* WHAT COUNTS AS THE SAME SENTENCE, and it lives here for the same reason the counts do.
 *
 * engine/resumePolicy.ts dedupes bullets across entries on this key, so it is the key that decides
 * how many bullets an entry ACTUALLY ends up with - which is the number the floor then measures
 * against minBulletsPerEntry. Anything asking "can this entry survive the floor" has to count the
 * same way, or it answers a different question and the two rules contradict.
 *
 * They did. priorityEntryMayBeMandatory counted raw variant strings, so a bank row holding
 * "Managed the chapter budget" and "Managed the chapter budget." (a re-upload that reparsed one
 * bullet with a trailing period) counted as two, was called survivable, was made mandatory - and
 * the floor collapsed the pair to one sentence and dropped the entry, refusing the build on every
 * posting. One normalizer, asked by both. */
export function resumeBulletKey(bullet: string): string {
  return bullet.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * THE BULLETS AN ENTRY CAN ACTUALLY PRINT, given what the page has already printed.
 *
 * This is the floor's own selection, lifted out of it so the quantity has exactly ONE definition.
 * Three rules ask "how many bullets can this entry have" and each used to answer it separately,
 * and every bug in this family has been two of those answers disagreeing:
 *
 *   - enforceExperienceBulletFloor SELECTED the bullets, deduping across entries;
 *   - priorityEntryMayBeMandatory COUNTED the bank row's distinct sentences;
 *   - validateResumeSpec COUNTED the bank row's distinct sentences again.
 *
 * The earlier disagreements were about NORMALIZATION - a row holding a sentence and the same
 * sentence with a trailing period counted as two - and were closed by making the counters use
 * resumeBulletKey. The one that was left is about the PAGE, and no amount of shared normalization
 * could have closed it: the top-up below draws only on sentences an earlier entry has not already
 * used, so two bank rows sharing one sentence give the second row a ceiling of ONE bullet while
 * both counters still call it a two-sentence row.
 *
 * Reproduced 2026-09-03 against the real functions: bank rows `Alpha Partners` and `Beta Ventures`
 * share one sentence, Beta is the confirmed sparse priority. The floor keeps Beta at one bullet
 * under allowSparsePriority - so it is never DROPPED, onDropped never fires, and the dropped-entry
 * excuse the required-entry gate carries cannot help - and the validator then counts Beta's source
 * as two variants, concludes it is not genuinely sparse, and refuses every build with
 * `Beta Ventures: 1 bullet selected (min 2)`. Fail-closed, so the tailored route 422s with
 * resume_quality_hold and the base route fails its ATS gate with nothing saved, on every posting,
 * for as long as the bank rows stay as they are.
 *
 * So the honest question is not "how many distinct sentences does this row hold" but "how many can
 * this entry still print", and it is asked here, once. A caller with no page yet - the
 * survivability rule runs before anything has been generated - passes no `alreadyPrinted` set and
 * gets the page-blind answer, which for it is the correct one.
 */
export function groundedBulletsForEntry(
  /* Bullets already chosen for this entry, in the order they should print. The floor passes the
     model's selection; the validator passes what is on the page after fitting. */
  selected: readonly string[],
  /* The matched bank row's variants, unvalidated: callers read them straight off a JSON column. */
  bulletVariants: unknown,
  /* Keys printed under an EARLIER heading. A resume prints one sentence once. */
  alreadyPrinted: ReadonlySet<string> = new Set<string>(),
  /* WHERE THE TOP-UP STOPS, mirroring the floor's own break. Nothing above minBulletsPerEntry
     changes any decision taken from this, and stopping there keeps the returned list identical to
     what the floor selects rather than merely the same length. */
  topUpTo: number = RESUME_CONTENT_LIMITS.minBulletsPerEntry,
): string[] {
  const taken = new Set(alreadyPrinted);
  const bullets: string[] = [];
  for (const bullet of selected) {
    const key = resumeBulletKey(bullet);
    /* An empty key is punctuation with no words in it. It cannot be "already printed" in any
       meaningful sense and must not collapse two such bullets into one, so it is passed through to
       the caller's length checks rather than tracked. */
    if (key && taken.has(key)) continue;
    if (key) taken.add(key);
    bullets.push(bullet);
  }
  for (const variant of Array.isArray(bulletVariants) ? bulletVariants : []) {
    if (bullets.length >= topUpTo) break;
    if (typeof variant !== 'string' || variant.trim().length === 0) continue;
    const trimmed = variant.trim();
    const key = resumeBulletKey(trimmed);
    /* A KEYLESS VARIANT CANNOT RAISE AN ENTRY OFF THE FLOOR, so it is skipped rather than counted
       as though it could. (A keyless bullet the MODEL wrote is passed through above; what is
       already on the page is a different question from what the bank row can still supply, and
       this half answers the second one.) */
    if (!key || taken.has(key)) continue;
    taken.add(key);
    bullets.push(trimmed);
  }
  return bullets;
}

export const RESUME_FIT_FALLBACKS = {
  maxTrimSteps: 100,
  preferredMinimumEntries: 1,
  preferredMinimumSkills: 6,
  emergencyMinimumBullets: 3,
} as const;
