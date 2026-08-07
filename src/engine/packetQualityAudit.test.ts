import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJdTerms } from './jdMatch';

/**
 * PACKET QUALITY AUDIT, 2026-08-08.
 *
 * Every fixture below is a verbatim excerpt from spec._review.jd_text on a real packet generated
 * for user a18f774b-a306-4804-93f3-cd6020c27fb3. Each case is a colour the review screen paints
 * that the posting does not support: an amber "your resume does not mention this" beside a word
 * the employer never asked for.
 *
 * These tests are expected to FAIL on origin/main. They encode the defects, not the behaviour.
 *
 * The bar they hold this file to is the one its own header sets: the missing list "is not just
 * displayed: it is the input to the gap-to-bullet feature, which would have offered to write the
 * student a resume bullet about Bob Smith."
 */

const AKUNA = { company: 'Akuna Capital', role: 'Software Engineer Intern' };

const terms = (jd: string, ctx = AKUNA) => extractJdTerms(jd, ctx).map((t) => t.term);
const displays = (jd: string, ctx = AKUNA) => extractJdTerms(jd, ctx).map((t) => t.display);

describe('packet audit: a requirement invented by the scraper', () => {
  /**
   * Packet 213674e2, Akuna "Software Engineer Intern - C# .NET Desktop". The scrape lost the space
   * in "Understanding of .NET Framework", so the line reads "Understanding of.NET Framework".
   *
   * tokenizeSection's word pattern admits "." INSIDE a token, so it takes the whole run "of.NET"
   * as one token; normalizeTerm then DELETES the dot, giving the key `ofnet`, which carries a
   * TECH_MARKER and is therefore promoted to HARD SIGNAL. The bigram pass pairs it with the next
   * word and the student is shown, in amber, the requirement "of.NET Framework".
   *
   * Two things are wrong at once and the second is the worse one: `.NET`, the single named
   * technology in the title of the job, is never extracted at all, so the one requirement this
   * posting is about cannot be scored, coloured, or turned into a gap bullet.
   */
  const DOTNET_JD = `Requirements:
Pursuing a Bachelors, Masters, or Ph.D. in Computer Science
Understanding of.NET Framework and C# programming language
Experience with WinForms/WPF and Git
`;

  test('packet 213674e2: "of.NET Framework" is not a technology and must not be a requirement', () => {
    assert.ok(
      !displays(DOTNET_JD).includes('of.NET Framework'),
      `an English preposition glued to a product name reached the missing list: ${JSON.stringify(displays(DOTNET_JD))}`,
    );
  });

  test('packet 213674e2: the .NET requirement the job is named after is extracted', () => {
    const extracted = terms(DOTNET_JD);
    assert.ok(
      extracted.some((t) => t === 'net' || t === 'net framework' || t === 'dotnet'),
      `.NET is the subject of this posting and appears nowhere in ${JSON.stringify(extracted)}`,
    );
  });
});

describe('packet audit: amber on words the posting never asked for', () => {
  /**
   * Packet cc9d695d, Akuna "Software Engineer Intern - Python, Summer 2027". Five of the twelve
   * requirements this posting contributed came from prose that is not a requirement at all, and
   * the student was told their resume "does not mention" every one of them.
   *
   * The lines are quoted verbatim. What each one actually is:
   *
   *   react     the VERB, in "Ability to react quickly ... to rapidly changing market conditions".
   *             isSpecific consults inLexicon BEFORE the lowercase-evidence rule, so a lexicon
   *             skill spelled as an ordinary English word always wins, and the posting writing it
   *             in lowercase - the exact signal lowercaseTokens exists to read - counts for nothing.
   *   resumes   the application instruction, "Resumes must be submitted in PDF format."
   *   pdf       the same sentence. A file format is not a skill.
   *   major     the GPA line, "Major GPA of 3.5 or above".
   *   legal     work authorization, "Legal authorization to work in the U.S. is required".
   *
   * All five are `kind: 'required'` at weight 1, so they are not merely displayed: they depress the
   * score, they take slots under EMPHASIS_LIMIT, and they are the input to gap-to-bullet.
   */
  const PROSE_JD = `Qualifications:
Currently pursuing a Bachelors, Masters, or Ph.D. in Computer Science or a related technical field
Major GPA of 3.5 or above
Legal authorization to work in the U.S. is required on the first day of employment including F-1 students using OPT or STEM
Strong programming skills in Object-Oriented Python Development
Ability to react quickly and accurately to rapidly changing market conditions, including the ability to quickly and accurately respond and/or solve math and coding problems, is an essential function of the role
**Resumes must be submitted in PDF format.
`;

  test('packet cc9d695d: the verb "react" is not the React library', () => {
    assert.ok(
      !terms(PROSE_JD).includes('react'),
      'the posting writes "react" in lowercase, as a verb, and the student is shown React in amber',
    );
  });

  test('packet cc9d695d: submission instructions are not requirements', () => {
    const extracted = terms(PROSE_JD);
    assert.deepEqual(
      extracted.filter((t) => t === 'resumes' || t === 'pdf'),
      [],
      '"Resumes must be submitted in PDF format" is how to apply, not what to have done',
    );
  });

  test('packet cc9d695d: the GPA line and the work-authorization line are not requirements to put on a resume', () => {
    const extracted = terms(PROSE_JD);
    assert.deepEqual(
      extracted.filter((t) => t === 'major' || t === 'legal'),
      [],
      '"Major GPA" and "Legal authorization" are eligibility, and neither is a term a resume can cover',
    );
  });

  test('packet cc9d695d: Python, the subject of the posting, still survives all of the above', () => {
    // Guard, so a fix for the four tests above cannot be a blanket tightening that also loses the
    // one requirement the posting is actually about.
    assert.ok(terms(PROSE_JD).includes('python'));
  });
});
