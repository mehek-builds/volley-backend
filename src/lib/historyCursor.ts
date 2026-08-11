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

/**
 * The position of one row in the (created_at desc, id desc) ordering.
 *
 * THE TIMESTAMP IS TEXT, NOT A `Date`, AND THAT IS THE WHOLE POINT OF THE TYPE. Postgres stores
 * timestamptz at MICROSECOND resolution; a JavaScript Date holds MILLISECONDS, and node-postgres
 * truncates on the way in. Building the cursor from a Date therefore emits a boundary EARLIER than
 * the row it names: a row stored at 10:28:59.755123Z encodes as 10:28:59.755000Z.
 *
 * That gap is not harmless, because the ordering is descending and the predicate is strict. Rows
 * whose true timestamp falls inside (755000, 755123] belong on the NEXT page, and every one of them
 * fails `created_at < 755000`. They are skipped, permanently, with no error and no gap in the
 * numbering for anyone to notice: exactly the silent disappearance this whole file exists to end,
 * reintroduced by the mechanism meant to fix it.
 *
 * Measured on production on 2026-08-11, the exposure is currently zero. The owner's 158 rows share
 * no millisecond and their closest neighbours are 1972.142 ms apart; across all 416 rows the
 * closest pair is 89.984 ms apart. So this is latent rather than live, and it is fixed anyway,
 * because the condition that produces sub-millisecond neighbours is a bulk generation run and the
 * dashboard prewarms up to 30 resumes a day.
 *
 * The route reads the timestamp with `to_char(... 'US')`, so what travels here is the value
 * Postgres holds, rendered by Postgres, and it is never parsed into a Date on the way back.
 */
export type HistoryCursor = {
  /**
   * ISO 8601 UTC as Postgres rendered it, to microseconds. Null for a row whose created_at is
   * null; those sort first, see the route's order by.
   */
  createdAt: string | null;
  id: string;
};

/** Undated rows encode their timestamp as the empty string, which round-trips back to null. */
const SEPARATOR = '|';

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(`${cursor.createdAt ?? ''}${SEPARATOR}${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * Null for anything this route did not mint: a truncated string, a non-uuid id, a timestamp that is
 * not a timestamp. The caller treats null as "start from the beginning" rather than as an error,
 * because a stale cursor from a bookmarked URL should hand back the first page instead of a 400 the
 * student cannot act on.
 *
 * The timestamp is validated and then passed through UNCHANGED. Round-tripping it via `new Date()`
 * would re-truncate it to milliseconds and undo the precision the route went to the trouble of
 * reading, so the check has to be a shape check rather than a parse.
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
  if (!isUtcTimestamp(at)) return null;
  return { createdAt: at, id };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Up to six fractional digits, which is every precision Postgres can store in a timestamptz. */
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function isUuid(value: string): boolean {
  return UUID.test(value);
}

function isUtcTimestamp(value: string): boolean {
  /* Shape first, then a real-calendar check, because the regex happily admits 2026-02-31 and this
     string is bound straight into a ::timestamptz. Postgres answers a date like that with an error,
     which would turn a hand-edited URL into a 500.
     `Number.isNaN(new Date(...))` is NOT that check: JavaScript rolls 2026-02-31 forward to March
     3 rather than rejecting it. Re-rendering and comparing the seconds prefix catches the rollover.
     Only the validity is read from the Date; the value that travels on is always the original
     string, fractional digits and all. */
  if (!UTC_TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 19) === value.slice(0, 19);
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
export function historyPage<T extends { id: string; created_at_exact: string | null }>(
  rowsPlusOne: readonly T[],
  limit: number,
): { rows: T[]; nextCursor: string | null } {
  const rows = rowsPlusOne.slice(0, limit);
  const last = rows[rows.length - 1];
  const hasMore = rowsPlusOne.length > limit;
  return {
    rows,
    /* created_at_exact, never the row's own `created_at`. The latter is a JS Date the driver has
       already truncated to milliseconds, and a cursor built from it names a boundary earlier than
       the row it points at. See the HistoryCursor type. */
    nextCursor: hasMore && last ? encodeHistoryCursor({ createdAt: last.created_at_exact, id: last.id }) : null,
  };
}
