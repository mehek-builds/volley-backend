type EvidenceProfile = {
  experience?: Array<{ company?: string; title?: string; description?: string }>;
  skills?: string[];
  projects?: Array<{ name?: string; role?: string; description?: string }>;
  leadership?: Array<{ organization?: string; title?: string; description?: string }>;
  school?: string;
  degree?: string;
  major?: string;
  coursework?: string[];
  objective?: string;
};

const GENERIC_ROLE_WORDS = new Set([
  'associate', 'assistant', 'coordinator', 'director', 'engineer', 'intern', 'junior',
  'lead', 'manager', 'officer', 'senior', 'specialist', 'technician',
]);

const DOMAIN_SIGNALS: Array<{ role: RegExp; evidence: RegExp }> = [
  { role: /software|developer|frontend|back.?end|full.?stack|devops|site reliability|mobile|ios|android|cyber/i, evidence: /software|develop|program|frontend|back.?end|full.?stack|typescript|javascript|python|java|c\+\+|react|node|api|docker|kubernetes|cloud|cyber/i },
  { role: /data|machine learning|artificial intelligence|\bai\b|analytics|business intelligence/i, evidence: /data|analytics|machine learning|statistics|sql|pandas|tensorflow|pytorch|tableau|power bi|econometric/i },
  { role: /nurs|clinical|health|medical|patient|physician|therap|pharmac|care/i, evidence: /nurs|clinical|health|medical|patient|hospital|physician|therap|pharmac|care/i },
  { role: /financ|investment|bank|quant|trader|account/i, evidence: /financ|investment|bank|economics|account|trading|portfolio|valuation/i },
  { role: /film|media|video|producer|content/i, evidence: /film|media|video|production|content|journal|broadcast/i },
  { role: /civil|structural|construction|architect/i, evidence: /civil|structural|construction|architect|infrastructure/i },
  { role: /fashion|apparel|textile|stylist/i, evidence: /fashion|apparel|textile|garment|styling/i },
  { role: /astronaut|aerospace|space|satellite|rocket/i, evidence: /astronaut|aerospace|space|satellite|rocket|nasa/i },
  { role: /mechanical|hardware|robot|embedded|electrical|manufactur/i, evidence: /mechanical|hardware|robot|embedded|electrical|manufactur|firmware|cad/i },
  { role: /research|scientist|laboratory|\blab\b/i, evidence: /research|scientist|laboratory|\blab\b|publication|thesis|experiment/i },
  { role: /product|program manager|business analyst/i, evidence: /product|roadmap|user research|stakeholder|requirements|program management/i },
  { role: /design|\bux\b|\bui\b|visual/i, evidence: /design|figma|\bux\b|\bui\b|visual|prototype/i },
  { role: /marketing|growth|brand|social media/i, evidence: /marketing|growth|brand|campaign|social media|seo/i },
  { role: /sales|account executive|business development|customer success|partnership/i, evidence: /sales|account executive|business development|customer success|partnership|revenue/i },
  { role: /legal|law|attorney|paralegal/i, evidence: /legal|law|attorney|court|litigation|policy/i },
  { role: /environment|climate|sustainab/i, evidence: /environment|climate|sustainab|ecology|conservation|energy/i },
  { role: /teacher|education|curriculum|academic advisor/i, evidence: /teach|taught|education|curriculum|tutor|student|academic/i },
  { role: /operations|supply chain|logistics/i, evidence: /operations|supply chain|logistics|inventory|process/i },
  { role: /human resources|recruit|people operations/i, evidence: /human resources|recruit|talent|people operations/i },
];

function evidenceText(profile: EvidenceProfile, rawResumeText = ''): string {
  return [
    rawResumeText,
    ...(profile.experience ?? []).flatMap((entry) => [entry.company, entry.title, entry.description]),
    ...(profile.skills ?? []),
    ...(profile.projects ?? []).flatMap((entry) => [entry.name, entry.role, entry.description]),
    ...(profile.leadership ?? []).flatMap((entry) => [entry.organization, entry.title, entry.description]),
    profile.school,
    profile.degree,
    profile.major,
    profile.objective,
    ...(profile.coursework ?? []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function distinctiveTokens(role: string): string[] {
  return role
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(' ')
    .filter((token) => token.length > 2 && !GENERIC_ROLE_WORDS.has(token));
}

function evidenceTokens(value: string): string[] {
  return value
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(' ')
    .filter((token) => token.length > 2);
}

function sharesDistinctiveStem(roleToken: string, evidenceToken: string): boolean {
  if (roleToken === evidenceToken) return true;
  // Open-domain careers often change suffix between the field and the practitioner:
  // economics/economist, chemistry/chemist, biology/biologist, psychology/psychologist.
  // A five-character shared stem handles those without maintaining an impossible job-title list.
  return roleToken.length >= 5
    && evidenceToken.length >= 5
    && roleToken.slice(0, 5) === evidenceToken.slice(0, 5);
}

export function unsupportedTargetRoles(
  roles: string[],
  profile: EvidenceProfile,
  rawResumeText = '',
): string[] {
  const evidence = evidenceText(profile, rawResumeText);
  const evidenceWords = evidenceTokens(evidence);
  return roles.filter((role) => {
    const tokens = distinctiveTokens(role);
    const hasStemEvidence = tokens.some((token) =>
      evidenceWords.some((word) => sharesDistinctiveStem(token, word)),
    );
    const matchingDomains = DOMAIN_SIGNALS.filter((domain) => domain.role.test(role));
    if (matchingDomains.length > 0) {
      return !matchingDomains.some((domain) => domain.evidence.test(evidence)) && !hasStemEvidence;
    }
    return tokens.length === 0 || !hasStemEvidence;
  });
}
