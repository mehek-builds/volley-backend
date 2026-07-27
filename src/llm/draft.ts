import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ContactInput {
  full_name: string;
  title: string;
  persona: string;
  company: string;
  school_match: boolean;
  linkedin_url?: string;
}

export interface UserProfileInput {
  experience: Array<{
    company: string;
    title: string;
    start: string;
    end: string;
    description: string;
  }>;
  skills: string[];
  school: string;
  grad_year: number;
}

export interface DraftResult {
  subject: string;
  body: string;
  word_count: number;
  warnings: string[];
}

// Exported so the skills-grounding rule can be pinned by a test (R-027): the outreach half of
// R-015. The Skills line in the user content is the student's DECLARED list (the /draft route
// overrides client-supplied skills with profiles.skills), and this prompt carries the same
// never-claim-an-unheld-skill discipline resumeSpec.ts enforces for the resume.
export const SYSTEM_PROMPT = `You are an expert at writing concise, warm outreach emails that get replies.

SKILLS GROUNDING (non-negotiable): the "Skills" line is the applicant's own declared list and the
ONLY source of skill claims. NEVER state or imply a skill, tool, or technology that is not on that
list, and NEVER add one because the role or company would want it. If the role wants a tool the
list lacks, the applicant does not have it: leave it out. Omitting a skill costs nothing; claiming
one they lack costs their credibility the moment someone asks about it.

FORMAT RULES (non-negotiable):
- Email body: 100-140 words total
- Subject line: under 40 characters, value front-loaded
- Subject examples: "[Name], 15-min chat?" or "Quick question, [Name]"
- Structure: 1 sentence specific personalized context (alumni/shared tie/why-them specifically) -> 1-2 sentences relevant hook grounded in the applicant's actual experience -> 1 sentence credible why-me that shows genuine fit -> ONE low-friction CTA only
- Voice: warm, direct, human, not formal or corporate
- If alumni or school_match: LEAD with the shared school connection
- Single CTA only - use "could I ask 2 questions?" or "grab 15 min?" - never multiple asks
- No buzzwords, no flattery walls, no "I hope this email finds you well"
- Punctuation: NEVER use em dashes (—) or en dashes (–) anywhere in the subject or body. Use commas, colons, or periods instead.

OUTPUT FORMAT: Return ONLY a JSON object with keys "subject" and "body". No markdown, no explanation.`;

export async function generateDraft(
  contact: ContactInput,
  role: string,
  company: string,
  userProfile: UserProfileInput
): Promise<DraftResult> {
  const recentExperience = userProfile.experience.slice(0, 2);
  const topSkills = userProfile.skills.slice(0, 6).join(', ');
  /* The shared-school tie stays: it is the strongest hook Litos has, and it is true of
     anyone with an alma mater, not just people still enrolled. Only the noun changed,
     from "student" to "applicant", so a mid-career user does not get an email written
     in a student's voice. */
  const alumniNote = contact.school_match
    ? `IMPORTANT: Both the applicant and ${contact.full_name} attended ${userProfile.school}. Lead with this connection.`
    : '';

  const userContent = `
Contact to reach out to:
- Name: ${contact.full_name}
- Title: ${contact.title}
- Company: ${company}
- Persona: ${contact.persona}
- School match (same school as the applicant): ${contact.school_match}

Role the applicant is interested in: ${role} at ${company}

Applicant background:
- School: ${userProfile.school} (Class of '${userProfile.grad_year})
- Skills (the applicant's declared list, the only skills you may claim): ${topSkills}
- Recent experience: ${recentExperience.map((e) => `${e.title} at ${e.company} (${e.start}-${e.end}): ${e.description}`).join('; ')}

${alumniNote}

Write the outreach email JSON now.`.trim();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: userContent,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  const text = textBlock?.type === 'text' ? textBlock.text : '';

  let subject: string;
  let body: string;

  try {
    const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    const parsed = JSON.parse(cleaned) as { subject: string; body: string };
    subject = parsed.subject;
    body = parsed.body;
  } catch {
    throw new Error(`Claude returned invalid JSON for draft generation: ${text.slice(0, 200)}`);
  }

  // Deterministic post-generation checks
  const words = body.trim().split(/\s+/);
  const word_count = words.length;
  const warnings: string[] = [];

  if (word_count > 150) {
    warnings.push(`Email is ${word_count} words - aim for 100-140`);
  }

  const questionMarks = (body.match(/\?/g) || []).length;
  if (questionMarks > 1) {
    warnings.push('Multiple question marks detected - use a single CTA');
  }

  const firstName = contact.full_name.split(' ')[0];
  if (firstName && !body.toLowerCase().includes(firstName.toLowerCase())) {
    warnings.push('Contact name not found in email body - add personalization');
  }

  // Check for an explicit ask (a question or CTA keyword)
  const hasExplicitAsk = /\?|chat|call|coffee|15.?min|quick (question|ask|chat)/i.test(body);
  if (!hasExplicitAsk) {
    warnings.push('No explicit ask or CTA detected in email body');
  }

  return { subject, body, word_count, warnings };
}
