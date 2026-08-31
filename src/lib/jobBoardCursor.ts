import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const JOB_BOARD_CURSOR_START = 'start';
export const JOB_BOARD_CURSOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const JOB_BOARD_CURSOR_FUTURE_SKEW_MS = 5 * 60 * 1000;
const JOB_BOARD_CURSOR_VERSION = 1;

export type JobsCursorKey = {
  q_rank: 0 | 1;
  title_rank: 0 | 1;
  posted_at: string | null;
  first_seen_at: string;
  id: string;
};

export type GroupedJobsCursorKey = {
  q_rank: 0 | 1;
  title_rank: 0 | 1;
  posted_at: string | null;
  first_seen_at: string;
  tie_id: string;
};

export type JobBoardCursorState =
  | {
    route: 'jobs';
    asOf: Date;
    filterHash: string;
    total: number;
    key: JobsCursorKey;
  }
  | {
    route: 'grouped';
    asOf: Date;
    filterHash: string;
    total: number;
    postingsTotal: number;
    key: GroupedJobsCursorKey;
  };

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const dateTimeSchema = z.string().datetime({ offset: true });
const rankSchema = z.union([z.literal(0), z.literal(1)]);
const inventoryCountSchema = z.number().int().nonnegative().max(1_000_000_000);

const jobsCursorKeySchema = z.object({
  q_rank: rankSchema,
  title_rank: rankSchema,
  posted_at: dateTimeSchema.nullable(),
  first_seen_at: dateTimeSchema,
  id: z.string().uuid(),
}).strict();

const groupedJobsCursorKeySchema = z.object({
  q_rank: rankSchema,
  title_rank: rankSchema,
  posted_at: dateTimeSchema.nullable(),
  first_seen_at: dateTimeSchema,
  tie_id: z.string().uuid(),
}).strict();

const cursorPayloadSchema = z.discriminatedUnion('route', [
  z.object({
    v: z.literal(JOB_BOARD_CURSOR_VERSION),
    route: z.literal('jobs'),
    as_of: dateTimeSchema,
    filter_sha256: sha256Schema,
    total: inventoryCountSchema,
    key: jobsCursorKeySchema,
  }).strict(),
  z.object({
    v: z.literal(JOB_BOARD_CURSOR_VERSION),
    route: z.literal('grouped'),
    as_of: dateTimeSchema,
    filter_sha256: sha256Schema,
    total: inventoryCountSchema,
    postings_total: inventoryCountSchema,
    key: groupedJobsCursorKeySchema,
  }).strict(),
]);

export class JobBoardCursorError extends Error {
  constructor(
    public readonly code: 'invalid' | 'expired' | 'mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'JobBoardCursorError';
  }
}

function canonicalJsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    );
  }
  return value;
}

/** Stable binding for all filters that can change which rows a cursor is allowed to traverse. */
export function jobBoardCursorFilterHash(filters: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(filters)))
    .digest('hex');
}

/** Reuse the deployed JWT trust root unless Railway supplies a separately rotatable cursor secret. */
export function jobBoardCursorSigningSecret(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  return environment.JOB_BOARD_CURSOR_SECRET?.trim()
    || environment.JWT_SIGNING_SECRET?.trim()
    || null;
}

function payloadFor(state: JobBoardCursorState) {
  const common = {
    v: JOB_BOARD_CURSOR_VERSION,
    route: state.route,
    as_of: state.asOf.toISOString(),
    filter_sha256: state.filterHash,
    key: state.key,
  };
  return state.route === 'jobs'
    ? { ...common, total: state.total }
    : { ...common, total: state.total, postings_total: state.postingsTotal };
}

export function encodeJobBoardCursor(state: JobBoardCursorState, secret: string): string {
  if (!secret.trim()) throw new Error('Job board cursor signing secret is not configured');
  const parsed = cursorPayloadSchema.parse(payloadFor(state));
  const encoded = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function decodeJobBoardCursor(
  token: string,
  expected: { route: JobBoardCursorState['route']; filterHash: string },
  secret: string,
  now = Date.now(),
): JobBoardCursorState {
  if (!secret.trim()) throw new Error('Job board cursor signing secret is not configured');
  const parts = token.split('.');
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new JobBoardCursorError('invalid', 'Malformed job board cursor');
  }
  const [encoded, suppliedSignature] = parts;
  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedSignature, 'base64url');
  } catch {
    throw new JobBoardCursorError('invalid', 'Malformed job board cursor signature');
  }
  const wanted = createHmac('sha256', secret).update(encoded).digest();
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    throw new JobBoardCursorError('invalid', 'Invalid job board cursor signature');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new JobBoardCursorError('invalid', 'Malformed job board cursor payload');
  }
  const parsed = cursorPayloadSchema.safeParse(decoded);
  if (!parsed.success) throw new JobBoardCursorError('invalid', 'Invalid job board cursor payload');
  if (parsed.data.route !== expected.route || parsed.data.filter_sha256 !== expected.filterHash) {
    throw new JobBoardCursorError('mismatch', 'Job board cursor does not match these filters');
  }
  const asOf = new Date(parsed.data.as_of);
  if (asOf.getTime() > now + JOB_BOARD_CURSOR_FUTURE_SKEW_MS) {
    throw new JobBoardCursorError('invalid', 'Job board cursor is from the future');
  }
  if (asOf.getTime() < now - JOB_BOARD_CURSOR_TTL_MS) {
    throw new JobBoardCursorError('expired', 'Job board cursor has expired');
  }
  return parsed.data.route === 'jobs'
    ? {
      route: 'jobs',
      asOf,
      filterHash: parsed.data.filter_sha256,
      total: parsed.data.total,
      key: parsed.data.key,
    }
    : {
      route: 'grouped',
      asOf,
      filterHash: parsed.data.filter_sha256,
      total: parsed.data.total,
      postingsTotal: parsed.data.postings_total,
      key: parsed.data.key,
    };
}
