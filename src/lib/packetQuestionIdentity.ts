import { isDeepStrictEqual } from 'node:util';

const PACKET_QUESTION_FIXPOINT_MAX_PASSES = 8;

/**
 * Apply one deterministic question transform until the complete records settle.
 *
 * Full-record equality is intentional. Packet identity projects question records down to the
 * fields an employer receives, but a provenance-only change on one pass can change a visible
 * answer on the next. Stopping on the visible hash alone can therefore accept an intermediate
 * value rather than a true fixpoint.
 *
 * A cycle or an unexpectedly long chain is refused. Choosing one member of a cycle would make
 * consecutive requests alternate between packet identities.
 */
export function packetQuestionFixpoint<T>(
  initial: readonly T[],
  transform: (questions: readonly T[]) => T[],
): T[] {
  let current = [...initial];
  for (let pass = 0; pass < PACKET_QUESTION_FIXPOINT_MAX_PASSES; pass += 1) {
    const next = transform(current);
    if (isDeepStrictEqual(next, current)) return next;
    current = next;
  }
  throw new Error('The application questions did not settle to one stable packet identity.');
}
