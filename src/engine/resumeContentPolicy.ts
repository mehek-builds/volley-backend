export const RESUME_CONTENT_LIMITS = {
  maxEntries: 4,
  minBulletsPerEntry: 3,
  maxBulletsPerEntry: 3,
} as const;

export const RESUME_FIT_FALLBACKS = {
  maxTrimSteps: 100,
  preferredMinimumEntries: 1,
  preferredMinimumSkills: 6,
  emergencyMinimumBullets: 3,
} as const;
