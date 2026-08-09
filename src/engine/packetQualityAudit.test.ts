import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJdTerms, scoreJdMatch, MIN_SCORABLE_TERMS } from './jdMatch';

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

/**
 * Packet cc9d695d, Akuna "Software Engineer Intern - Python, Summer 2027".
 *
 * AT MODULE SCOPE, not inside the describe below, because the recall block at the foot of this file
 * asserts against the same six lines. One fixture, read by both directions, so a change cannot pass
 * one block against a fixture the other block no longer shares.
 */
const PROSE_JD = `Qualifications:
Currently pursuing a Bachelors, Masters, or Ph.D. in Computer Science or a related technical field
Major GPA of 3.5 or above
Legal authorization to work in the U.S. is required on the first day of employment including F-1 students using OPT or STEM
Strong programming skills in Object-Oriented Python Development
Ability to react quickly and accurately to rapidly changing market conditions, including the ability to quickly and accurately respond and/or solve math and coding problems, is an essential function of the role
**Resumes must be submitted in PDF format.
`;

describe('packet audit: amber on words the posting never asked for', () => {
  /**
   * Five of the twelve
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
   *
   * THE FIXTURE ITSELF IS AT MODULE SCOPE. The recall block at the foot of this file reads it too:
   * the same six lines that state `react` as a verb also state "Ph.D. in Computer Science" as a real
   * requirement, and the two blocks have to be looking at one string for that tension to mean
   * anything. See the note above that block.
   */

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

describe('packet audit: generic company prose does not displace real posting requirements', () => {
  test('Cloudflare mission prose does not make "Internet" a resume requirement', () => {
    const jd = `About Us
At Cloudflare, we are on a mission to help build a better Internet.
Fundamental to our mission is protecting the free and open Internet.

Desirable Skills, Knowledge and Experience
Technologies include: Typescript/Javascript, Go, Rust, C/C++ and Python.
`;
    const extracted = terms(jd, { company: 'Cloudflare', role: 'Software Engineer Intern' });
    assert.ok(!extracted.includes('internet'), 'company mission prose reached the colored requirements');
    for (const technology of ['typescript', 'javascript', 'rust', 'c++', 'python']) {
      assert.ok(extracted.includes(technology), `the concrete requirement "${technology}" was lost`);
    }
  });

  test('Flow Traders keeps Excel when the employer explicitly requires proficiency in it', () => {
    const jd = `What You Need to Succeed
Excellent mental math, quantitative and analytical skills
Proficiency in Excel and an affinity for scientific programming or development languages
`;
    assert.ok(
      terms(jd, { company: 'Flow Traders', role: 'Quantitative Trading Intern' }).includes('excel'),
      'an explicit Excel proficiency requirement must remain colorable',
    );
  });

  test('hyphenated requirement phrases stay normalized and preserve the posting spelling', () => {
    const jd = `Preferred Qualifications
Hands-on exposure to real-time systems and open-source contributions.
`;
    const extracted = extractJdTerms(jd, { company: 'Deepgram', role: 'Software Engineer Intern' });
    const byTerm = new Map(extracted.map((term) => [term.term, term.display]));
    assert.equal(byTerm.get('real time systems'), 'real-time systems');
    assert.equal(byTerm.get('open source'), 'open-source');
  });
});


/**
 * THE OTHER DIRECTION, AND IT IS THE SAME FILE ON PURPOSE.
 *
 * Everything above this line is a term the extractor admitted that the posting never asked for.
 * Everything below is a term the posting DID ask for that the extractor never admitted. The two
 * pull against each other: every fix for one is a candidate defect in the other, and the cheapest
 * wrong move available to anyone editing jdMatch.ts is to loosen the guard that PROSE_JD pins in
 * order to pass the fixtures below. That does not work and is not what was done. Verified by
 * mutation on 2026-08-08: forcing the `afterVerbMarker` guard in isSpecific never to fire changes
 * the extracted set on neither DEEPGRAM_JD nor TRUVETA_JD by a single term.
 *
 * If you are here because one of these tests failed, read the other block first.
 */
describe('packet audit: a posting full of requirements that scores nothing at all', () => {
  /**
   * Packets 245c827a (Deepgram) and fa354c82 (Truveta), both generated 2026-08-06 for the same
   * owner account. Measured against the shipped scorer on 2026-08-08, both came back
   *
   *   scorable: false, "This posting does not list enough specific requirements to score against.
   *                     Nothing is wrong with your resume."
   *
   * on 4,624 and 4,110 characters of software engineering job description. An unscorable packet
   * renders with no colour coding at all: no match score, no covered blue, no missing amber. The
   * product's central promise is invisible on that application, and the message is a lie about a
   * posting that names its requirements plainly.
   *
   * NEITHER IS AN UPSTREAM SCRAPE FAILURE, which is the first thing to suspect on a 4.6k posting
   * that "lists no requirements". segmentJd reads both correctly: Deepgram's "Minimum Skills,
   * Knowledge & Capabilities:" is classified `required` and its "Preferred Qualifications:" is
   * classified `preferred`; Truveta's "Preferred Qualifications" is classified `preferred`. The
   * blocks are found. They are found and then they yield almost nothing, because of what is in
   * them:
   *
   *   Deepgram, preferred:  "a degree in computer science"
   *                         "exposure to machine learning, real-time systems, or audio/speech
   *                          processing"
   *                         "self-study, open source, or your own projects"
   *                                                        -> extracted: NOTHING. 
   *   Deepgram, required:   seven second-person bullets     -> extracted: `ai`, `automations`.
   *   Truveta, preferred:   "Java, Python,.net, C#"         -> extracted: java, python, c#.
   *                         "engineering, computer science or STEM related field"
   *                                                        -> extracted: NOTHING.
   *
   * Two terms and three terms, against a floor of MIN_SCORABLE_TERMS = 4. See PHRASE_LEXICON for
   * why a sentence-case phrase was unreachable and a Title Case one was not.
   */
  // Verbatim spec._review.jd_text from packet 245c827a-daaa-463a-8026-04f89d6a69eb. The em dash and
  // the curly apostrophes are the posting’s own; \u2014 is written escaped so the file carries no
  // literal em dash, and the length assertion below is what keeps the fixture honest if an editor
  // ever reformats it.
  const DEEPGRAM_JD = `COMPANY OVERVIEW

Deepgram is the leading platform underpinning the emerging trillion-dollar Voice AI economy, providing real-time APIs for speech-to-text (STT), text-to-speech (TTS), and building production-grade voice agents at scale. More than 200,000 developers and 1,300+ organizations build voice offerings that are ‘Powered by Deepgram’, including Twilio, Cloudflare, Sierra, Decagon, Vapi, Daily, Cresta, Granola, and Jack in the Box. Deepgram’s voice-native foundation models are accessed through cloud APIs or as self-hosted and on-premises software, with unmatched accuracy, low latency, and cost efficiency. Backed by a recent Series C led by leading global investors and strategic partners, Deepgram has processed over 50,000 years of audio and transcribed more than 1 trillion words. There is no organization in the world that understands voice better than Deepgram.




COMPANY OPERATING RHYTHM

At Deepgram, we expect an AI-first mindset\u2014AI use and comfort aren’t optional, they’re core to how we operate, innovate, and measure performance.

Every team member who works at Deepgram is expected to actively use and experiment with advanced AI tools, and even build your own into your everyday work. We measure how effectively AI is applied to deliver results, and consistent, creative use of the latest AI capabilities is key to success here. Candidates should be comfortable adopting new models and modes quickly, integrating AI into their workflows, and continuously pushing the boundaries of what these technologies can do.

Additionally, we move at the pace of AI. Change is rapid, and you can expect your day-to-day work to evolve just as quickly. This may not be the right role if you’re not excited to experiment, adapt, think on your feet, and learn constantly, or if you’re seeking something highly prescriptive with a traditional 9-to-5.



Note: Hiring for Fall 2026 and Summer 2027 cohorts

Team Overview

You'd join the engineering team building the voice-native foundation models and the platform that delivers them at production scale: real-time ASR, next-generation TTS, and LLM connectivity. As an intern, you won't be sidelined on throwaway work, you'll own a real project and see firsthand how research, engineering, and customers actually fit together.



Key Goals:

 - Design, build, and ship one scoped project end to end, from design through reviewed, tested code running in staging or production, with a dedicated mentor guiding you at each milestone

 - Contribute directly to a production Deepgram codebase, whether that's the core voice AI platform, the Applied AI wing (Deepgram for Restaurants), or the consumer wing, landing merged PRs that teammates and customers actually use

 - Dig into voice AI: speech and audio ML, real-time systems, and how research, engineering, and customers form one feedback loop

 - Use Agentic tooling (Claude Code, Codex, whatever you want!!) as a default part of how you prototype, test, and debug, and bring at least one workflow improvement back to the team

Minimum Skills, Knowledge & Capabilities:

 - You've built things because you wanted them to exist: projects, tools, scripts, or automations, whether in class, on your own, or in a prior role.

 - You reach for AI as a default part of how you learn and build, not an occasional add-on, and you can talk about where it helps and where human judgment still has to lead.

 - You reason from first principles: when something breaks, you dig into why rather than patching around it.

 - You write and read code in at least one language, and you pick up new languages, tools, and codebases quickly.

 - You can explain your work clearly: what you built, what broke, and what you'd do differently.

 - You treat "good enough" as a question, not a finish line, and you're drawn to hard problems.

 - You give and receive feedback well and want to get better fast.

Preferred Qualifications:

 - Currently pursuing a degree in computer science, engineering, or a related field, or building equivalent skills through self-study, open source, or your own projects.

 - Coursework or hands-on exposure to machine learning, real-time systems, or audio/speech processing.

 - A prior internship, a hackathon project, or something you built and shipped for yourself, ideally with an AI-assisted workflow behind it.






Notice: We're aware of individuals impersonating Deepgram recruiters. All legitimate Deepgram recruiting communication comes from an @deepgram.com http://deepgram.com email address. If you've received a message claiming to be Deepgram, please forward it to careers@deepgram.com.`;

  // Verbatim spec._review.jd_text from packet fa354c82-0cea-4bef-8595-7bcda8d7c0bc. This scrape
  // carries trailing spaces on 25 lines and a narrow no-break space (\u202f, written escaped) inside
  // "Truveta’ s ambitious vision". Both are load-bearing: they are what the extractor actually sees.
  const TRUVETA_JD = `Software Engineering Intern 

Truveta is the world’s first health provider led data platform with a vision of Saving Lives with Data. Our mission is to enable researchers to find cures faster, empower every clinician to be an expert, and help families make the most informed decisions about their care. Achieving Truveta’ s ambitious vision requires an incredible team of talented and inspired people with a special combination of health, software and big data experience who share our company values. 

This role will be based in the Greater Seattle area and interns are asked to come into our office several days per week. #LI-hybrid 

Who We Need 

Truveta is rapidly building a talented and diverse team to tackle complex health and technical challenges. Beyond core capabilities, we are seeking problem solvers, passionate and collaborative teammates, and those willing to roll up their sleeves while making a difference.\u202fIf you are interested in the opportunity to pursue purposeful work, join a mission-driven team, and build a rewarding career while having fun, Truveta may be the perfect fit for you. 

Internship Details 

Our Engineering Internship is designed for students pursuing an undergraduate or graduate degree. Candidates must be a sophomore, junior, or senior in college, enrolled in a graduate program, or have graduated within the past year. 

The internship is a minimum 10-week experience, with opportunities to extend based on company needs and mutual interest. 

This Opportunity: 

We have exciting internship opportunities for undergraduate and graduate level students inspired by the opportunity to apply data in the development of real-world health solutions. As a Truveta intern, you will work alongside technology leaders possessing deep technical experience, helping to build real-world intelligence that is unlocking breakth rough di scoveries and transforming medicine with unprecedented data and predictive AI. 

Beyond core capabilities, we are seeking problem solvers, passionate and collaborative teammates who are interested in working on meaningful and impactful projects that make a difference.\u202f 

Preferred Qualifications 

Experience using Java, Python,.net, C# or any other programming language 
Currently pursuing bachelors' or masters' in engineering, computer science or STEM related field 
Demonstrated skill in time management and completing projects in a collaborative team environment 
Previous internship experience working in a technical or engineering environment 
Good written and verbal communication, including presentation skills 

Why Truveta? 

Be a part of building something special. Now is the perfect time to join Truveta. We have strong, established leadership with decades of success. We are well-funded. We are building a culture that prioritizes people and their passions across personal, professional and everything in between. Join us as we build an amazing company together. 

We offer: 

Compensation of \$20 per hour 
Company-issued laptop and equipment 
Opportunities for future full-time positions 

If you are based in California, we encourage you to read this important information for California residents linked here. 

Truveta is committed to creating a diverse, inclusive, and empowering workplace. We believe that having employees, interns, and contractors with diverse backgrounds enables Truveta to better meet our mission and serve patients and health communities around the world. We recognize that opportunities in technology historically excluded and continue to disproportionately exclude Black and Indigenous people, people of color, people from working class backgrounds, people with disabilities, and LGBTQIA+ people. We strongly encourage individuals with these identities to apply even if you don’t meet all of the requirements. 

Please note that all applicants must be authorized to work in the United States for any employer as we are unable to sponsor work visas or permits (e.g. F-1 OPT, H1-B) at this time. We appreciate your interest in the position and encourage you to explore future opportunities with us.`;

  // Verbatim spec._review.jd_text from packet 7364ea5a-f261-4e9e-8430-91ca702d45d4.
  const FIVE_RINGS_TRADER_JD = `About Five Rings 

Five Rings is a proprietary trading firm founded with a vision of combining strategy, innovation and technology to succeed in today’s global markets. With offices in New York, Boca Raton, London and Amsterdam, Five Rings trades in various domestic and international markets, both established and esoteric. Our team constantly seeks new opportunities, analyzes their risks and rewards, and creates strategies and tools to capitalize on them. 

We have an open culture and encourage the flow of knowledge and ideas between all areas of the firm. 

About the Program 

Five Rings offers an intensive 9 week summer internship program that runs from the beginning of June through the beginning of August. The program includes immersion in hands-on projects, classroom instruction, in-house built strategy games, and mock trading. Interns will work closely with the trading team on research and development projects. You’ll be mentored by full-time traders during the internship. 

You will take part in a series of talks to introduce you to key trading concepts. We also offer a variety of activities such as strategic game nights, nights out in NY, dinners, and so much more. 

While the internship takes place in New York, students outside of the U.S are eligible to apply.

About You 

Graduating in winter of 2027 or spring/summer of 2028 
Quantitatively-focused 
Thrive in a highly collaborative and fast-paced environment 
Quick learner 
Intellectually curious 
Detail-oriented 
Self starter 

Annual Base Salary: \$300,000. Additionally, interns receive a sign on bonus and corporate housing.

Applicants are able to apply to multiple positions, but we strongly encourage you to only apply to your top choice.`;

  /**
   * A real CS undergraduate resume, trimmed to the lines that decide these assertions. The point of
   * these tests is scorability and which requirements are named, never the number itself, so this
   * only has to be a resume the scorer can honestly run against.
   */
  const CS_RESUME = `Mehek Mandal
University of Southern California, Bachelor of Science in Computer Science
Skills: Python, TypeScript, React, PostgreSQL, Docker, Git
Projects: shipped an open source CLI; built a speech processing pipeline in PyTorch
`;

  const DEEPGRAM = {
    company: 'Deepgram',
    role: 'Software Engineering- Internship (Fall 2026/Summer 2027)',
    location: 'USA | Remote',
  };
  const TRUVETA = { company: 'truveta', role: 'Software Engineering Intern', location: 'Seattle, WA' };
  const FIVE_RINGS = {
    company: 'Five Rings',
    role: 'Summer Intern 2027 - Quantitative Trader',
    location: 'New York',
  };

  test('the fixtures are the packets, character for character', () => {
    // These are pasted scrapes. Trailing spaces and escaped code points are easy to lose to a
    // reformat, and losing them would quietly stop these tests reproducing the packets they name.
    assert.equal(DEEPGRAM_JD.length, 4624);
    assert.equal(TRUVETA_JD.length, 4110);
    assert.equal(FIVE_RINGS_TRADER_JD.length, 1729);
  });

  test('packet 245c827a: Deepgram scores at all', () => {
    const result = scoreJdMatch(CS_RESUME, DEEPGRAM_JD, DEEPGRAM);
    assert.equal(
      result.scorable,
      true,
      `4,624 characters of software engineering requirements, and the review screen shows no colour: ${result.reason}`,
    );
    assert.equal(result.reason, undefined);
    assert.ok(result.term_count >= MIN_SCORABLE_TERMS);
  });

  test('packet 245c827a: the requirements Deepgram states are extracted by name', () => {
    const extracted = terms(DEEPGRAM_JD, DEEPGRAM);
    for (const stated of ['computer science', 'machine learning', 'open source']) {
      assert.ok(
        extracted.includes(stated),
        `Preferred Qualifications names "${stated}" and it is absent from ${JSON.stringify(extracted)}`,
      );
    }
  });

  test('packet 245c827a: scoring it does not mean scoring the company overview', () => {
    // The 1,000-character COMPANY OVERVIEW block names nine customers. It is `body`, the posting has
    // a primary fit section, and preferStatedRequirements is what keeps it out. Pinned here because
    // the tempting wrong fix for the test above is to widen what counts as a requirement source.
    const extracted = terms(DEEPGRAM_JD, DEEPGRAM);
    for (const customer of ['twilio', 'cloudflare', 'sierra', 'decagon', 'granola']) {
      assert.ok(!extracted.includes(customer), `${customer} is a Deepgram customer, not a requirement`);
    }
  });

  test('packet fa354c82: Truveta scores at all', () => {
    const result = scoreJdMatch(CS_RESUME, TRUVETA_JD, TRUVETA);
    assert.equal(
      result.scorable,
      true,
      `4,110 characters with a Preferred Qualifications block, and the review screen shows no colour: ${result.reason}`,
    );
    assert.equal(result.reason, undefined);
  });

  test('packet fa354c82: the degree field is a requirement alongside the languages', () => {
    const extracted = terms(TRUVETA_JD, TRUVETA);
    assert.ok(
      extracted.includes('computer science'),
      `"bachelors' or masters' in engineering, computer science or STEM related field" is a stated requirement and is absent from ${JSON.stringify(extracted)}`,
    );
    // Guard: the three terms that DID survive before must not be traded away for the one that did not.
    for (const language of ['java', 'python', 'c#']) {
      assert.ok(extracted.includes(language), `${language} was extracted before this fix and must stay`);
    }
  });

  test('packet 7364ea5a: a posting that really does state nothing still refuses', () => {
    // Five Rings, "Summer Intern 2027 - Quantitative Trader". Its "About You" block is a graduation
    // date and six adjectives: Quantitatively-focused, Thrive in a highly collaborative and
    // fast-paced environment, Quick learner, Intellectually curious, Detail-oriented, Self starter.
    // There is no requirement here for a resume to cover, so the refusal is correct and the message
    // is true. This is the case the fixtures above must not be fixed by breaking.
    const result = scoreJdMatch(CS_RESUME, FIVE_RINGS_TRADER_JD, FIVE_RINGS);
    assert.equal(result.scorable, false);
    assert.equal(result.score, null);
    assert.equal(
      result.reason,
      'This posting does not list enough specific requirements to score against. Nothing is wrong with your resume.',
    );
  });

  test('both properties hold on one posting: Computer Science is a requirement, react is not', () => {
    // PROSE_JD is the Akuna fixture from the block above, and it states both shapes in six lines:
    // "Ph.D. in Computer Science" is a real requirement written as a phrase, and "Ability to react
    // quickly" is an English verb that happens to spell a JavaScript library. A change that gains
    // the first by weakening the rules that reject the second will fail here rather than in one of
    // the two blocks, which is the point of writing it once more with both halves in one assertion.
    const extracted = terms(PROSE_JD);
    assert.ok(extracted.includes('computer science'));
    assert.ok(extracted.includes('python'));
    assert.deepEqual(
      extracted.filter((t) => ['react', 'resumes', 'pdf', 'major', 'legal'].includes(t)),
      [],
    );
  });
});
