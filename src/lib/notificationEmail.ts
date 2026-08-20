import { FAVICON_ENDPOINT, FAVICON_PX } from './companyDomains';
import { emailSender, type OutboundEmail } from './email';
import { scoreBand } from '../engine/jdMatch';
import { PRODUCT_LINKS, PRODUCT_NAME } from './product';

/* THE TWO MESSAGES, and the two rules that decide every word in them.
 *
 * RULE ONE: NEVER CLAIM FRESHNESS THE BOARD CANNOT SUPPORT. `monitored_jobs.posted_at` is
 * NULLABLE and null on a large share of the board, because Greenhouse does not publish one.
 * `first_seen_at` is not nullable and is a fact about US: the moment our poll first saw the
 * posting. So the alert says FOUND, never POSTED, everywhere including the subject line. The board
 * already holds this line ("say Found, never Posted"), and an email is the surface where breaking
 * it is worst: a student who opens a four-day-old posting sold to her as four hours old learns
 * that Litos rounds up, and every later claim about a match is worth less.
 *
 * RULE TWO: THE REPLY ALERT CARRIES NO BODY. Employer mail that Litos is willing to hand over
 * already leaves by the forwarding path in lib/applicationEmail.ts, in full, with the employer's
 * address on it. This alert exists for the messages that path deliberately keeps internal, and
 * copying their contents into a notification would route around that decision: a verification code
 * is the clearest case, and it is excluded by classification anyway, but the principle has to hold
 * for the class rather than for the one member of it anybody thought of. So the alert says that
 * mail arrived, for which application, and where to read it. Nothing else.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Below this, a percentage reads as damning rather than informative. MIN_RANKED_MATCH_SCORE (the
 * board's own floor) is 25, so "strong match" alone already promises more than a 31% score backs
 * up. Rather than print a number that undercuts the claim in the same sentence, the email drops the
 * number and lets the found phrase carry the line alone.
 */
export const EMAIL_MATCH_DISPLAY_FLOOR = 70;

/**
 * The 48px circle beside the job title: the employer's favicon when we have a verified domain for
 * them, otherwise their initial. No onerror fallback exists in email the way it does on the
 * dashboard, so a domain we are not confident in must not reach this function at all: the caller
 * passes the same `company_domain` the board itself renders, resolved server-side by
 * `companyDomainFor`, never guessed here.
 */
function companyLogoHtml(companyName: string, companyDomain: string | null): string {
  const initial = escapeHtml(companyName.trim().charAt(0).toUpperCase() || '?');
  const circleStyle =
    'display:table-cell;width:48px;height:48px;border-radius:999px;border:1px solid #e8e6e1;' +
    'background-color:#f7f7f5;text-align:center;vertical-align:middle;';
  if (!companyDomain) {
    return `<td class="email-logo-fallback" style="${circleStyle}"><span class="email-muted" style="color:#6b6a64;font-family:monospace;font-size:15px;font-weight:600;">${initial}</span></td>`;
  }
  const src = `${FAVICON_ENDPOINT}?domain=${encodeURIComponent(companyDomain)}&sz=${FAVICON_PX}`;
  return `<td class="email-logo" style="${circleStyle}padding:0;"><img src="${src}" width="24" height="24" alt="" style="display:inline-block;vertical-align:middle;border:0;width:24px;height:24px;" /></td>`;
}

/**
 * When Litos first SAW this posting, in words, and never when the employer published it.
 *
 * The vocabulary is deliberately coarse at the top end. "Found 4 hours ago" is worth saying because
 * it is the thing that makes an alert feel like an alert; "Found 19 days ago" is not, and rendering
 * it as a date instead stops the line quietly becoming an argument for opening something stale.
 *
 * Hours are floored, so a posting seen 119 minutes ago reads as "1 hour ago". Rounding up would
 * overstate age, which is harmless, but flooring keeps it consistent with every other elapsed-time
 * string a reader might compare it against.
 */
export function foundPhrase(firstSeenAt: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - firstSeenAt.getTime()) / 60_000);
  if (minutes < 0) return 'Found just now';
  if (minutes < 60) return minutes <= 1 ? 'Found just now' : `Found ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? 'Found 1 hour ago' : `Found ${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Found yesterday';
  if (days < 7) return `Found ${days} days ago`;
  return `Found on ${firstSeenAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })}`;
}

/* The unsubscribe footer, and the headers that let a mail client offer its own control.
 *
 * List-Unsubscribe-Post with One-Click is what makes Gmail and Outlook show an "Unsubscribe"
 * affordance next to the sender instead of leaving the spam button as the only exit. It commits
 * this deployment to honouring a bare POST to the URL with no confirmation step, which
 * routes/notifications.ts does. */
function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/*
 * DARK MODE, and why it is class-based rather than only a media query on the shell.
 *
 * The shell's own chrome (page background, card, header band, footer band) is styled here. The
 * body content each email type builds separately (headings, muted lines, links, the CTA button) is
 * given the same class names at the call site so one stylesheet governs the whole message, not just
 * the frame around it: a card that goes dark around text that stays light-mode black is worse than
 * doing nothing. Every override carries !important because it must beat the inline style that keeps
 * the email legible in clients with no dark-mode support at all (Outlook desktop chief among them),
 * which is why the light values are still written inline rather than only in this stylesheet.
 */
const DARK_MODE_STYLE = `
    <style>
      @media (prefers-color-scheme: dark) {
        .email-bg { background-color: #0f0f12 !important; }
        .email-card { background-color: #1b1b20 !important; border-color: #2c2c33 !important; }
        .email-header { background-color: #20223a !important; border-color: #2c2c33 !important; }
        .email-footer { background-color: #17171b !important; border-color: #2c2c33 !important; }
        .email-text { color: #f2f2ef !important; }
        .email-muted { color: #a7a6a1 !important; }
        .email-link { color: #9fb2f5 !important; }
        .email-button { background-color: #8da0f5 !important; color: #111119 !important; }
        .email-logo, .email-logo-fallback { background-color: #26262d !important; border-color: #33333c !important; }
        .email-badge { background-color: #262a4a !important; color: #b9c4fb !important; }
      }
    </style>`;

function shell(bodyHtml: string, unsubscribeHtml: string): string {
  const iconUrl = new URL('/icon.png', PRODUCT_LINKS.website).toString();
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />${DARK_MODE_STYLE}
  </head>
  <body class="email-bg" style="margin:0;padding:0;background-color:#f7f7f5;color:#12120f;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="email-bg" style="background-color:#f7f7f5;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" class="email-card" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e8e6e1;border-radius:20px;overflow:hidden;">
            <tr>
              <td class="email-header" style="padding:24px 32px;background-color:#eef1fe;border-bottom:1px solid #e8e6e1;">
                <p style="margin:0;">
                  <img src="${iconUrl}" width="40" height="40" alt="${PRODUCT_NAME}" style="display:inline-block;vertical-align:middle;border:0;" />
                  <strong class="email-text" style="vertical-align:middle;color:#12120f;">${PRODUCT_NAME}</strong>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 32px;">${bodyHtml}</td>
            </tr>
            <tr>
              <td class="email-footer" style="padding:20px 32px;background-color:#f7f7f5;border-top:1px solid #e8e6e1;">${unsubscribeHtml}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export type StrongMatchEmailInput = {
  to: string;
  unsubscribeUrl: string;
  now: Date;
  job: {
    company_name: string;
    title: string;
    location: string | null;
    first_seen_at: Date;
    posting_url: string;
    /** The employer's verified domain, resolved by `companyDomainFor` the same way the board
     *  resolves it. Null renders the initial-letter fallback rather than guessing at a logo. */
    company_domain: string | null;
  };
  /** The fit percentage from the same scorer the board ranks with. Null is never sent: a match
   *  alert with no score behind it is not a match alert, and the matcher refuses to build one. */
  score: number;
};

/**
 * One posting. Never a list, and the singular is the feature.
 *
 * A digest is the default shape of every job-alert email ever built and it is what this refuses:
 * ten postings a day trains somebody to archive the sender unread, and then the one that mattered
 * is archived with them. One posting, above the same floor the board ranks by, at most once a day,
 * is a thing worth opening. See DAILY_CAP in notificationPreferences.ts.
 */
export function strongMatchEmail(input: StrongMatchEmailInput): OutboundEmail {
  const { job } = input;
  const found = foundPhrase(job.first_seen_at, input.now);
  const where = job.location?.trim() || null;
  const boardUrl = new URL('/dashboard/jobs', PRODUCT_LINKS.website).toString();
  const settingsUrl = new URL('/dashboard/settings#automation', PRODUCT_LINKS.website).toString();
  const line = `${job.title} at ${job.company_name}`;
  /* Below EMAIL_MATCH_DISPLAY_FLOOR the number undercuts the "strong match" claim in the same
     sentence, so the sentence is written to work with or without it rather than blanking a slot. */
  const showScore = input.score >= EMAIL_MATCH_DISPLAY_FLOOR;
  const metaLine = showScore ? `${found}. ${input.score}% match against your resume.` : `${found}.`;
  /* The board's OWN bar for the word "strong" is scoreBand's 40, not MIN_RANKED_MATCH_SCORE's 25 -
     the eligibility floor this alert sends on. Left as-is, a posting scoring 26-39 clears the send
     floor and gets emailed "A strong match opened," then the student clicks through and the same
     posting is labelled "Solid match" on the board. The floor stays 25 (send eligibility is not
     this line's decision to make), but the CLAIM in the copy is capped at what the board itself
     would call it, so the two surfaces never disagree about the same posting. */
  const boardCallsItStrong = scoreBand(input.score).tone === 'strong';
  const eyebrow = boardCallsItStrong ? 'A strong match opened' : 'A new match opened';

  return {
    from: emailSender(),
    to: [input.to],
    headers: unsubscribeHeaders(input.unsubscribeUrl),
    /* The subject names the role and the employer and nothing else. No score, because a percentage
       in a subject line reads as a marketing number, and no "!" or "new", because the only claim
       worth making is the one the body can support. */
    subject: `${line}`,
    /* The absent location is dropped by SPREADING NOTHING, not by filtering empty strings out
       afterwards. A `.filter(part => part !== '')` reads as if it only removes the missing
       location, and it also removes every deliberate blank line below it, which collapses the
       whole plain-text part into seven unseparated lines. The blanks are content here. */
    text: [
      `${line}`,
      ...(where ? [where] : []),
      `${metaLine}`,
      ``,
      `Open your ${PRODUCT_NAME} dashboard: ${boardUrl}`,
      `(This takes you straight to the full posting and an apply-ready packet, not to the employer's site.)`,
      `Prefer the original listing? ${job.posting_url}`,
      ``,
      `You are getting this because you asked ${PRODUCT_NAME} to tell you when a strong match opens.`,
      `Stop these alerts: ${input.unsubscribeUrl}`,
    ].join('\n'),
    html: shell(
      [
        `<p class="email-muted" style="margin:0 0 16px;color:#6b6a64;font-size:13px;text-transform:uppercase;letter-spacing:0.06em;">${escapeHtml(eyebrow)}</p>`,
        `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px;">`,
        `<tr>`,
        companyLogoHtml(job.company_name, job.company_domain),
        `<td style="width:14px;"></td>`,
        `<td style="vertical-align:middle;">`,
        `<h1 class="email-text" style="margin:0 0 4px;color:#12120f;font-size:20px;">${escapeHtml(job.title)}</h1>`,
        `<p class="email-muted" style="margin:0;color:#6b6a64;">${escapeHtml(job.company_name)}${where ? ` &middot; ${escapeHtml(where)}` : ''}</p>`,
        `</td>`,
        `</tr>`,
        `</table>`,
        /* Found, never Posted. See the note at the top of this file. */
        showScore
          ? `<p style="margin:0 0 24px;"><span class="email-muted" style="color:#6b6a64;">${escapeHtml(found)}.</span> <span class="email-badge" style="display:inline-block;background-color:#eef1fe;color:#3f52b8;border-radius:999px;padding:2px 10px;font-size:13px;font-weight:600;">${input.score}% match</span></p>`
          : `<p class="email-muted" style="margin:0 0 24px;color:#6b6a64;">${escapeHtml(found)}.</p>`,
        `<p style="margin:0 0 8px;">`,
        `<a href="${escapeHtml(boardUrl)}" class="email-button" style="display:inline-block;padding:13px 20px;background-color:#6b84e8;color:#ffffff;text-decoration:none;border-radius:999px;">Open your ${escapeHtml(PRODUCT_NAME)} dashboard</a>`,
        `</p>`,
        `<p class="email-muted" style="margin:0 0 20px;color:#6b6a64;font-size:13px;">This button takes you straight to your ${escapeHtml(PRODUCT_NAME)} dashboard, not the employer's site, with the full posting and an apply-ready packet waiting.</p>`,
        `<p class="email-muted" style="margin:0;color:#6b6a64;">Prefer the original listing? <a href="${escapeHtml(job.posting_url)}" class="email-link" style="color:#4f68c9;">Open it here</a>.</p>`,
      ].join(''),
      [
        `<p class="email-muted" style="margin:0 0 6px;color:#6b6a64;">You asked ${PRODUCT_NAME} to tell you when a strong match opens. One a day at most, never a digest.</p>`,
        `<p class="email-muted" style="margin:0;color:#6b6a64;"><a href="${escapeHtml(input.unsubscribeUrl)}" class="email-link" style="color:#4f68c9;">Stop these alerts</a> or <a href="${escapeHtml(settingsUrl)}" class="email-link" style="color:#4f68c9;">change what you hear about</a>.</p>`,
      ].join(''),
    ),
  };
}

export type EmployerReplyEmailInput = {
  to: string;
  unsubscribeUrl: string;
  /** The employer this application was sent to, when the packet records one. Null renders a line
   *  that names no company rather than guessing at one. */
  company: string | null;
  role: string | null;
  receivedAt: Date;
};

/**
 * Somebody at an employer wrote back. That is the entire claim, and it is all this can support.
 *
 * IT DOES NOT SAY WHAT THEY SAID. See rule two at the top of this file. It also does not say
 * whether the news is good: the classifier that routed this message here is a regex over a subject
 * line, and "we have moved forward with other candidates" and "can you do Thursday" are equally
 * consistent with everything it knows. An alert that implied the second and delivered the first
 * would be a worse thing to have built than no alert.
 */
export function employerReplyEmail(input: EmployerReplyEmailInput): OutboundEmail {
  const trackerUrl = new URL('/dashboard/applications', PRODUCT_LINKS.website).toString();
  const settingsUrl = new URL('/dashboard/settings#automation', PRODUCT_LINKS.website).toString();
  const who = input.company?.trim() || null;
  const what = input.role?.trim() || null;
  const application = who && what ? `${what} at ${who}` : who || what || 'one of your applications';
  const subject = who ? `${who} replied to your application` : 'An employer replied to your application';

  return {
    from: emailSender(),
    to: [input.to],
    headers: unsubscribeHeaders(input.unsubscribeUrl),
    subject,
    text: [
      `Mail arrived for ${application}.`,
      ``,
      `Read it in ${PRODUCT_NAME}: ${trackerUrl}`,
      ``,
      `You are getting this because you asked ${PRODUCT_NAME} to tell you when an employer replies.`,
      `Stop these alerts: ${input.unsubscribeUrl}`,
    ].join('\n'),
    html: shell(
      [
        `<h1 style="margin:0 0 12px;color:#12120f;">${escapeHtml(subject)}</h1>`,
        `<p style="margin:0 0 24px;color:#6b6a64;">Mail arrived for ${escapeHtml(application)}. It is in your tracker, alongside the packet you sent.</p>`,
        `<p style="margin:0 0 20px;">`,
        `<a href="${escapeHtml(trackerUrl)}" style="display:inline-block;padding:13px 20px;background-color:#6b84e8;color:#ffffff;text-decoration:none;border-radius:999px;">Read it in ${PRODUCT_NAME}</a>`,
        `</p>`,
      ].join(''),
      [
        `<p style="margin:0 0 6px;color:#6b6a64;">You asked ${PRODUCT_NAME} to tell you when an employer replies.</p>`,
        `<p style="margin:0;color:#6b6a64;"><a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#4f68c9;">Stop these alerts</a> or <a href="${escapeHtml(settingsUrl)}" style="color:#4f68c9;">change what you hear about</a>.</p>`,
      ].join(''),
    ),
  };
}
