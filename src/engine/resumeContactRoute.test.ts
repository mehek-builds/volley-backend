import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasContactRoute, renderResumePdf, ResumeContactError, resumeContactIssues } from './resumeRender';
import { extractPdfText } from '../lib/pdfText';
import { resumeContactOfRecord } from '../lib/resumeContactOfRecord';
import type { ResumeSpec } from '../llm/resumeSpec';

/* THE UNCONTACTABLE RESUME, measured on production 2026-08-09.
 *
 * 28 of one account's 85 stored packets had spec._contact.email AND spec._contact.phone both null,
 * so the block under the applicant's name collapsed to a single LinkedIn URL. An employer reading
 * that PDF had no address and no number. It was not a clean cutover either: 18 of 18 packets in the
 * 2026-08-07 21:00-22:00 batch, 8 of 11 on 2026-08-08 10:00, and both of the two most recent
 * packets in the system, with good packets interleaved. 26 of the 28 had already been typed into a
 * live employer form by the submission runner before anyone noticed.
 *
 * Cause: POST /resume/generate rendered `body.contact` verbatim. Every field below full_name is
 * optional in resumeRequestSchema.ts, both clients degrade quietly on their own profile reads, and
 * the server never looked at the account it was already holding. users.email was populated on that
 * very request (middleware/auth.ts resolves it from the users row) and application_profile.phone
 * was populated and encrypted at rest. The document printed the client's blank over both. */

function spec(): ResumeSpec {
  return {
    school: 'University of Southern California',
    degree: 'B.S. Computer Science',
    grad_date: 'May 2028',
    coursework: 'Data Structures, Algorithms, Machine Learning',
    experience: [1, 2].map((i) => ({
      org: `Company ${i}`,
      title: 'Software Engineering Intern',
      date_range: 'Jun 2024 - Aug 2025',
      bullets: [1, 2, 3].map(
        (j) => `Built feature ${j} that improved conversion by ${10 + j}% across 40,000 daily events for 100+ users`,
      ),
    })),
    skills: ['Python', 'SQL', 'Swift', 'Git'],
  } as ResumeSpec;
}

/* The exact contact block off packet 80aeba93-d602-4961-a1ea-294ea4928de7 (Virtu, 2026-08-08
   20:27), one of the two most recent packets in the system when this was found. */
const PRODUCTION_CONTACTLESS = {
  full_name: 'Mehek Mandal',
  github_url: 'https://github.com/mehek-builds',
  linkedin_url: 'https://www.linkedin.com/in/mehekmandal/',
  portfolio_url: 'https://github.com/mehek-builds',
};

describe('a resume with no way to reply on it', () => {
  test('links are not a contact route, because nobody replies to a profile page', () => {
    assert.equal(hasContactRoute(PRODUCTION_CONTACTLESS), false);
    assert.equal(hasContactRoute({ full_name: 'Mehek Mandal' }), false);
    // What an "email: ''" round trip through jsonb produces. Truthiness alone would pass this.
    assert.equal(hasContactRoute({ full_name: 'Mehek Mandal', email: '   ', phone: '\t' }), false);
    assert.equal(hasContactRoute({ full_name: 'Mehek Mandal', email: 'a@b.com' }), true);
    // Either one is enough. A phone-only resume is answerable; that is the whole bar.
    assert.equal(hasContactRoute({ full_name: 'Mehek Mandal', phone: '+971 567417451' }), true);
  });

  test('the packet quality block has an opinion about it, which it never had before', () => {
    /* On Virtu packet 80aeba93 the stored _quality read specIssues: [], visualWarnings: [],
       groundingRemoved: [], layoutIssues: [] - every array empty on a resume with no way to reply
       on it. The quality system measured density, ATS coverage, section order and grounding and
       had nothing to say about the one property that makes a resume a resume. */
    assert.deepEqual(resumeContactIssues(PRODUCTION_CONTACTLESS), [
      'the resume has no email address and no phone number, so an employer who reads it cannot reply',
    ]);
    assert.deepEqual(resumeContactIssues({ full_name: 'Mehek Mandal', phone: '+971 567417451' }), []);
  });

  test('a section order containing HEADER is not evidence of a contact route', async () => {
    /* The stored visualLayout.sectionOrder on that packet was ["HEADER","EDUCATION","EXPERIENCE",
       "SKILLS"], which looks complete and is. HEADER is emitted whenever the NAME is drawn, so it
       reports identically with and without a contact line under it, which is why the check cannot
       be inferred from it and has to be its own assertion. */
    const withRoute = await renderResumePdf(
      spec(),
      { ...PRODUCTION_CONTACTLESS, email: 'mehekmandal05@gmail.com' },
      'software engineering',
    );
    assert.ok(withRoute.layout.section_order.includes('HEADER'));
    // And the contactless render never gets far enough to report a section order at all.
    await assert.rejects(() => renderResumePdf(spec(), PRODUCTION_CONTACTLESS, 'software engineering'));
  });

  test('the renderer refuses to produce the document at all', async () => {
    await assert.rejects(
      () => renderResumePdf(spec(), PRODUCTION_CONTACTLESS, 'software engineering'),
      (err: unknown) => {
        assert.ok(err instanceof ResumeContactError, 'must be distinguishable from a render fault');
        assert.match((err as Error).message, /no email address and no phone number/);
        return true;
      },
    );
  });

  test('a phone with no email still renders, and the number reaches the page', async () => {
    const rendered = await renderResumePdf(
      spec(),
      { ...PRODUCTION_CONTACTLESS, phone: '+971 567417451' },
      'software engineering',
    );
    const parsed = await extractPdfText(rendered.buffer);
    assert.match(parsed.text.replace(/\s+/g, ' '), /\+971 567417451/);
  });
});

describe('the contact block is resolved against the account, not taken from the caller', () => {
  test('a request carrying only links is filled from the login email and the stored phone', () => {
    const resolved = resumeContactOfRecord({
      requested: PRODUCTION_CONTACTLESS,
      accountEmail: 'mehekmandal05@gmail.com',
      profile: { phone: '+971 567417451', linkedin_url: 'https://www.linkedin.com/in/mehekmandal/' },
    });
    assert.equal(resolved.email, 'mehekmandal05@gmail.com');
    assert.equal(resolved.phone, '+971 567417451');
    assert.equal(hasContactRoute(resolved), true);
  });

  test('what the caller sends wins, because it may be a deliberate per-application choice', () => {
    const resolved = resumeContactOfRecord({
      requested: { ...PRODUCTION_CONTACTLESS, email: 'mehekman@usc.edu', phone: '+1 213 555 0100' },
      accountEmail: 'mehekmandal05@gmail.com',
      profile: { phone: '+971 567417451' },
    });
    assert.equal(resolved.email, 'mehekman@usc.edu');
    assert.equal(resolved.phone, '+1 213 555 0100');
  });

  test('nothing is invented when the account has nothing either', () => {
    // The correct outcome is an empty field the caller then refuses on, never a plausible guess.
    const resolved = resumeContactOfRecord({ requested: { full_name: 'Mehek Mandal' } });
    assert.equal(resolved.email, undefined);
    assert.equal(resolved.phone, undefined);
    assert.equal(hasContactRoute(resolved), false);
  });

  test('a profile that would not decrypt degrades to no phone rather than to ciphertext', () => {
    // academicRecordRowFor returns {} on FieldDecryptError, which is what reaches `profile` here.
    // The login email is unencrypted and survives, so the packet still has a route (R-021).
    const resolved = resumeContactOfRecord({
      requested: PRODUCTION_CONTACTLESS,
      accountEmail: 'mehekmandal05@gmail.com',
      profile: {},
    });
    assert.equal(resolved.phone, undefined);
    assert.equal(hasContactRoute(resolved), true);
  });
});

describe('every path that can produce or send one of these packets is closed', () => {
  const resumeRoute = readFileSync('src/routes/resume.ts', 'utf8');
  const applicationsRoute = readFileSync('src/routes/applications.ts', 'utf8');
  const baseResumeRoute = readFileSync('src/routes/baseResume.ts', 'utf8');

  test('generation resolves the contact against the account and refuses before the model call', () => {
    assert.match(resumeRoute, /const resumeEmail = resumeEmailOfRecord\(profileRows\[0\]\?\.parsed_json\)/);
    assert.match(resumeRoute, /if \(!resumeEmail\)[\s\S]*code: 'resume_email_required'/);
    assert.match(resumeRoute, /resumeContactOfRecord\(\{[\s\S]*accountEmail: resumeEmail/);
    assert.match(resumeRoute, /if \(resumeContactIssues\(contactOfRecord\)\.length > 0\)/);
    assert.match(resumeRoute, /code: 'resume_quality_hold'/);
    // Refused BEFORE the spec is generated, or the refusal costs a Claude call and a render.
    assert.ok(
      resumeRoute.indexOf('if (resumeContactIssues(contactOfRecord).length > 0)') < resumeRoute.indexOf('generateResumeSpec('),
      'the contact refusal must precede the model call',
    );
    // The alias decision reads the RESOLVED email. Keyed off the raw request, a caller with an
    // empty body.contact.email skipped the alias and shipped a packet with no address of any kind.
    assert.match(resumeRoute, /body\.application && contactOfRecord\.email/);
    assert.doesNotMatch(resumeRoute, /body\.application && body\.contact\.email/);
    // The stored block is the resolved one, not the request's.
    assert.match(resumeRoute, /const applicationContact = contactOfRecord;/);
  });

  test('the packet records the contact verdict instead of leaving an empty array to be misread', () => {
    // Computed on applicationContact, the block that is rendered and stored, so the alias
    // substitution is covered too.
    assert.match(resumeRoute, /const contactIssues = resumeContactIssues\(applicationContact\);/);
    // Stored on the row: an empty array now means "checked and passed", not "nothing looked".
    assert.match(resumeRoute, /_quality: \{[\s\S]*contactIssues,/);
    // And it gates storage, alongside the other post-render issues.
    assert.match(resumeRoute, /let layoutIssues: string\[\] = \[\.\.\.contactIssues, \.\.\.visualIssues\];/);
  });

  test('the send-time check answers with a sentence instead of throwing out of the verifier', () => {
    assert.match(applicationsRoute, /if \(!hasContactRoute\(\{ \.\.\.contact, full_name: contact\.full_name \}\)\)/);
    assert.match(applicationsRoute, /Generate it again to add your contact details/);
    // Ahead of the render, whose ResumeContactError would otherwise become a 500 on a route whose
    // whole contract is a list of issues the applicant can act on.
    assert.ok(
      applicationsRoute.indexOf('hasContactRoute') < applicationsRoute.indexOf('await renderResumePdf'),
      'the pre-send contact check must precede the render it protects',
    );
  });

  test('editing a stored packet cannot rewrite a contactless PDF over a contactless PDF', () => {
    // The edit route re-renders from the STORED contact block, so it can never add an address.
    assert.match(applicationsRoute, /Generate it again to add your contact details, then edit it/);
  });

  test('the main resume prints the stored phone and reports the guard as its own cause', () => {
    assert.match(baseResumeRoute, /phone: str\(appProfile\?\.phone\)/);
    // The decrypted row, not the raw one: phone is in ENCRYPTED_FIELDS and the raw column is base64.
    assert.match(baseResumeRoute, /const resumeEmail = resumeEmailOfRecord\(profile\.parsed_json\)/);
    assert.match(baseResumeRoute, /contactHeaderFrom\([\s\S]*profile\.parsed_json,[\s\S]*applicationRecord,[\s\S]*resumeEmail/);
    assert.match(baseResumeRoute, /err instanceof ResumeContactError/);
  });
});
