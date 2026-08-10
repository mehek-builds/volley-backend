/**
 * The cursor GET /resume/history hands back so the next request can carry on from where the last
 * one stopped.
 *
 * WHY A CURSOR AND NOT A BIGGER NUMBER. The route sent a fixed window of 50 rows with nothing in
 * the response saying a window had been applied. Measured on the owner account on 2026-08-11:
 * generated_resumes held 158 rows, /resume/history answered with 50, and /applications/board
 * answered with all 158 because its own bound is 200. One screen, two counts of the same corpus,
 * and the 108 rows outside the smaller one had no route back: the tracker built its openable set
 * from the history rows, so their board cards rendered inert, and a ?application=<id> deep link
 * for one of them selected nothing at all. Raising 50 to 200 would have matched the board for a
 * few weeks and then reproduced the same defect one bound higher, because the corpus grows every
 * day the student uses the product.
 *
 * KEYSET, NOT OFFSET. Rows are ordered (created_at desc, id desc) and the cursor names the last
 * row of the page rather than counting how many were skipped. OFFSET is shorter and wrong here for
 * two independent reasons:
 *
 *   1. Rows are inserted at the TOP of this ordering while the student is paging through it: the
 *      dashboard prewarms resumes in the background. Every insert shifts the offset by one, so
 *      the next page repeats a row it already sent or skips one it never did, silently.
 *   2. created_at is nullable on the table and unique only by accident. OFFSET over a non-unique
 *      sort key has no defined tie order, so two requests for the same offset may disagree about
 *      which of two resumes written in the same batch belongs on which page.
 *
 * A keyset cursor has neither problem. It is a position in the data, not a position in a result
 * set, so it stays correct while the top of the list grows.
 *
 * OPAQUE ON THE WIRE, AND DELIBERATELY NOT SIGNED. It encodes only the timestamp and id of a row
 * the response just handed the caller, and it is spent against a query already scoped to that
 * caller's own user_id, so a forged cursor can move the caller around inside their own history and
 * nowhere else. A signature would buy nothing and would break every cursor held across a deploy.
 */

/** The position of one row in the (created_at desc, id desc) ordering. */
export type HistoryCursor = {
  /** Null for a row whose created_at is null. Those sort first, see the route's order by. */
  createdAt: Date | null;
  id: string;
};

/** Undated rows encode their timestamp as the empty string, which round-trips back to null. */
const SEPARATOR = '|';

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  const at = cursor.createdAt ? cursor.createdAt.toISOString() : '';
  return Buffer.from(`${at}${SEPARATOR}${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * Null for anything this route did not mint: a truncated string, a non-uuid id, a timestamp that
 * is not a timestamp. The caller treats null as "start from the beginning" rather than as an
 * error, because a stale cursor from a bookmarked URL should hand back the first page instead of
 * a 400 the student cannot act on.
 */
export function decodeHistoryCursor(raw: string | undefined | null): HistoryCursor | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(SEPARATOR);
  if (separator === -1) return null;
  const at = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!isUuid(id)) return null;
  if (at === '') return { createdAt: null, id };
  const createdAt = new Date(at);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * Cut a page out of the limit+1 rows the query asked for, and say whether another page follows.
 *
 * THE EXTRA ROW IS THE POINT. Inferring "there is more" from a full page is wrong exactly when the
 * total is a multiple of the page size: 100 applications at 50 a page hands the student a Load
 * more that fetches nothing and then has to un-say itself. Asking for one more row than will be
 * shown answers the question instead of guessing at it, and costs one row.
 *
 * next_cursor is null on the last page, and that null is the caller's stop condition. A caller that
 * loops until the returned page is short instead would loop forever against a page size of one.
 */
export function historyPage<T extends { id: string; created_at: Date | null }>(
  rowsPlusOne: readonly T[],
  limit: number,
): { rows: T[]; nextCursor: string | null } {
  const rows = rowsPlusOne.slice(0, limit);
  const last = rows[rows.length - 1];
  const hasMore = rowsPlusOne.length > limit;
  return {
    rows,
    nextCursor: hasMore && last ? encodeHistoryCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}
