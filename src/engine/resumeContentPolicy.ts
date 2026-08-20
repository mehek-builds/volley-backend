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
  maxBulletsPerEntry: 3,
} as const;

export const RESUME_FIT_FALLBACKS = {
  maxTrimSteps: 100,
  preferredMinimumEntries: 1,
  preferredMinimumSkills: 6,
  emergencyMinimumBullets: 3,
} as const;
