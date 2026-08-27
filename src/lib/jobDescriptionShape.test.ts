/* THE CALIBRATION OF THE ONE PREDICATE, INCLUDING THE CASES IT GETS WRONG.
 *
 * statesNoRequirement decides two things: whether POST /jobs/extract refuses a freshly rendered
 * page, and whether lib/packetJdRepair.ts considers a frozen packet corrupted. It is
 * leadRequirementCandidates, which is extractJdSignals' impact/hard/experience clauses filtered to
 * 12-300 characters and to clauses that ASK rather than offer.
 *
 * SWEPT ACROSS EVERY `*_JD` FIXTURE IN THIS REPOSITORY on 2026-08-26 (23 fixtures, evaluated
 * directly, no mutation of any source):
 *
 *     Gemini 12   CURLY 10   SECOND_PERSON 10   PRODUCT_INTERN 9   Deepgram 8   SWE 7
 *     TOTAL_REWARDS 6   PROSE 6   MARKETING 6   KOS 5   PsiQuantum 4   DOTNET 3   RECRUITER 3
 *     Truveta 2   FIVE_RINGS_TRADER 2
 *     ---- refused at 0 ----
 *     WORKABLE_FORM_ONLY (x2, both form fixtures)   DATABRICKS 458 chars   LITOS_QA 203 chars
 *
 * The two form fixtures refusing is the intended answer. THE OTHER TWO ARE FALSE REFUSALS on text
 * that came off real postings, and they are pinned below rather than left for somebody to
 * rediscover. Both have one cause, and it is not "the posting is bad": an ask survives only when the
 * text carries a section cue extractJdSignals recognises AND lands in a clause under 300 characters,
 * and a posting can fail either condition on its own. Both are asserted below.
 *
 * WHY THE TRADE IS STILL ACCEPTED AT INTAKE. A false refusal there costs one manual paste, and the
 * 502 says exactly that in words the operator can act on. A false acceptance costs a frozen packet
 * scored against a form, junk requirement terms drawn from dropdown options, and a gap list built
 * out of them - and nothing downstream reports it. The failures are not symmetric.
 *
 * WHY IT IS NOT ACCEPTED ALONE FOR A REPAIR. A false positive on a stored row would be a WRITE, so
 * lib/packetJdRepair.ts never acts on this predicate by itself: the replacement must come from a
 * source bound to the same posting by identifier and must itself state an ask. See its header.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { statesNoRequirement } from './jobDescriptionShape';

describe('the shapes a posting arrives in, and whether an ask survives', () => {
  const accepted: Record<string, string> = {
    /* Bulleted under headings. The overwhelmingly common Greenhouse and Ashby shape. */
    bulleted_under_headings: [
      'Requirements:',
      '- Currently pursuing a BS or MS in Computer Science, graduating in 2027 or 2028',
      '- Experience with Python and at least one systems language',
    ].join('\n'),
    /* One run-together line with no newlines at all, but with sentence punctuation. This is how
       Lever's descriptionPlain often arrives, and it is the shape most easily mistaken for junk. */
    run_together_with_sentences: "What you'll do: Build and ship a bounded project. Partner with the "
      + "founding team. They're your reviewer and your mentor. You Current CS or ML undergrad or "
      + "Master's student with a hands-on project or internship track record. Fluent in one of Python, "
      + 'TypeScript, or Go. You pick up whatever else the project needs.',
    /* Prose paragraphs under headings, no bullets anywhere. */
    prose_under_headings: [
      'Qualifications',
      'We are looking for someone pursuing a degree in computer science who has written production '
      + 'Python and is comfortable reading somebody else\'s code.',
      'Responsibilities',
      'You will own the ingestion pipeline and improve the deployment path for the whole service.',
    ].join('\n'),
    /* THE ONE THAT MUST NEVER REGRESS: the description with its own application form on the same
       page. Most Greenhouse postings are exactly this, so a predicate that keyed on the PRESENCE of
       form labels would refuse most of the traffic this route exists for. */
    description_with_its_form_inline: [
      'What we look for:',
      'Pursuing a bachelor degree in computer science, graduating in 2028',
      'You have some first hand experience with SQL and/or Python',
      'Apply for this job',
      '* Required fields',
      'First Name *',
      'Resume/CV *',
      'How did you hear about us? *',
      'Select an option',
      'Submit Application',
    ].join('\n'),
  };

  for (const [name, jd] of Object.entries(accepted)) {
    test(`accepted: ${name}`, () => assert.equal(statesNoRequirement(jd), false));
  }

  const refused: Record<string, string> = {
    /* The Workable application route, which is why jobDescriptionSourceUrl exists. */
    workable_application_form: [
      'Sales Setter / Executive',
      'Apply for this job',
      'First name *', 'Last name *', 'Email *', 'Phone', 'Resume *',
      'Are you legally authorized to work? *', 'Select an option', 'Submit application',
    ].join('\n'),
    /* The company-hosted board shape the URL rewrite cannot see: consent banner, site nav, the
       form, the footer, and the posting contributing a title and a location. */
    company_hosted_form_only: [
      'This site uses cookies and similar technologies to provide basic functionality.',
      'ACCEPT ALL', 'REJECT ALL',
      'WHO WE ARE', 'WHAT WE DO', 'OPEN ROLES', 'INTERNSHIPS',
      'Software Engineer Internship, May-August', 'New York, Summer Internship',
      '* Required fields', 'Legal first name *', 'Email confirmation *', 'Phone *',
      'Pronouns (Select one or more.)', 'she/her/hers', 'he/him/his', 'they/them/theirs',
      'How did you hear about us? *', 'Select an option', 'Submit',
    ].join('\n'),
  };

  for (const [name, jd] of Object.entries(refused)) {
    test(`refused: ${name}`, () => assert.equal(statesNoRequirement(jd), true));
  }
});

describe('the false refusals this predicate is known to have', () => {
  /* THE FIRST CLASS: a real posting written as one unbroken block with no clause boundaries.
     leadRequirementCandidates discards any clause over 300 characters as "a swallowed paragraph",
     so a posting that never terminates a sentence has every candidate discarded at once. Measured:
     the same kos.ai text WITH its sentence punctuation states 5 asks; stripped of it, 0. */
  const RUN_TOGETHER_NO_PUNCTUATION = "What you'll do Build and ship a bounded project in one of eval "
    + 'infrastructure internal ops dashboards or the agent training pipeline Partner with the founding '
    + 'team You Current CS or ML undergrad or Master student with a hands-on project or internship track '
    + 'record Fluent in one of Python TypeScript or Go You have played with LLMs agents or computer-use '
    + "workflows You're comfortable working in-person at our SF office for the whole internship";

  test('a real posting with no sentence boundaries is refused', () => {
    assert.equal(statesNoRequirement(RUN_TOGETHER_NO_PUNCTUATION), true);
  });

  /* THE SECOND CLASS: short marketing prose with no section cue at all. This is the abridged
     Databricks Product Management text from engine/jdMatch.test.ts, which that file's own comment
     calls "the same real posting ISSUE-014 was found on". It states a genuine requirement in
     English ("As a Product Management Intern you will learn...") and none of it is under a heading
     extractJdSignals recognises. */
  const PROSE_NO_HEADINGS = 'At Databricks we build the best data and AI infrastructure platform. As a '
    + "Product Management Intern you will learn how to be a successful PM. We're hiring across all of our "
    + 'teams, including AI Platform, Genie, Machine Learning, Unity Catalog, Databricks SQL, ETL, '
    + 'Streaming, and EDA. This is a 12 week paid summer internship in either San Francisco, CA, Mountain '
    + 'View, CA, or Bellevue, WA. You will prototype and test early ideas with customers using Python.';

  test('short marketing prose under no heading is refused', () => {
    assert.equal(statesNoRequirement(PROSE_NO_HEADINGS), true);
  });

  /* WHAT ACTUALLY DECIDES BOTH CASES, measured rather than assumed. An ask survives only when BOTH
     hold: the text carries a section cue extractJdSignals recognises, AND the clause it lands in is
     under MAX_REQUIREMENT_CHARS (300), since a longer one is discarded as "a swallowed paragraph".
     The Databricks text needs both - a heading alone leaves one 459-character clause, and line
     breaks alone leave clauses nothing has classified. That matters because it says the fix is not
     available here: loosening either condition means admitting short unheaded strings, which is
     exactly what an application form is a list of. */
  test('a section cue alone does not rescue it: the clause is still one 459-character paragraph', () => {
    assert.equal(statesNoRequirement(`What you will do:\n${PROSE_NO_HEADINGS}`), true);
  });

  test('clause boundaries alone do not rescue it either: nothing has classified them', () => {
    assert.equal(statesNoRequirement(PROSE_NO_HEADINGS.split('. ').join('.\n')), true);
  });

  test('both together do, which locates the cause in segmentation and not in the posting', () => {
    assert.equal(
      statesNoRequirement(`What you will do:\n${PROSE_NO_HEADINGS.split('. ').join('.\n')}`),
      false,
    );
  });
});

describe('the empty page keeps its own clearer refusal', () => {
  /* `job_extract_empty` is checked first in the route and says "That page returned no readable
     text", which is a different instruction to the operator than "that looks like a form". This
     predicate would answer true for both, so ORDER is what keeps the two messages apart. */
  test('empty text also states no requirement, so the empty check must stay ahead of it', () => {
    assert.equal(statesNoRequirement(''), true);
    assert.equal(statesNoRequirement('   \n  '), true);
  });
});
