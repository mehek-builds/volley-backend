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

/** Distinct grounded sentences in a bank row, counted the way the floor counts them. */
export function distinctGroundedVariants(bulletVariants: unknown): number {
  const variants = Array.isArray(bulletVariants) ? bulletVariants : [];
  const keys = new Set<string>();
  for (const variant of variants) {
    if (typeof variant !== 'string' || variant.trim().length === 0) continue;
    const key = resumeBulletKey(variant);
    /* A KEYLESS VARIANT CANNOT RAISE AN ENTRY OFF THE FLOOR, so it must not be counted as though
       it could. It is punctuation with no words in it, and the floor's top-up loop - the loop
       that actually decides whether a bank row can carry an entry to minBulletsPerEntry - skips
       exactly these (`if (!key || taken.has(key)) continue`). Counting one as a distinct sentence
       therefore called a row survivable that the floor is still guaranteed to drop, which is the
       overstatement this function exists to remove rather than relocate. (The floor does pass a
       keyless bullet the MODEL wrote through to its length checks; that is a different question
       from what the bank row can supply, and this counts the bank row.) */
    if (key.length === 0) continue;
    keys.add(key);
  }
  return keys.size;
}

export const RESUME_FIT_FALLBACKS = {
  maxTrimSteps: 100,
  preferredMinimumEntries: 1,
  preferredMinimumSkills: 6,
  emergencyMinimumBullets: 3,
} as const;
