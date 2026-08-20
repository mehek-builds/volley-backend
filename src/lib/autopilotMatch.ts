/* WHICH PACKET AUTOPILOT SENDS NEXT, computed server-side.
 *
 * Ported from role-quick-website's features/applications/domain/daily-matches.ts
 * (reviewCanBeSent, packetMatchesJob, nextPreferredReadyPacket) rather than shared, because the
 * two repos are separate deployments with no shared package. The three functions below are
 * deliberately byte-for-byte the same LOGIC as their client originals - same statuses, same
 * matching rule, same iteration order - so "next best match" means the same thing whether a human
 * is watching the dashboard or the cron is running unattended. If either side's rule changes, this
 * file has to change with it or the two disagree about what ships.
 *
 * WHY THIS EXISTS AT ALL: the client's version can only ever run while the Applications page is
 * mounted in an open browser tab - NextMatchCard's own countdown is what calls submit-request, and
 * nothing else in the system ever does. Measured live 2026-08-20: three hours with automatic
 * submission on and the dashboard tab not open produced zero sends, because nothing was ever
 * queued for the (working, every-15-minutes) submission-runner cron to process. This is the
 * missing half: find the next match and queue it, with no browser required.
 */

/** The two facts this needs off a packet's stored review, read out of spec._review. */
export type SendableReview = {
  status?: string;
  portal_supported?: boolean;
};

const READY_STATUSES = new Set(['resume_ready', 'questions_ready', 'ready_to_submit']);

/** Built and waiting to go out, on a portal Litos can actually reach. */
export function reviewCanBeSent(review: SendableReview | null | undefined): boolean {
  return READY_STATUSES.has(review?.status ?? '') && review?.portal_supported !== false;
}

export type MatchablePacket = {
  id: string;
  created_at: string | null;
  job_context: { company?: string | null; role?: string | null; job_id?: string | null };
  review: SendableReview | null | undefined;
  reviewUpdatedAt: string | null;
};

export type MatchableJob = {
  id: string;
  company_name: string;
  title: string;
};

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Whether this packet is the one for this posting. Prefers the posting id; company+role is the
 *  fallback for packets built before job_id was recorded. Mirrors packetMatchesJob exactly. */
export function packetMatchesJob(packet: MatchablePacket, job: MatchableJob): boolean {
  const packetJobId = packet.job_context.job_id;
  if (packetJobId) return packetJobId === job.id;
  return normalized(packet.job_context.company) === normalized(job.company_name)
    && normalized(packet.job_context.role) === normalized(job.title);
}

/** Select the next ready packet in the ranking order GET /jobs already returned. Iterating jobs
 *  first, not packets, is what keeps this obeying the same ranking authority the dashboard shows -
 *  a packet for a posting that has since rotated off the current ranked list is never chosen, even
 *  if it is otherwise ready. Mirrors nextPreferredReadyPacket exactly. */
export function nextPreferredReadyPacket(
  packets: readonly MatchablePacket[],
  rankedJobs: readonly MatchableJob[],
): MatchablePacket | null {
  for (const job of rankedJobs) {
    const matching = packets
      .filter((packet) => reviewCanBeSent(packet.review))
      .filter((packet) => packetMatchesJob(packet, job))
      .sort((a, b) => (b.reviewUpdatedAt ?? b.created_at ?? '').localeCompare(a.reviewUpdatedAt ?? a.created_at ?? ''));
    if (matching[0]) return matching[0];
  }
  return null;
}
