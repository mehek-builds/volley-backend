/**
 * Shared `<script type="application/ld+json">` block extraction for jsonLdJobDescription.ts and
 * recruiteeJobDescription.ts (2026-09-04 review round 1, finding 4) - ONE implementation, so a fix
 * to how a JSON-LD block is found and parsed cannot land in one reader and not the other the way two
 * independent copies of the same regex already had.
 *
 * TWO DEFECTS the previous per-file regex
 * (`<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>`) shared:
 *
 *   1. A charset (or any other) parameter on the type attribute -
 *      `type="application/ld+json; charset=utf-8"` - never matched the exact-string type check
 *      (`["']application\/ld\+json["']` demands the attribute value end right there), so a page
 *      serving its JSON-LD that way was read as carrying no JobPosting block at all.
 *   2. The non-greedy `[\s\S]*?` capture stops at the FIRST `</script` it sees. A JobPosting
 *      `description` field legitimately carries the posting's own HTML, and that HTML can itself
 *      contain a literal `</script` sequence inside a JSON string value (any page whose description
 *      happens to quote or discuss a `<script>` tag) - the non-greedy capture truncates there, before
 *      the block's real end, and the truncated prefix is not valid JSON.
 *
 * Round 1's fix for both: match the open tag's `type` attribute with an optional `;`-led suffix, then
 * treat every SUBSEQUENT `</script` occurrence in the document as a CANDIDATE end position (nearest
 * first) and accept the first one whose captured span actually parses as JSON - a strict parse first,
 * then the existing control-character repair (sanitizeControlCharactersInJsonStrings below, needed
 * for Teamtailor's own raw-control-character defect - see jsonLdJobDescription.ts's header) on
 * failure. A block with no candidate span that ever parses is skipped, exactly like the old
 * catch-and-continue behavior - this only widens what counts as a MATCH, it never accepts something
 * invalid.
 *
 * A THIRD DEFECT (2026-09-04, review round 2) in that very fix: "every SUBSEQUENT `</script`
 * occurrence" is unbounded, and each candidate is JSON.parse-d (twice - see parseJsonLdCandidate)
 * over an EVER-GROWING slice, so the true cost is worse than quadratic once JSON.parse's own cost is
 * counted and not just the candidate count. A single open tag followed by one unterminated JSON
 * string packed with `</script>` repeats turns every repeat into a full re-scan-and-reparse of
 * everything before it - synchronous, blocking the whole Node process. The route this feeds
 * (jobExtract, recruiteeJobDescription) accepts a user-supplied URL, so a hostile page controls the
 * input directly. MEASURED against one MAX_HTML_BYTES (200,000-byte) document built from a single
 * open tag plus a single unterminated JSON string of `</script>` repeats:
 *
 *     50 KB  ->  2.9s
 *     100 KB -> 23s
 *     200 KB -> 49.7s
 *
 * FIX: a block's real end can be found in ONE forward pass with no re-parsing at all, because valid
 * JSON never places a bare `<` outside a string - nearestScriptCloseOutsideString below tracks JSON
 * string/escape state exactly like sanitizeControlCharactersInJsonStrings already does, and returns
 * the nearest `</script` that occurs OUTSIDE a string. That is provably the block's true end for any
 * well-formed candidate, found in a single scan, parsed exactly once. Only a block whose one primary
 * candidate fails to parse - genuinely malformed content, not merely a `</script` sequence quoted
 * inside a string - falls back to trying a few more literal `</script` occurrences the way round 1
 * did, but now hard-capped so a hostile document can no longer turn that fallback back into the same
 * blow-up:
 *
 *   - at most MAX_CANDIDATE_ENDS_PER_OPEN_TAG (8) candidate end positions are ever tried for one open
 *     tag, including the primary one - generous for any real posting, which needs exactly one;
 *   - at most MAX_OPEN_TAGS_PER_DOCUMENT (32) open tags are ever scanned per document - a real
 *     posting carries a handful of JSON-LD blocks at most (this file's own tests read live fixtures
 *     whose JobPosting block is 2.4 KB and 9.5 KB respectively - one block each);
 *   - a candidate span longer than MAX_CANDIDATE_SPAN_BYTES (50,000) is skipped without ever reaching
 *     JSON.parse - over five times either real fixture above, and still five times smaller than the
 *     50 KB input that alone already cost 2.9s under the old algorithm.
 *
 * A block with no candidate span that ever parses is still skipped, not thrown, exactly as round 1 -
 * these caps only bound the COST of looking, they never change which well-formed block is found.
 */

const SCRIPT_OPEN_TAG_RE = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json(?:\s*;[^"']*)?["'][^>]*>/gi;
const SCRIPT_CLOSE_TAG_RE = /<\/script\s*>/gi;
const CLOSE_TAG_WHITESPACE_RE = /\s/;

/** Hard caps closing the round-2 DoS documented above - none is ever reached by a real posting. */
export const MAX_OPEN_TAGS_PER_DOCUMENT = 32;
export const MAX_CANDIDATE_ENDS_PER_OPEN_TAG = 8;
export const MAX_CANDIDATE_SPAN_BYTES = 50_000;

/**
 * Escapes bare control characters (U+0000-U+001F) found INSIDE a JSON string literal, leaving
 * everything outside a string untouched - such bytes are already just insignificant whitespace
 * between tokens under the JSON grammar (RFC 8259 S2), including the ordinary newlines any
 * pretty-printed JSON-LD block uses between object members.
 *
 * MEASURED LIVE 2026-09-04 (see jsonLdJobDescription.ts's header): Teamtailor's own JobPosting block
 * contains a literal, unescaped newline inside its `description` string. Both Node's and every
 * browser's native `JSON.parse` reject that verbatim - not a parser bug, the document is malformed
 * JSON by spec - which is why callers try a strict parse first and only reach for this on failure: it
 * performs the same narrow repair a lenient consumer would, and cannot alter meaning anywhere a
 * strict parser would have accepted the input unchanged.
 *
 * A small hand-rolled string-boundary scan rather than a regex, specifically so an ESCAPED quote
 * (`\"`) inside a string can never be mistaken for the string's end - the one detail that makes a
 * regex-based version of this unsafe.
 */
export function sanitizeControlCharactersInJsonStrings(raw: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const code = raw.charCodeAt(i);
    if (inString && escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (inString && ch === '\\') {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && code < 0x20) {
      switch (ch) {
        case '\n': result += '\\n'; break;
        case '\r': result += '\\r'; break;
        case '\t': result += '\\t'; break;
        case '\b': result += '\\b'; break;
        case '\f': result += '\\f'; break;
        default: result += `\\u${code.toString(16).padStart(4, '0')}`;
      }
      continue;
    }
    result += ch;
  }
  return result;
}

/** `undefined` on any parse failure, tried strict first and then through the control-character
 *  repair - never throws, so callers can treat a candidate span as a plain yes/no. `JSON.parse` can
 *  never itself produce the JS value `undefined` from valid input, so it is an unambiguous sentinel
 *  for "this span is not (repairably) valid JSON" and never mistaken for a successfully parsed
 *  literal `null`. */
function parseJsonLdCandidate(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(sanitizeControlCharactersInJsonStrings(text));
    } catch {
      return undefined;
    }
  }
}

/**
 * The length of a `</script` close tag - case-insensitively, with any amount of whitespace before
 * the closing `>`, the same shape SCRIPT_CLOSE_TAG_RE matches - starting EXACTLY at `index`, or
 * `undefined` if none starts there. Hand-rolled rather than re-testing the shared regex at one
 * position so the forward scan below never allocates or runs a regex per character.
 */
function scriptCloseTagLengthAt(html: string, index: number): number | undefined {
  if (html[index] !== '<' || html[index + 1] !== '/') return undefined;
  if (html.slice(index + 2, index + 8).toLowerCase() !== 'script') return undefined;
  let i = index + 8;
  while (CLOSE_TAG_WHITESPACE_RE.test(html[i] ?? '')) i += 1;
  return html[i] === '>' ? i + 1 - index : undefined;
}

/**
 * The index of the nearest `</script` close tag at or after `from` and before `limit` that occurs
 * OUTSIDE a JSON string, or `undefined` if none does. Tracks JSON string/escape state exactly like
 * sanitizeControlCharactersInJsonStrings above (a `"` toggles the state unless it was itself
 * escaped), so a `</script` sequence embedded inside the block's own JSON string content - raw, or
 * backslash-escaped as `<\/script` - is walked straight through rather than mistaken for the block's
 * end. Because valid JSON never places a bare `<` outside a string, the first such occurrence is
 * provably the block's real close tag whenever the content between `from` and it is well-formed
 * JSON - found in one linear pass, with no candidate ever re-tried.
 */
function nearestScriptCloseOutsideString(html: string, from: number, limit: number): number | undefined {
  let inString = false;
  let escaped = false;
  const end = Math.min(html.length, limit);
  for (let i = from; i < end; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '<' && scriptCloseTagLengthAt(html, i) !== undefined) return i;
  }
  return undefined;
}

/**
 * Every successfully parsed `<script type="application/ld+json">` block on `html`, in document
 * order, up to MAX_OPEN_TAGS_PER_DOCUMENT open tags. For each, nearestScriptCloseOutsideString finds
 * the block's true end in one linear pass and it is parsed exactly once; only if that fails to parse
 * does a bounded fallback try a few more literal `</script` occurrences, nearest first, the way
 * review round 1 did - capped at MAX_CANDIDATE_ENDS_PER_OPEN_TAG total and MAX_CANDIDATE_SPAN_BYTES
 * per candidate. See this file's header for why (the round-2 DoS) and the measured numbers behind
 * each cap. A block with no candidate span that ever parses is skipped, not thrown - the same
 * best-effort contract the two callers already have for a malformed block.
 */
export function parsedJsonLdScriptBlocks(html: string): unknown[] {
  const results: unknown[] = [];
  // Fresh RegExp instances per call (not shared module-level regexes): both carry `g` + `.exec`
  // state, and a shared instance would let two concurrent requests interleave through the same
  // `lastIndex` - the same reason each caller's own former scan built its regex function-locally.
  const openPattern = new RegExp(SCRIPT_OPEN_TAG_RE.source, SCRIPT_OPEN_TAG_RE.flags);
  let openMatch: RegExpExecArray | null;
  let openTagsSeen = 0;
  // eslint-disable-next-line no-cond-assign -- straightforward regex scan
  while (openTagsSeen < MAX_OPEN_TAGS_PER_DOCUMENT && (openMatch = openPattern.exec(html))) {
    openTagsSeen += 1;
    const contentStart = openMatch.index + openMatch[0].length;
    const spanLimit = contentStart + MAX_CANDIDATE_SPAN_BYTES;
    let matchedEnd: number | undefined;

    const primaryClose = nearestScriptCloseOutsideString(html, contentStart, spanLimit);
    if (primaryClose !== undefined) {
      const primaryCloseLen = scriptCloseTagLengthAt(html, primaryClose)!;
      const primaryParsed = parseJsonLdCandidate(html.slice(contentStart, primaryClose));
      if (primaryParsed !== undefined) {
        results.push(primaryParsed);
        matchedEnd = primaryClose + primaryCloseLen;
      } else {
        // The one candidate a well-formed block would ever need failed to parse - genuinely
        // malformed content, not just a `</script` quoted inside a string. Bounded fallback: a few
        // more literal `</script` occurrences, nearest first, capped so this can no longer become
        // the round-2 blow-up (see header).
        const closePattern = new RegExp(SCRIPT_CLOSE_TAG_RE.source, SCRIPT_CLOSE_TAG_RE.flags);
        closePattern.lastIndex = primaryClose + primaryCloseLen;
        let candidatesTried = 1; // the primary candidate above already counts as one
        let closeMatch: RegExpExecArray | null;
        // eslint-disable-next-line no-cond-assign -- straightforward regex scan
        while (candidatesTried < MAX_CANDIDATE_ENDS_PER_OPEN_TAG && (closeMatch = closePattern.exec(html))) {
          if (closeMatch.index > spanLimit) break;
          candidatesTried += 1;
          const parsed = parseJsonLdCandidate(html.slice(contentStart, closeMatch.index));
          if (parsed !== undefined) {
            results.push(parsed);
            matchedEnd = closeMatch.index + closeMatch[0].length;
            break;
          }
        }
      }
    }
    // No candidate span ever parsed (or the script block is never closed at all): resume scanning
    // for the next open tag right after this one, rather than re-trying the same content again.
    openPattern.lastIndex = matchedEnd ?? contentStart;
  }
  return results;
}
