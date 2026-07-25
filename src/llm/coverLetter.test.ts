import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCoverLetter } from './coverLetter';

const source = 'Mehek worked at Acme Labs and reduced processing time by 35% using Python. Built an analytics pipeline for 40 users.';

test('cover-letter validation strips prohibited dashes and accepts grounded metrics', () => {
  const paragraph = 'I am applying for the Software Engineer role at Acme. At Acme Labs, I used Python to reduce processing time by 35% while building an analytics pipeline for 40 users. ';
  const result = validateCoverLetter(`${paragraph.repeat(7)}This work maps directly to the role.`, 'Acme', 'Software Engineer', source);
  assert.equal(result.body.includes('—'), false);
  assert.equal(result.issues.some((item) => item.includes('ungrounded numbers')), false);
});

test('cover-letter validation blocks fabricated candidate metrics', () => {
  const body = `I am applying for the Software Engineer role at Acme. ${'My work at Acme Labs used Python to build reliable systems. '.repeat(25)}I increased revenue by 82%.`;
  const result = validateCoverLetter(body, 'Acme', 'Software Engineer', source);
  assert.ok(result.issues.some((item) => item.includes('82%')));
});

