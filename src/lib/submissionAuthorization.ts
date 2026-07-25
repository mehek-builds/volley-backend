export type SubmissionAuthorizationSource = 'standing_consent' | 'per_application_approval';

export function preparedSubmissionStatus(options: {
  safe: boolean;
  standingConsentEnabled: boolean;
}): 'needs_attention' | 'ready_for_final_approval' | 'submitting' {
  if (!options.safe) return 'needs_attention';
  return options.standingConsentEnabled ? 'submitting' : 'ready_for_final_approval';
}

export function mayClickFinalSubmit(options: {
  source: SubmissionAuthorizationSource | undefined;
  standingConsentEnabled: boolean;
}): boolean {
  if (options.source === 'per_application_approval') return true;
  return options.source === 'standing_consent' && options.standingConsentEnabled;
}
