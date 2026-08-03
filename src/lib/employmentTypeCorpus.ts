/* THE POSTINGS THAT HAVE ACTUALLY FOOLED THIS CLASSIFIER.
 *
 * Every entry is REAL TEXT from a live board, kept verbatim, with the answer a human gave after
 * reading it. Not invented examples: each of these was found by auditing the whole board against
 * the employers who state a type, and each one was wrong in production at some point.
 *
 * WHY A CORPUS AND NOT JUST ASSERTIONS. The failures here are not variations on one bug, they are
 * six different ways a document can mention an internship without being one, and three ways it can
 * be one without saying so. A regex reviewed on its own always looks reasonable; it is only
 * obviously wrong next to the sentence it mis-read. Adding a case here is how the next person
 * changing employmentTypeFromDescription finds out what they broke.
 *
 * ADD TO THIS LIST whenever a real posting is found on the wrong side, before fixing the rule.
 * The count is asserted by the test, so growing it is deliberate.
 */

export type CorpusCase = {
  /** Verbatim from the live board. */
  title: string;
  /** The employer's own field, when their board publishes one. */
  boardValue?: string;
  /** The passage that decides it, verbatim. Empty when the title alone is the evidence. */
  description?: string;
  /** What a human says after reading it. */
  expected: string | undefined;
  /** The employer, so the case can be re-checked against their live board. */
  company: string;
  /** Why this one is here, in a sentence. */
  note: string;
};

export const EMPLOYMENT_TYPE_CORPUS: CorpusCase[] = [
  // ---- Mentions an internship, IS NOT one -------------------------------------------------
  {
    company: 'Rocket Lab',
    title: 'Security Officer',
    description:
      'THESE QUALIFICATIONS WOULD BE NICE TO HAVE: Industrial work experience, preferably in '
      + 'aerospace. Previous or current employment with Rocket Lab as an intern, employee or '
      + 'contractor, or work experience at another aerospace company.',
    expected: undefined,
    note: 'A qualifications list. Reads identically to Jane Street until you require the second '
      + 'person after "as an intern". Was live on five postings.',
  },
  {
    company: 'Astranis',
    title: 'Guidance, Navigation, and Control Engineer Associate (Fall 2026)',
    description:
      'Many past interns have designed and tested hardware/software that is heading to space. If '
      + 'you have not already graduated from a four-year university, please apply to our '
      + 'internship program. Role: Work with the Guidance, Navigation, and Control team.',
    expected: undefined,
    note: 'Astranis runs PAIRED postings, a post-grad Associate and an Intern, and the Associate '
      + 'sends students to the other one. Was live on eleven postings.',
  },
  {
    company: 'Astranis',
    title: 'Flight Software Associate (Fall 2026)',
    description: 'If you are still a college student, please apply to join us as an Intern. Role: '
      + 'Work with the engineering team to design, write and test software.',
    expected: undefined,
    note: 'The same redirect in its other phrasing.',
  },
  {
    company: 'N26',
    title: 'Social Media Customer Service Team Lead',
    description:
      'A Premium N26 bank account. Varying vacation days depending on your location of work and '
      + 'duration of your internship. A high degree of autonomy.',
    expected: undefined,
    note: 'A benefits block N26 publishes on EVERY posting it lists. "duration of" is the tell; '
      + 'a real internship says "course of" or "bulk of".',
  },
  {
    company: 'Jane Street',
    title: 'Campus Recruiter',
    description: 'You will run our internship program and support our interns through the summer.',
    expected: undefined,
    note: 'A job that RUNS the programme. Third person about interns, never addressed to one.',
  },
  {
    company: 'DRW',
    title: 'University Talent Acquisition Specialist',
    description: 'Support in the design and execution of the internship program, ensuring a '
      + 'best-in-class experience that drives conversion to full-time roles.',
    expected: undefined,
    note: 'Same shape, and the reason RECRUITING_TITLES covers "university" and "campus".',
  },
  {
    company: 'Anthropic',
    title: 'Cash Manager, Treasury',
    description: 'Build and run the short- and medium-term cash forecast (13-week and beyond), '
      + 'including variance tracking and scenario modeling.',
    expected: undefined,
    note: 'A fixed period that has nothing to do with an internship. 137 live postings state a '
      + 'week count and are full-time, which is why duration alone was never made a signal.',
  },
  {
    company: 'Robinhood',
    title: 'Customer Experience Representative, Core Services',
    description: 'In-person attendance expected 5 days per week during the 10-week onboarding '
      + 'period. After onboarding, in-person attendance is expected at least 3 days a week.',
    expected: undefined,
    note: 'The same trap in its most convincing form: a ten-week period on an early-career role.',
  },
  {
    company: 'Gusto',
    title: 'Summer Opportunities - Retirement Sales AE',
    expected: undefined,
    note: 'A season in the title on a full-time sales job. "Summer" alone is not a signal.',
  },
  {
    company: 'Astranis',
    title: 'Mission Engineering Associate (Fall 2026)',
    expected: undefined,
    note: 'A season plus a year on a post-grad role. Fifteen of these are live.',
  },
  {
    company: 'Crusoe',
    title: 'Apprentice Electrician',
    boardValue: 'FullTime',
    expected: 'Apprenticeship',
    note: 'Not an internship and not plain full-time. A trade apprenticeship is its own category.',
  },

  // ---- IS an internship, does not say so -------------------------------------------------
  {
    company: 'Jane Street',
    title: 'Software Engineer',
    description:
      'Our goal is to give you a real sense of what it is like to work at Jane Street full time '
      + 'while also providing a truly unparalleled educational experience. As an intern, you are '
      + 'paired with full-time employees who act as mentors.',
    expected: 'Internship',
    note: 'Jane Street posts this title thirteen times, some full-time and some the internship. '
      + 'The body is the only thing that separates them.',
  },
  {
    company: 'Jane Street',
    title: 'Software Engineer',
    description:
      'We are looking for Software Engineers who want to help us design and build the systems and '
      + 'tools that run the firm.',
    expected: undefined,
    note: 'The full-time twin. Same title, same board, opposite answer.',
  },
  {
    company: 'Jane Street',
    title: 'Quantitative Trader',
    description: 'During the internship, your work is reinforced with intensive classes.',
    expected: 'Internship',
    note: 'The other phrasings Jane Street uses, all second person.',
  },
  {
    company: 'AQR',
    title: '2027 Research Summer Analyst',
    description: 'The Internship Program Our 10-week summer program puts real work of the firm in '
      + 'your hands. You will work alongside brilliant people.',
    expected: 'Internship',
    note: 'The finance convention: the title never says intern, the body names the programme.',
  },
  {
    company: 'AQR',
    title: '2027 Research and Portfolio Management Engineering Summer Analyst',
    expected: 'Internship',
    note: 'The one AQR posting that omits the programme paragraph, so there is no body evidence '
      + 'at all. Caught by the Summer Analyst title rule and nothing else.',
  },
  {
    company: 'Mozilla',
    title: 'Necko Student Worker',
    description: 'As part of our internship program, you will be mentored one-on-one by somebody '
      + 'brilliant, and never be bored.',
    expected: 'Internship',
    note: 'Neither the title nor the phrasing looks like the Jane Street shape.',
  },
  {
    company: 'btgpactual',
    title: 'Estágio em Data Analytics',
    expected: 'Internship',
    note: 'Portuguese. Sixteen of these were invisible for no reason but language.',
  },
  {
    company: 'HelloFresh',
    title: 'Social Media & Influencer Stagiair(e) (m/v/x)',
    expected: 'Internship',
    note: 'Dutch, and the reason bare "stage" had to be excluded while "stagiair" stays in.',
  },
  {
    company: 'crisp',
    title: 'Werkstudent Finance',
    boardValue: 'FullTime',
    expected: 'Internship',
    note: 'German, and its employer says FullTime meaning full-time HOURS. Same as the Modal case.',
  },
  {
    company: 'Modal',
    title: 'ML Research Intern',
    boardValue: 'FullTime',
    expected: 'Internship',
    note: 'The original reason a title saying internship beats the employer field.',
  },
  {
    company: 'Rocket Lab',
    title: 'Talent Acquisition Intern Fall 2026',
    expected: 'Internship',
    note: 'A REAL internship whose title also carries a programme-owner noun. Ten of these are '
      + 'live, which is why the recruiting guard must never be applied to the title rule.',
  },
  {
    company: 'Varda Space Industries',
    title: 'Recruiting Operations Internship - Fall 2026',
    expected: 'Internship',
    note: 'The same, and the most tempting one to veto by mistake.',
  },
  {
    company: 'Palantir',
    title: 'American Tech Fellowship',
    boardValue: 'Scholarship',
    expected: 'Internship',
    note: 'No internship text anywhere in the description. Only the employer field says it.',
  },

  // ---- Titles that merely look like they contain an internship word ------------------------
  {
    company: 'Cisco',
    title: 'Account Executive, Early Stage - EMEA',
    expected: undefined,
    note: '"stage" is internship in French and Dutch and something else entirely here. 22 live '
      + 'titles carry it, which is why the multilingual list excludes the bare word.',
  },
  {
    company: 'Crusoe',
    title: 'Senior Stage Fluids Engineer I',
    expected: undefined,
    note: 'The same trap in engineering, where "stage" is a piece of equipment.',
  },
  {
    company: 'Northline',
    title: 'Senior Specialist, Internal Communications',
    expected: undefined,
    note: 'Why the intern pattern is word-bounded on both sides.',
  },
  {
    company: 'Northline',
    title: 'Manager, International Statutory Reporting',
    expected: undefined,
    note: 'The same word-boundary case, on a different prefix.',
  },
];
