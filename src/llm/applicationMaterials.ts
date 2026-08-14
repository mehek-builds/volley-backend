import Anthropic from '@anthropic-ai/sdk';
import { COVER_LETTER_SYSTEM_PROMPT, escapeRawControlCharacters } from './coverLetter';
import { SYSTEM_PROMPT as APPLICATION_ANSWER_SYSTEM_PROMPT } from './applicationAnswer';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type CompactMaterialQuestion = {
  id: string;
  question: string;
  ranking_rule?: string;
};

export type CompactApplicationMaterials = {
  coverLetter?: string;
  answers: Map<string, string>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
};

function bundledRules(): string {
  const coverRules = COVER_LETTER_SYSTEM_PROMPT
    .replace('You write highly tailored cover letters for real job applications.', 'Cover letter rules:')
    .replace('Return only JSON: {"body": string}.', '');
  const answerRules = APPLICATION_ANSWER_SYSTEM_PROMPT
    .replace('You draft a first-person answer to ONE job-application question for an applicant.', 'Application answer rules:')
    .replace('No preamble, no "Here\'s my answer", no quotes around it. Output ONLY the answer text.', 'No preamble and no quotes around an answer.');
  return `Create one coherent application-material packet.\n\n${coverRules}\n\n${answerRules}\n\nReturn only valid JSON with this exact shape:\n{"cover_letter": string | null, "answers": [{"id": string, "answer": string}]}\nEvery requested id must appear exactly once. Never add an id that was not requested.`;
}

function parseCompactMaterials(raw: string, requestedIds: ReadonlySet<string>): CompactApplicationMaterials {
  const unfenced = raw.replace(/^\s*```(?:json)?\s*/m, '').replace(/```\s*$/m, '');
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  const candidate = first >= 0 && last > first ? unfenced.slice(first, last + 1) : unfenced;
  let parsed: unknown;
  for (const attempt of [candidate, escapeRawControlCharacters(candidate)]) {
    try {
      parsed = JSON.parse(attempt);
      break;
    } catch {
      // Try the control-character repair before failing honestly below.
    }
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Claude returned an invalid compact application packet');
  const object = parsed as { cover_letter?: unknown; answers?: unknown };
  const answers = new Map<string, string>();
  if (!Array.isArray(object.answers)) throw new Error('Claude omitted the compact application answers array');
  for (const item of object.answers) {
    if (!item || typeof item !== 'object') continue;
    const value = item as { id?: unknown; answer?: unknown };
    if (typeof value.id !== 'string' || !requestedIds.has(value.id)) continue;
    if (typeof value.answer !== 'string' || answers.has(value.id)) continue;
    answers.set(value.id, value.answer.trim());
  }
  for (const id of requestedIds) {
    if (!answers.has(id)) throw new Error(`Claude omitted compact application answer ${id}`);
  }
  return {
    coverLetter: typeof object.cover_letter === 'string' && object.cover_letter.trim()
      ? object.cover_letter.trim()
      : undefined,
    answers,
  };
}

/** One Sonnet call for the artifacts that can only be known after the employer form is opened. */
export async function generateCompactApplicationMaterials(input: {
  company: string;
  role: string;
  jdText: string;
  candidateSource: string;
  contestedMetrics?: string[];
  includeCoverLetter: boolean;
  questions: CompactMaterialQuestion[];
}): Promise<CompactApplicationMaterials> {
  const requestedIds = new Set(input.questions.map((question) => question.id));
  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    // This is a ceiling, not a reservation. A normal packet is billed only for the tokens emitted.
    max_tokens: 16384,
    system: [{ type: 'text', text: bundledRules() }],
    messages: [{
      role: 'user',
      content: `Role: ${input.role}\nCompany: ${input.company}\n\nJob description:\n${input.jdText}\n\nCandidate source, the only authority for candidate claims:\n${input.candidateSource}${
        input.contestedMetrics?.length
          ? `\n\nDo not use these contested figures because the source attributes each to more than one employer or project: ${input.contestedMetrics.join(', ')}.`
          : ''
      }\n\nCover letter requested: ${input.includeCoverLetter ? 'yes' : 'no, return null'}\n\nApplication questions:\n${JSON.stringify(input.questions)}`,
    }],
  });
  const block = response.content.find((item) => item.type === 'text');
  const text = block?.type === 'text' ? block.text : '';
  if (response.stop_reason === 'max_tokens') throw new Error('Compact application packet was truncated at max_tokens');
  return {
    ...parseCompactMaterials(text, requestedIds),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
    },
  };
}
