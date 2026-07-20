export const RESUME_CONTENT_LIMITS = {
  maxEntries: 4,
  minBulletsPerEntry: 2,
  maxBulletsPerEntry: 3,
} as const;

export const RESUME_FIT_FALLBACKS = {
  maxTrimSteps: 100,
  preferredMinimumEntries: 2,
  preferredMinimumSkills: 6,
  emergencyMinimumBullets: 1,
} as const;
