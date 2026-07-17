/* Renders full-page example resumes in Volley's resume STYLE (engine/resumeRender):
   Times, centered name, black & white, ruled EDUCATION / EXPERIENCE / SKILLS,
   one-page Letter. The product engine uses very tight 11pt spacing (real tailored
   output often half-fills the page); these stills feed the RoleQuick site animation,
   where a page must read as a COMPLETE, full resume with no excess white space, so
   body size and gaps are scaled up to fill the page. Same layout + fonts as the
   engine — only the scale differs. Writes PDFs; caller converts to PNG. */

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

const OUT = process.argv[2] || '/tmp/resume-examples';
fs.mkdirSync(OUT, { recursive: true });

const MARGIN = 40;
const USABLE_W = 612 - MARGIN * 2;
const NAME = 20;
const CONTACT = 10.5;
const HEADER = 12.5;
const BODY = 12.5;

function contactLine(c) {
  return [c.email, c.phone, c.linkedin_url, c.github_url, c.portfolio_url].filter(Boolean).join('   |   ');
}

function sectionHeader(doc, title, topGap) {
  doc.y += topGap;
  doc.font('Times-Bold').fontSize(HEADER).text(title.toUpperCase(), MARGIN, doc.y, { width: USABLE_W });
  const ruleY = doc.y + 2;
  doc.moveTo(MARGIN, ruleY).lineTo(MARGIN + USABLE_W, ruleY).lineWidth(0.75).stroke();
  doc.y = ruleY + 5;
}

function tabbed(doc, left, right, gapBefore) {
  doc.y += gapBefore;
  const y = doc.y;
  doc.font('Times-Bold').fontSize(BODY).text(left, MARGIN, y, { continued: false });
  doc.font('Times-Roman').fontSize(BODY).text(right, MARGIN, y, { width: USABLE_W, align: 'right' });
}

function render({ contact, spec }, file) {
  const doc = new PDFDocument({ margin: MARGIN, size: 'LETTER', bufferPages: true });
  const stream = fs.createWriteStream(file);
  doc.pipe(stream);

  doc.font('Times-Bold').fontSize(NAME).text(contact.full_name, MARGIN, MARGIN, { width: USABLE_W, align: 'center' });
  doc.font('Times-Roman').fontSize(CONTACT).text(contactLine(contact), MARGIN, doc.y + 3, { width: USABLE_W, align: 'center' });

  sectionHeader(doc, 'Education', 6);
  tabbed(doc, spec.school, spec.grad_date, 0);
  if (spec.degree) {
    doc.y += 2;
    doc.font('Times-Italic').fontSize(BODY).text(spec.degree, MARGIN, doc.y, { width: USABLE_W });
  }
  if (spec.coursework) {
    doc.y += 2;
    doc.font('Times-Roman').fontSize(BODY).text(`Relevant coursework: ${spec.coursework}`, MARGIN, doc.y, { width: USABLE_W });
  }

  sectionHeader(doc, 'Experience', 10);
  spec.experience.forEach((entry, i) => {
    tabbed(doc, entry.org, entry.date_range, i === 0 ? 0 : 8);
    doc.y += 2;
    doc.font('Times-Italic').fontSize(BODY).text(entry.title, MARGIN, doc.y, { width: USABLE_W });
    doc.y += 3;
    for (const b of entry.bullets) {
      doc.font('Times-Roman').fontSize(BODY).text(`•  ${b}`, MARGIN + 12, doc.y, { width: USABLE_W - 12 });
      doc.y += 3;
    }
  });

  if (spec.skills.length) {
    sectionHeader(doc, 'Skills', 10);
    doc.font('Times-Roman').fontSize(BODY).text(spec.skills.join('   •   '), MARGIN, doc.y, { width: USABLE_W });
  }

  doc.end();
  return new Promise((res) => stream.on('finish', res));
}

const RESUMES = [
  {
    contact: {
      full_name: 'Alex Rivera',
      email: 'alex.rivera@usc.edu',
      phone: '(213) 555-0148',
      linkedin_url: 'linkedin.com/in/alexrivera',
      github_url: 'github.com/alexrivera',
    },
    spec: {
      school: 'University of Southern California',
      degree: 'B.S. Computer Science, Minor in Applied Mathematics',
      grad_date: 'Expected May 2026',
      coursework: 'Distributed Systems, Databases, Algorithms, Operating Systems, Machine Learning, Networks',
      experience: [
        {
          org: 'Notion', title: 'Software Engineer Intern', date_range: 'Jun 2025 - Aug 2025',
          bullets: [
            'Built and owned three REST services handling 40,000 requests per day, shipping them behind a staged rollout',
            'Raised test coverage from 41% to 78% in one quarter by adding a CI gate that blocked untested merges',
            'Shipped a Redis caching layer that cut p95 response latency by 220ms across the busiest endpoints',
            'Wrote the runbook and dashboards that cut on-call resolution time for the service by roughly a third',
          ],
        },
        {
          org: 'USC Viterbi School of Engineering', title: 'Undergraduate Research Assistant', date_range: 'Jan 2024 - May 2025',
          bullets: [
            'Automated a nightly data pipeline processing 2 million rows using Airflow, replacing a manual export step',
            'Cut model training time threefold by moving preprocessing off the hot path onto a batch worker',
            'Co-authored a paper accepted to an undergraduate machine learning workshop',
          ],
        },
        {
          org: 'Trojan Dev Collective', title: 'Backend Lead', date_range: 'Sep 2023 - Dec 2023',
          bullets: [
            'Led a four-person team building an events API adopted by six campus clubs',
            'Set up the deploy pipeline and on-call rotation, reducing failed deploys to near zero',
            'Mentored two first-year engineers through their first production pull requests',
          ],
        },
        {
          org: 'Splunk', title: 'Software Engineering Extern', date_range: 'Jun 2023 - Aug 2023',
          bullets: [
            'Prototyped an internal React dashboard that surfaced build health for a team of 20 engineers',
            'Wrote integration tests that caught three regressions before they reached release',
            'Automated a log-triage script that saved the on-call rotation roughly five hours a week',
          ],
        },
      ],
      skills: ['TypeScript', 'React', 'Python', 'Go', 'SQL', 'PostgreSQL', 'AWS', 'Docker', 'Redis', 'Git'],
    },
  },
  {
    contact: {
      full_name: 'Jordan Chen',
      email: 'jordan.chen@usc.edu',
      phone: '(415) 555-0193',
      linkedin_url: 'linkedin.com/in/jordanchen',
      portfolio_url: 'jordanchen.design',
    },
    spec: {
      school: 'University of Southern California',
      degree: 'B.S. Design, Iovine and Young Academy',
      grad_date: 'Expected May 2026',
      coursework: 'Interaction Design, Design Research, Typography, Human-Centered AI, Prototyping Studio',
      experience: [
        {
          org: 'Figma', title: 'Product Design Intern', date_range: 'Jun 2025 - Aug 2025',
          bullets: [
            'Owned the redesign of an onboarding flow used by 90,000 monthly users from research through ship',
            'Ran 12 moderated usability sessions, lifting task completion from 62% to 89% over three iterations',
            'Built a 40-component design system later adopted by three product teams',
            'Partnered with an engineer to ship weekly behind a feature flag, measuring impact each release',
          ],
        },
        {
          org: 'USC Iovine and Young Academy', title: 'Studio Lead', date_range: 'Jan 2024 - May 2025',
          bullets: [
            'Led a five-person team from concept to a shipped campus app with 1,200 installs',
            'Wrote the research plan and synthesized 30 interviews into six actionable themes',
            'Prototyped and tested in Figma every week with real students to de-risk decisions early',
          ],
        },
        {
          org: 'Freelance', title: 'Product and Brand Designer', date_range: 'Sep 2023 - Dec 2023',
          bullets: [
            'Designed marketing sites and product interfaces for four early-stage startups',
            'Built reusable Framer components that cut engineering handoff time roughly in half',
            'Ran a lightweight brand sprint that shipped a new identity for a seed-stage client',
          ],
        },
        {
          org: 'USC Annenberg Media', title: 'Product Designer', date_range: 'Jun 2023 - Aug 2023',
          bullets: [
            'Redesigned the newsroom article template, improving mobile readability scores by 18 percent',
            'Shipped a dark mode later adopted across the entire student news site',
            'Ran a component audit that removed 30 redundant styles from the design library',
          ],
        },
      ],
      skills: ['Figma', 'Prototyping', 'User Research', 'Framer', 'Motion', 'Design Systems', 'HTML', 'CSS'],
    },
  },
];

(async () => {
  for (let i = 0; i < RESUMES.length; i++) {
    const file = path.join(OUT, `resume-${i + 1}.pdf`);
    await render(RESUMES[i], file);
    console.log('wrote', file);
  }
  console.log('done');
})();
