import type { FastifyInstance } from 'fastify';

// Public privacy policy page, linked from the Chrome Web Store listing.
// Served from the backend so the policy lives at the same domain as the API.
const PRIVACY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Volley Privacy Policy</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 0 auto; padding: 48px 24px; color: #1e1b4b; line-height: 1.6; }
  h1 { font-size: 28px; } h2 { font-size: 19px; margin-top: 32px; }
  .muted { color: #6b7280; font-size: 14px; }
</style>
</head>
<body>
<h1>Volley Privacy Policy</h1>
<p class="muted">Effective date: June 12, 2026</p>

<p>Volley ("we") is a Chrome extension that helps job seekers find professional contacts and draft outreach emails.</p>

<h2>What we collect</h2>
<p>When you create an account we collect your email address. If you upload a resume, we parse and store its contents (experience, skills, school) to personalize drafts. When you use Volley on a job posting, we process the job title, company, and page URL to find relevant contacts. We store the contacts and email drafts generated for you.</p>

<h2>How we use it</h2>
<p>Solely to provide the service: finding contacts, verifying email addresses, and generating personalized drafts. We use third-party processors for email discovery and verification (Hunter, Reoon, BounceBan, Apollo) and AI drafting (Anthropic). Your resume data is sent to these processors only as needed to provide the feature you requested.</p>

<h2>What we do not do</h2>
<p>We do not sell your data. We do not read your browsing history, inbox, or pages other than job postings where you invoke Volley. We never send emails on your behalf; drafts open in your own Gmail for you to review and send.</p>

<h2>Retention and deletion</h2>
<p>Your data is retained while your account is active. Email us at the address below to delete your account and all associated data.</p>

<h2>Contact</h2>
<p>mehekman@usc.edu</p>
</body>
</html>`;

export async function privacyRoutes(fastify: FastifyInstance) {
  fastify.get('/privacy', async (_request, reply) => {
    return reply.status(200).type('text/html; charset=utf-8').send(PRIVACY_HTML);
  });
}
