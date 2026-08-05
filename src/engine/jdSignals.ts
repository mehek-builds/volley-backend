import { extractJdTerms, segmentJd, type JdContext, type JdSection } from './jdMatch';

export interface JdSignalSummary {
  hard_requirements: string[];
  preferences: string[];
  impact_examples: string[];
  experience_requirements: string[];
  tools_and_skills: string[];
  action_verbs: string[];
}

const MAX_CLAUSES = 10;
const MAX_TERMS = 18;
const MAX_VERBS = 16;

const ACTION_VERBS = new Set(
  `analyze architect build built coach collaborate communicate debug deliver design develop drive execute forecast identify implement influence integrate launch lead maintain manage mentor negotiate optimize own partner present prospect qualify resolve scale sell ship support`
    .split(/\s+/)
    .filter(Boolean),
);

const EXPERIENCE_ASK = /\b(\d+\+?\s+years?|experience (with|within|in|building|leading|managing|selling|using|working|partnering)|track record|background in|ability to|proven ability|hands[- ]on|fluency|familiarity)\b/i;
const LOGISTICS_CLAUSE = /\b(remote|hybrid|in[- ]office|office|located in|location|travel|utc[+-]?\d|timezone|authorized to work|visa|sponsorship|on[- ]call rotation)\b/i;
const NON_REQUIREMENT_CLAUSE = /\b(not all applicants|encourage (everyone|applicants)|if your career|we are always looking|a note on ai|visit our|relocation assistance|working model|culture at|benefits available|you don'?t need (to be )?(an )?ai expert|you don’t need deep ai expertise)\b/i;
const TOOL_PHRASES = [
  'Google Sheets',
  'Microsoft Excel',
  'Salesforce',
  'Tableau',
  'JIRA',
  'CLM',
  'HubSpot',
  'Gainsight',
  'Marketo',
  'Zendesk',
  'Apache Spark',
  'Spark',
  'CI/CD',
  'Node.js',
  'TypeScript',
  'JavaScript',
  'Python',
  'Kubernetes',
  'Docker',
  'AWS',
  'GCP',
  'Azure',
  'Databricks',
];
const SIGNAL_KEEP_TERMS = new Set([
  'account executives',
  'ai',
  'analytics',
  'arr',
  'aws',
  'azure',
  'b2b',
  'ci cd',
  'clm',
  'cloud',
  'computer science',
  'crm',
  'csa',
  'databricks',
  'docker',
  'excel',
  'finance',
  'fp',
  'gcp',
  'git',
  'github',
  'google sheets',
  'gtm',
  'jira',
  'javascript',
  'kotlin',
  'kubernetes',
  'meddpicc',
  'ml',
  'mysql',
  'nodejs',
  'python',
  'saas',
  'salesforce',
  'sc',
  'scala',
  'spark',
  'tableau',
  'typescript',
]);

function cleanClause(line: string): string {
  return line
    .trim()
    .replace(/^[-*•·]\s*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .trim();
}

function splitClauses(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(cleanClause)
    .filter((line) => line.split(/\s+/).filter(Boolean).length >= 4)
    .filter((line) => !NON_REQUIREMENT_CLAUSE.test(line));
}

function uniqueLimited(list: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const key = item.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function scoredClauses(sections: JdSection[], kind: JdSection['kind']): string[] {
  return sections
    .filter((section) => section.kind === kind)
    .flatMap((section) => splitClauses(section.text))
    .filter((clause) => !LOGISTICS_CLAUSE.test(clause));
}

function bodyFallbackClauses(sections: JdSection[], preferred: boolean): string[] {
  return sections
    .filter((section) => section.kind === 'body')
    .flatMap((section) => splitClauses(section.text))
    .filter((clause) => EXPERIENCE_ASK.test(clause))
    .filter((clause) => !LOGISTICS_CLAUSE.test(clause))
    .filter((clause) => (preferred ? /\b(preferred|plus|nice to have|ideally)\b/i.test(clause) : !/\b(preferred|plus|nice to have|ideally)\b/i.test(clause)));
}

function impactClauses(sections: JdSection[]): string[] {
  return sections
    .filter((section) => section.kind === 'responsibilities')
    .flatMap((section) => splitClauses(section.text))
    .filter((clause) => !LOGISTICS_CLAUSE.test(clause));
}

function actionVerbsFrom(text: string): string[] {
  const verbs: string[] = [];
  for (const match of text.matchAll(/\b[A-Za-z][A-Za-z-]*\b/g)) {
    const word = match[0].toLowerCase().replace(/ed$|ing$|s$/u, '');
    if (ACTION_VERBS.has(word)) verbs.push(word);
  }
  return uniqueLimited(verbs, MAX_VERBS);
}

function explicitToolsFrom(text: string): string[] {
  return TOOL_PHRASES.filter((tool) => {
    const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, String.raw`\s+`);
    return new RegExp(String.raw`\b${escaped}\b`, 'i').test(text);
  });
}

export function extractJdSignals(jdText: string, context?: JdContext): JdSignalSummary {
  const sections = segmentJd(jdText);
  const signalText = sections
    .filter((section) => section.weight > 0)
    .map((section) => section.text)
    .join('\n');
  const hard = scoredClauses(sections, 'required');
  const preferred = scoredClauses(sections, 'preferred');
  if (hard.length === 0 && preferred.length === 0) {
    hard.push(...bodyFallbackClauses(sections, false));
    preferred.push(...bodyFallbackClauses(sections, true));
  }
  const impact = impactClauses(sections);
  const allFitClauses = [...hard, ...preferred, ...impact];
  const tools = [
    ...explicitToolsFrom(signalText),
    ...extractJdTerms(jdText, context)
      .filter((term) => term.signal)
      .filter((term) => SIGNAL_KEEP_TERMS.has(term.term))
      .sort((a, b) => b.weight - a.weight || (b.mentions ?? 1) - (a.mentions ?? 1))
      .map((term) => term.display),
  ];

  return {
    hard_requirements: uniqueLimited(hard, MAX_CLAUSES),
    preferences: uniqueLimited(preferred, MAX_CLAUSES),
    impact_examples: uniqueLimited(impact, MAX_CLAUSES),
    experience_requirements: uniqueLimited(allFitClauses.filter((clause) => EXPERIENCE_ASK.test(clause)), MAX_CLAUSES),
    tools_and_skills: uniqueLimited(tools, MAX_TERMS),
    action_verbs: actionVerbsFrom(signalText),
  };
}
