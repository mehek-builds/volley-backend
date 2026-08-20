/* A SESSION TOKEN MINTED BY THE SERVER, FOR THE SERVER'S OWN USE - never handed to a browser, and
 * never reachable over HTTP by anything that is not already inside an authorized internal cron
 * route.
 *
 * WHY THIS EXISTS: the autopilot matcher (routes/autopilotMatcher.ts) has to call the real
 * `GET /jobs` and `POST /applications/:id/submit-request` routes to find and queue a send, and it
 * has to call the REAL ones - re-deriving either route's logic here would drift from what the
 * dashboard shows and, on the submit-request side, from the final safety gate before a real
 * employer receives a real application. The alternative to a minted token is refactoring one or
 * both of those routes to take a bare userId instead of a real request; this is the narrower
 * change; see the PR description for why that tradeoff was made this way.
 *
 * SCOPED AS TIGHT AS A TOKEN CAN BE:
 *   - 5 minutes, not 30 days. It exists for exactly the two in-process inject() calls one matcher
 *     pass makes for one user, immediately after minting.
 *   - authMethod 'legacy'. Not a new value on the union - see middleware/auth.ts, JWTPayload -
 *     because adding one would mean every place that already branches on authMethod has to learn
 *     about system-minted sessions too, for a distinction nothing downstream of auth needs to make.
 *   - Reads session_version and is_guest FRESH per call. resolveToken in middleware/auth.ts
 *     re-derives both from the users row at verify time regardless of what the token claims, so a
 *     stale read here would simply fail verification rather than succeeding on stale authority -
 *     but reading fresh means it fails LOUD (this function throws) instead of quietly (a 401 the
 *     caller has to go work out). session_valid_from needs no read at all: it is compared against
 *     the token's iat, and setIssuedAt() below always stamps "now", which postdates any past
 *     revocation by construction.
 *   - Refuses a guest account outright. Nothing about "send without asking" makes sense for a
 *     session that expires out from under it mid-run.
 */
import { SignJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { users } from '../db/schema';

const TOKEN_TTL = '5m';

export async function mintInternalAutomationToken(userId: string): Promise<string> {
  const secret = process.env.JWT_SIGNING_SECRET;
  if (!secret) throw new Error('JWT_SIGNING_SECRET not configured');

  const [row] = await db
    .select({
      email: users.email,
      is_guest: users.is_guest,
      session_version: users.session_version,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`No such user: ${userId}`);
  if (row.is_guest) throw new Error(`Refusing to mint an internal token for a guest account: ${userId}`);

  const secretBytes = new TextEncoder().encode(secret);
  return new SignJWT({
    userId,
    ...(row.email ? { email: row.email } : {}),
    isGuest: false,
    authMethod: 'legacy',
    sessionVersion: row.session_version,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secretBytes);
}
