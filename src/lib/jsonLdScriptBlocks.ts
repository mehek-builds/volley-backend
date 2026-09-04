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
 * FIX: match the open tag's `type` attribute with an optional `;`-led suffix, then scan every
 * SUBSEQUENT `</script` occurrence in the document as a CANDIDATE end position (nearest first) and
 * accept the first one whose captured span actually parses as JSON - a strict parse first, then the
 * existing control-character repair (sanitizeControlCharactersInJsonStrings below, needed for
 * Teamtailor's own raw-control-character defect - see jsonLdJobDescription.ts's header) on failure.
 * A block with no candidate span that ever parses is skipped, exactly like the old catch-and-continue
 * behavior - this only widens what counts as a MATCH, it never accepts something invalid.
 */

const SCRIPT_OPEN_TAG_RE = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json(?:\s*;[^"']*)?["'][^>]*>/gi;
const SCRIPT_CLOSE_TAG_RE = /<\/script\s*>/gi;

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
 * Every successfully parsed `<script type="application/ld+json">` block on `html`, in document
 * order. Each open tag is matched once; for it, every SUBSEQUENT `</script` occurrence in the
 * document is tried as a candidate end position (nearest first) until one parses, so a literal
 * `</script` sequence embedded inside the block's own JSON string content (see this file's header)
 * cannot truncate a real block early. A block with no candidate span that ever parses is skipped, not
 * thrown - the same best-effort contract the two callers already have for a malformed block.
 */
export function parsedJsonLdScriptBlocks(html: string): unknown[] {
  const results: unknown[] = [];
  // Fresh RegExp instances per call (not shared module-level regexes): both carry `g` + `.exec`
  // state, and a shared instance would let two concurrent requests interleave through the same
  // `lastIndex` - the same reason each caller's own former scan built its regex function-locally.
  const openPattern = new RegExp(SCRIPT_OPEN_TAG_RE.source, SCRIPT_OPEN_TAG_RE.flags);
  let openMatch: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign -- straightforward regex scan
  while ((openMatch = openPattern.exec(html))) {
    const contentStart = openMatch.index + openMatch[0].length;
    const closePattern = new RegExp(SCRIPT_CLOSE_TAG_RE.source, SCRIPT_CLOSE_TAG_RE.flags);
    closePattern.lastIndex = contentStart;
    let closeMatch: RegExpExecArray | null;
    let matchedEnd: number | undefined;
    // eslint-disable-next-line no-cond-assign -- straightforward regex scan
    while ((closeMatch = closePattern.exec(html))) {
      const parsed = parseJsonLdCandidate(html.slice(contentStart, closeMatch.index));
      if (parsed !== undefined) {
        results.push(parsed);
        matchedEnd = closeMatch.index + closeMatch[0].length;
        break;
      }
    }
    // No candidate span ever parsed (or the script block is never closed at all): resume scanning
    // for the next open tag right after this one, rather than re-trying the same content again.
    openPattern.lastIndex = matchedEnd ?? contentStart;
  }
  return results;
}
