import assert from 'node:assert/strict';
import test from 'node:test';
import { validStoredPdf } from './packetAuditService';

test('stored packet PDF requires an exact PDF signature', () => {
  assert.equal(validStoredPdf({ bytes: Buffer.from('%PDF-1.7\npacket') }), true);
  assert.equal(validStoredPdf({ bytes: Buffer.from(' %PDF-1.7\npacket') }), false);
  assert.equal(validStoredPdf({ bytes: Buffer.from('<html>not a resume</html>') }), false);
  assert.equal(validStoredPdf({ bytes: Buffer.alloc(0) }), false);
});

test('stored packet PDF rejects conflicting metadata but permits absent metadata', () => {
  const bytes = Buffer.from('%PDF-1.7\npacket');
  assert.equal(validStoredPdf({ bytes, contentType: 'application/pdf' }), true);
  assert.equal(validStoredPdf({ bytes, contentType: 'application/pdf; charset=binary' }), true);
  assert.equal(validStoredPdf({ bytes }), true);
  assert.equal(validStoredPdf({ bytes, contentType: 'application/octet-stream' }), false);
  assert.equal(validStoredPdf({ bytes, contentType: 'text/html' }), false);
});
