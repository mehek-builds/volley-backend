import assert from 'node:assert/strict';
import test from 'node:test';
import { packetQuestionFixpoint } from './packetQuestionIdentity';

test('packet question identity reaches a real multi-pass fixpoint', () => {
  const result = packetQuestionFixpoint(
    [{ answer: 'raw', provenance: 'legacy' }],
    ([question]) => {
      if (question.provenance === 'legacy') return [{ answer: question.answer, provenance: 'current' }];
      if (question.answer === 'raw') return [{ answer: 'canonical', provenance: 'current' }];
      return [{ ...question }];
    },
  );
  assert.deepEqual(result, [{ answer: 'canonical', provenance: 'current' }]);
});

test('packet question identity refuses a cycle instead of choosing one side', () => {
  assert.throws(
    () => packetQuestionFixpoint(
      [{ answer: 'A' }],
      ([question]) => [{ answer: question.answer === 'A' ? 'B' : 'A' }],
    ),
    /did not settle to one stable packet identity/,
  );
});

test('packet question identity refuses an overlong non-cyclic chain', () => {
  assert.throws(
    () => packetQuestionFixpoint(
      [{ answer: '0' }],
      ([question]) => [{ answer: String(Number(question.answer) + 1) }],
    ),
    /did not settle to one stable packet identity/,
  );
});
