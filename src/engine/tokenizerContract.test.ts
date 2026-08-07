import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { tokenizeForMatch } from './jdMatch';
import {
  TOKENIZER_CONTRACT,
  TOKENIZER_CONTRACT_FINGERPRINT,
} from './tokenizer-contract';

/**
 * This repo's half of the tokenizer contract. role-quick-website runs the same corpus against its
 * own tokenizer in features/applications/domain/tokenizer-contract.test.mts.
 *
 * The contract exists because the two implementations drifted once and nothing noticed: the
 * backend split "HTML/CSS" into two requirements and the website did not, so 22.7% of every colour
 * the product owed a student across 25 measured packets was never painted. See the header of
 * tokenizer-contract.ts.
 */
describe('tokenizer contract, backend half', () => {
  for (const contractCase of TOKENIZER_CONTRACT) {
    test(contractCase.name, () => {
      assert.deepEqual(
        tokenizeForMatch(contractCase.text).map((token) => [token.text, token.start]),
        contractCase.tokens.map((token) => [...token]),
        `tokenizeSection disagrees with the shared contract on ${JSON.stringify(contractCase.text)}`,
      );
    });
  }

  test('the corpus itself has not been edited without refreshing the fingerprint', () => {
    // Not a checksum of this file, of the CASES: reworded prose above must not force a resync, and
    // a changed expectation must. When this fails, the corpus changed; put the printed digest in
    // TOKENIZER_CONTRACT_FINGERPRINT and copy the file to role-quick-website, whose own contract
    // test is now the thing standing between the change and a silently colourless pane.
    const digest = createHash('sha256').update(JSON.stringify(TOKENIZER_CONTRACT)).digest('hex');
    assert.equal(
      digest,
      TOKENIZER_CONTRACT_FINGERPRINT,
      `the shared tokenizer corpus changed. New fingerprint: ${digest}. Copy src/engine/tokenizer-contract.ts to role-quick-website/features/applications/domain/tokenizer-contract.ts.`,
    );
  });

  test('every token the contract expects is found at the offset it claims', () => {
    // Guards the corpus rather than the tokenizer: an offset typed by hand that does not point at
    // the text it names would make a passing contract meaningless.
    for (const contractCase of TOKENIZER_CONTRACT) {
      for (const [text, start] of contractCase.tokens) {
        assert.equal(
          contractCase.text.slice(start, start + text.length),
          text,
          `${contractCase.name}: offset ${start} does not point at ${JSON.stringify(text)}`,
        );
      }
    }
  });
});
