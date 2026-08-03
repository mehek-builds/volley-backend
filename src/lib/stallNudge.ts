import type { StallRecord } from './stallMetrics';

/**
 * The email that says an application is still waiting.
 *
 * Sent only when the badge and the dashboard have already failed, which is why the threshold is
 * hours rather than minutes: a nudge that arrives while someone is still looking at the page is the
 * fastest way to teach them to ignore the next one.
 *
 * It never asks them to do anything except finish their own application, and it never implies Litos
 * could have done it for them. The check is theirs to pass; the only useful thing this can do is
 * make sure they know it is there.
 */

export type NudgeApplication = {
  company: string;
  role: string;
  portalUrl?: string;
  stall: StallRecord;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Only https becomes a link, for the same reason the dashboard checks: this URL traces back to an
 * employer posting, it lands in an email client rather than a page we control, and the recipient is
 * being invited to click it.
 */
export function safeLink(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function nudgeSubject(applications: readonly NudgeApplication[]): string {
  if (applications.length === 1) {
    // Naming the company makes the subject line answer "is this worth opening" on its own.
    return `Your ${applications[0]!.company} application is waiting on one check`;
  }
  return `${applications.length} applications are waiting on one check each`;
}

/**
 * HTML body, per the standing rule that every Litos email is HTML. Plain semantic tags only: no
 * inline layout, no width wrappers, nothing that renders differently across clients.
 */
export function nudgeHtml(applications: readonly NudgeApplication[], firstName?: string): string {
  const greeting = firstName?.trim() ? `Hi ${escapeHtml(firstName.trim())},` : 'Hi,';
  const opener = applications.length === 1
    ? 'One of your applications is filled in and waiting on a single step that only you can do: the company asks you to prove you are human.'
    : 'A few of your applications are filled in and waiting on a single step that only you can do: these companies ask you to prove you are human.';

  const items = applications.map((application) => {
    const label = `${escapeHtml(application.role)} at ${escapeHtml(application.company)}`;
    const link = safeLink(application.portalUrl);
    const line = link
      ? `<a href="${escapeHtml(link)}">${label}</a>`
      : label;
    const note = application.stall.stage === 'at_submit'
      ? 'Everything else is filled in.'
      : 'Nothing is filled in yet, so Litos will take it from there once the check is done.';
    return `<li>${line} - ${note}</li>`;
  }).join('');

  return [
    `<p>${greeting}</p>`,
    `<p>${opener}</p>`,
    `<ul>${items}</ul>`,
    '<p>Litos cannot pass that check for you, and would not want to: it is the part that confirms a person is applying. Open the page, clear it, and send.</p>',
    '<p>Litos</p>',
  ].join('');
}
