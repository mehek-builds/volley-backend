export const OUTREACH_DRAFT_TYPES = [
  'first_note',
  'follow_up',
  'thank_you',
  'referral_ask',
  'offer_stage',
] as const;

export type OutreachDraftType = typeof OUTREACH_DRAFT_TYPES[number];

export const OUTREACH_DRAFT_INSTRUCTIONS: Record<OutreachDraftType, string> = {
  first_note: 'Write the first outreach note. Introduce the applicant briefly and ask one low-friction question.',
  follow_up: 'Write a concise follow-up to a prior unanswered note. Add one useful new detail and do not guilt the recipient.',
  thank_you: 'Write a thank-you note after a conversation or interview. Be specific, appreciative, and avoid asking for a referral.',
  referral_ask: 'Write a respectful referral request. Explain fit briefly and make it easy for the recipient to decline.',
  offer_stage: 'Write an offer-stage note for a clarification or decision conversation. Stay factual, warm, and professional.',
};
