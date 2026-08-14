import { packetAuditSha256 } from './packetAudit';

// PostgreSQL jsonb is free to reorder object keys. Every retained-document writer and verifier
// uses the same recursive canonical serializer so a valid immutable version survives that round
// trip while any semantic mutation still fails its binding.
export function immutableDocumentContentHash(value: unknown): string {
  return packetAuditSha256(value);
}
