/**
 * THE TOKENIZER CONTRACT. This file is duplicated BYTE FOR BYTE in two repositories:
 *
 *   student-outreach-backend  src/engine/tokenizer-contract.ts
 *   role-quick-website        features/applications/domain/tokenizer-contract.ts
 *
 * Keep them identical. `diff` the two paths; there is nothing environment-specific in here, no
 * imports, and no code, so a difference is always drift.
 *
 * WHY IT EXISTS. The backend decides which requirements a posting states and what each one is
 * worth; the website decides where those requirements are shown on the page and in what colour.
 * Both start by cutting the same job description into tokens, and they do it in two separate
 * implementations that cannot import each other because the repos deploy independently.
 *
 * The two normalizers around those tokenizers, normalizeTerm and singular, were deliberately kept
 * byte-identical across the repos and are checked by eye whenever either moves. THE TOKENIZERS
 * WERE NOT, and nobody noticed for as long as the panes happened to agree. Measured over the 25
 * most recent real packets on 2026-08-08: the backend split a slash-joined token into its parts and
 * the website did not, so `HTML/CSS` scored as the two requirements `html` and `css` and was
 * painted in neither pane. 20 of the 25 packets were affected, 22.7% of every term-instance the
 * product owed the student. On one packet five of twelve requirements were slash-joined, so a
 * student read a 37% score whose evidence was 42% invisible.
 *
 * WHAT AGREEMENT MEANS HERE: given the same text, both tokenizers return the same list of pieces
 * at the same offsets. Not the same scoring, not the same lexicon, not the same section rules -
 * only the cut. That is the whole of the shared surface, and it is enough, because everything
 * downstream keys off the normalized text of a piece.
 *
 * HOW A CHANGE IS MADE. Add or amend a case here, update TOKENIZER_CONTRACT_FINGERPRINT to the
 * value the failing test prints, copy this file to the other repo, and change that repo's
 * tokenizer until its own contract test passes. The fingerprint is what stops half of that from
 * being done silently: an edited corpus fails its own test until the constant is refreshed, which
 * is the moment to remember the other copy exists.
 *
 * THE HONEST LIMIT: nothing here can see across the repository boundary, so this cannot detect a
 * copy that was never made. What it does guarantee is that neither tokenizer can be changed
 * without a test failing in front of the person changing it.
 */

export interface TokenizerContractCase {
  /** What the case is about, so a failure reads as a sentence rather than as an index. */
  readonly name: string;
  /** Verbatim job-description text. Most are excerpts from real postings on the board. */
  readonly text: string;
  /** The expected pieces, as [text, startOffset] in the input string. */
  readonly tokens: ReadonlyArray<readonly [string, number]>;
}

export const TOKENIZER_CONTRACT: readonly TokenizerContractCase[] = [
  {
    // Akuna Capital, packet caac7680 and ten more. The defect that produced this file.
    name: "a slash-joined pair is two requirements",
    text: "Basic understanding of HTML/CSS",
    tokens: [
      ["Basic", 0],
      ["understanding", 6],
      ["of", 20],
      ["HTML", 23],
      ["CSS", 28],
    ],
  },
  {
    // postman, packet 2847b750. Five of that packet's twelve requirements were written this way.
    name: "a three-way slash run is three requirements",
    text: "a cloud platform (AWS/GCP/Azure), Docker",
    tokens: [
      ["a", 0],
      ["cloud", 2],
      ["platform", 8],
      ["AWS", 18],
      ["GCP", 22],
      ["Azure", 26],
      ["Docker", 34],
    ],
  },
  {
    // The exception, and the reason the split is not unconditional: some slash forms name ONE
    // skill. The set is enumerated (ci/cd, a/b, r/d) rather than guessed, on both sides.
    name: "a slash form that is one skill stays whole",
    text: "CI/CD pipelines and A/B testing",
    tokens: [
      ["CI/CD", 0],
      ["pipelines", 6],
      ["and", 16],
      ["A/B", 20],
      ["testing", 24],
    ],
  },
  {
    // Akuna Capital again. "Computer Science" must still survive as a phrase after the split,
    // which is only true if the split leaves the two pieces at their real offsets.
    name: "a slashed degree field is two fields",
    text: "technical field - Computer Science/Engineering or equivalent",
    tokens: [
      ["technical", 0],
      ["field", 10],
      ["Computer", 18],
      ["Science", 27],
      ["Engineering", 35],
      ["or", 47],
      ["equivalent", 50],
    ],
  },
  {
    name: "a slashed prose connective splits harmlessly",
    text: "respond and/or solve coding problems",
    tokens: [
      ["respond", 0],
      ["and", 8],
      ["or", 12],
      ["solve", 15],
      ["coding", 21],
      ["problems", 28],
    ],
  },
  {
    // A dot is the punctuation that says "technical name", so it stays INSIDE the token. All three
    // spellings below are one token each.
    name: "a dot inside a technical name survives",
    text: "Built Node.js services on asp.net and ASP.NET",
    tokens: [
      ["Built", 0],
      ["Node.js", 6],
      ["services", 14],
      ["on", 23],
      ["asp.net", 26],
      ["and", 34],
      ["ASP.NET", 38],
    ],
  },
  {
    // Akuna Capital "Software Engineer Intern - C# .NET Desktop", packet 213674e2. The scrape lost
    // a space. Left glued, the token normalized to `ofnet`, kept its dot for the technical-name
    // test, and was shown to the student in amber as the requirement "of.NET Framework" - while
    // .NET, the only technology in the job's title, was never extracted at all. A lowercase run, a
    // dot, then a capital is a shape no technology spells itself with, so the split needs no list.
    name: "a lost space before a dotted product name is repaired",
    text: "Understanding of.NET Framework and C# programming",
    tokens: [
      ["Understanding", 0],
      ["of", 14],
      [".NET", 16],
      ["Framework", 21],
      ["and", 31],
      ["C#", 35],
      ["programming", 38],
    ],
  },
  {
    // The near misses for the rule above, and neither may split: U.S.C. and Ph.D. begin with a
    // capital, so the lowercase-run half of the shape is absent.
    name: "a dotted initialism is not a lost space",
    text: "Refugee under 8 U.S.C. 1157 or a Ph.D. in CS",
    tokens: [
      ["Refugee", 0],
      ["under", 8],
      ["U.S.C", 16],
      ["or", 28],
      ["a", 31],
      ["Ph.D", 33],
      ["in", 39],
      ["CS", 42],
    ],
  },
  {
    // The token stops at the word. Without this the sentence-final period sits inside the previous
    // token's span, and the gap between two tokens is what tells a phrase from two list items.
    name: "trailing punctuation is trimmed off the token",
    text: "You will use Python. Kubernetes- helps",
    tokens: [
      ["You", 0],
      ["will", 4],
      ["use", 9],
      ["Python", 13],
      ["Kubernetes", 21],
      ["helps", 33],
    ],
  },
  {
    name: "plus, hash, hyphen and underscore stay inside the token",
    text: "C++ and C# with model-serving and snake_case",
    tokens: [
      ["C++", 0],
      ["and", 4],
      ["C#", 8],
      ["with", 11],
      ["model-serving", 16],
      ["and", 30],
      ["snake_case", 34],
    ],
  },
  {
    // A leading digit is not a token. The website's pattern used to admit one, so digit-suffixed
    // text tokenized differently on the two sides; that is the same class of drift as the slash.
    name: "a token must start with a letter",
    text: "Major GPA of 3.5 or above",
    tokens: [
      ["Major", 0],
      ["GPA", 6],
      ["of", 10],
      ["or", 17],
      ["above", 20],
    ],
  },
  {
    name: "an e.g. connective keeps its shape",
    text: "a cloud platform (e.g. AWS)",
    tokens: [
      ["a", 0],
      ["cloud", 2],
      ["platform", 8],
      ["e.g", 18],
      ["AWS", 23],
    ],
  },
];

/**
 * SHA-256 of JSON.stringify(TOKENIZER_CONTRACT), asserted by the contract test in both repos.
 *
 * Its job is to make an edit to the corpus loud. Change a case and this constant is wrong, the test
 * says so, and refreshing it is the prompt to copy the file to the other repository.
 */
export const TOKENIZER_CONTRACT_FINGERPRINT =
  "bee5feaea2f95aae6ffbf05c6a92df67dbc11686c3c4a7abca044fd5d25bf9a7";
