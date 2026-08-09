export type ReferralSourceEvidence = {
  kind: 'litos_job_board' | 'employer_career_site';
  value: 'Job board' | 'Company website';
  jobId: string;
  sourceId: string;
  sourceUrl: string;
  observedAt: string;
};

const COMPANY_SITE_CLAIM = /^(?:company\s+)?(?:careers?(?:\s+(?:page|site|website))?|web\s*site|website)$/i;
const JOB_BOARD_CLAIM = /^(?:online\s+)?job\s*board$/i;

export function isCompanySiteReferralClaim(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed && COMPANY_SITE_CLAIM.test(trimmed));
}

export function isJobBoardReferralClaim(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed && JOB_BOARD_CLAIM.test(trimmed));
}

/**
 * Closed-list values that state the same acquisition fact as this packet's evidenced source.
 * No generic fallback is included because managed select actions are replayed in order and a
 * later fallback can replace an earlier truthful choice.
 */
export function referralSourceOptionCandidates(
  value: string | null | undefined,
  evidence?: ReferralSourceEvidence,
): string[] {
  const resolved = referralSourceForApplication(value, evidence);
  if (!resolved) return [];
  if (isJobBoardReferralClaim(resolved)) {
    if (evidence?.kind !== 'litos_job_board' || evidence.value !== 'Job board') return [];
    return ['Job board', 'Job Board', 'Online job board'];
  }
  if (isCompanySiteReferralClaim(resolved)) {
    if (evidence?.kind !== 'employer_career_site' || evidence.value !== 'Company website') return [];
    return [
      'Company website',
      'Company Website',
      'Company Careers Site',
      'Careers Page',
      'Career Site',
      'Careers Website',
    ];
  }
  return [resolved];
}

/** Resolve a durable default against evidence for this one application. */
export function referralSourceForApplication(
  stored: string | null | undefined,
  evidence?: ReferralSourceEvidence,
): string | undefined {
  if (evidence) {
    if (evidence.kind === 'litos_job_board' && evidence.value === 'Job board') return evidence.value;
    if (evidence.kind === 'employer_career_site' && evidence.value === 'Company website') return evidence.value;
    return undefined;
  }
  const trimmed = stored?.trim();
  if (!trimmed || isCompanySiteReferralClaim(trimmed)) return undefined;
  return trimmed;
}
