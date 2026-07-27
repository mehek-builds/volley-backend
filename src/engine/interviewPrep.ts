import type { ResumeSpec } from '../llm/resumeSpec';
import { resumeCovers, type JdTerm } from './jdMatch';
import { BULLET_MAX_CHARS, excerpt } from './resumeValidate';

/**
 * Interview questions, derived from this posting and answered from this student's own resume.
 *
 * Every competitor ships an interview layer. AIApply, Rezi, Careerflow and Jobright all generate a
 * question list from the job title, and reviewers of each describe the output as generic, because
 * it is: a question written from "Software Engineer Intern" cannot know anything about the person
 * holding it or the posting they are answering.
 *
 * NOTHING HERE IS GENERATED. Every question is derived deterministically from a requirement the
 * posting actually states, and every answer is a bullet the student actually wrote. There is no
 * model call in this file, which is not a shortcut: an LLM asked to "write interview answers from
 * this resume" produces exactly the fabrication R-015 exists to prevent, one layer further from
 * anywhere the student would notice it. A question we derived and an answer they wrote can both be
 * checked; a paragraph a model wrote about their life cannot.
 *
 * THE GAPS ARE THE POINT. A requirement the resume does not answer becomes a question with no
 * answer attached, said plainly. That is the most useful thing this can tell someone the night
 * before: not a script, but which question is going to be the hard one.
 */

export interface PrepItem {
  /** The requirement this question comes from. */
  term: string;
  display: string;
  question: string;
  /** Where the posting asked for it, so the student can judge how likely the question is. */
  weight: number;
  /** The student's own wording that answers it, verbatim. Absent when nothing does. */
  answer?: { org: string; bullet: string };
  /** True when nothing on the resume answers the question. */
  unanswered: boolean;
}

export interface InterviewPrep {
  items: PrepItem[];
  answered: number;
  unanswered: number;
}

/**
 * One question shape, not several.
 *
 * Templates that vary ("Describe a time...", "Walk me through...", "How would you...") read as
 * variety and are noise: they change the wording of the prompt without changing what the student
 * has to be able to say. One shape, applied consistently, keeps the list scannable and keeps the
 * attention on the requirement rather than on the phrasing.
 */
/**
 * Degree phrases. WHOLE terms only.
 *
 * The first version split this list into words and dropped any term containing one, which silently
 * removed real interviewable skills: "data science", "distributed systems", "salesforce
 * administration" and "visa" (the payment network) all vanished, and vanishing is worse than being
 * asked, because a dropped requirement never shows up as a gap either. The language words are gone
 * entirely: fluency IS interviewed for, and a language a student does not have is exactly the gap
 * they most need flagged.
 *
 * This list is small now because the signal gate below does most of the work.
 */
const NOT_INTERVIEWABLE = new Set([
  'computer science',
  'information systems',
  'business administration',
  'bachelors degree',
  'masters degree',
  'degree',
  'gpa',
  'transcript',
  'citizenship',
  'sponsorship',
  'clearance',
]);

/**
 * The lowest section weight a requirement can come from and still become a question.
 *
 * 0.4 is unlabelled body prose, which is where the scorer's proper-noun long tail lives. Counting
 * such a term toward coverage is defensible; asking the student to prepare an answer about it is
 * not, and it is where the ugliest collisions surface ("payment rails" reaching the Rails lexicon
 * entry).
 */
const MIN_QUESTION_WEIGHT = 0.6;

/**
 * Is this something an interviewer would actually ask about?
 *
 * The load-bearing check is `signal`: a curated lexicon skill, an acronym, or a token carrying a
 * technical marker, as opposed to a bare capitalized word. Without it the panel asked "Tell me
 * about your experience with Chicago", "...with Growth", "...with Marketing" and "...with Engineer
 * Intern", because the scorer admits proper nouns to catch vendor names it does not enumerate.
 * That is the right bias for a gap chip and the wrong one for a question.
 */
function interviewable(term: JdTerm): boolean {
  if (term.signal !== true) return false;
  if (term.weight < MIN_QUESTION_WEIGHT) return false;
  return !NOT_INTERVIEWABLE.has(term.term);
}

/**
 * One question shape, not several.
 *
 * Templates that vary ("Describe a time...", "Walk me through...") read as variety and are noise:
 * they change the wording of the prompt without changing what the student has to be able to say.
 */
function questionFor(display: string): string {
  return `Tell me about your experience with ${display}.`;
}

const HAS_METRIC = /(\$|%|\d)/;

export function buildInterviewPrep(
  terms: JdTerm[],
  spec: ResumeSpec,
  limit = 12,
): InterviewPrep {
  const bullets = (spec.experience ?? []).flatMap((entry) =>
    (entry.bullets ?? []).map((bullet) => ({ org: entry.org, bullet })),
  );

  // Highest-weight requirements first: the question most likely to be asked is the one the posting
  // put under Requirements, and a student reading the top of this list is reading the right thing.
  const ranked = terms
    .filter(interviewable)
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));

  const used = new Set<string>();
  const items: PrepItem[] = [];

  for (const term of ranked) {
    if (items.length >= limit) break;

    // The SAME matcher the score uses, so a question marked answered is one the score also counted.
    const covering = bullets.filter(({ bullet }) => resumeCovers(bullet, term.term));

    // .find() took the FIRST bullet in resume order, so "Attended a Kubernetes meetup and read the
    // docs" beat the bullet that actually rebuilt the ingestion path, and the student walked in
    // having rehearsed their weakest evidence. Prefer a bullet not already spent on another
    // question, then one carrying a metric, then the longer one.
    const hit = [...covering].sort((a, b) => {
      const unused = Number(used.has(a.bullet)) - Number(used.has(b.bullet));
      if (unused !== 0) return unused;
      const metric = Number(HAS_METRIC.test(b.bullet)) - Number(HAS_METRIC.test(a.bullet));
      if (metric !== 0) return metric;
      return b.bullet.length - a.bullet.length;
    })[0];

    if (hit) used.add(hit.bullet);

    items.push({
      term: term.term,
      display: term.display,
      question: questionFor(term.display),
      weight: term.weight,
      // BULLET_MAX_CHARS, not 160. A legal bullet runs to 235, so a 160-char head could cut off the
      // very term the question is about and show the student a quote with no trace of it: an
      // attribution they can see is unsupported, which is the whole thing this must never do.
      answer: hit ? { org: hit.org, bullet: excerpt(hit.bullet, BULLET_MAX_CHARS) } : undefined,
      unanswered: !hit,
    });
  }

  return {
    items,
    answered: items.filter((item) => !item.unanswered).length,
    unanswered: items.filter((item) => item.unanswered).length,
  };
}
