import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, toBullets } from './profile';

/* Measured 2026-07-27 on a real 2-page CV: all ten bank entries came back holding a single
 * bullet_variant, each a run-on of three or four separate achievements, because the parse returns
 * prose and toBullets only split on newlines. */

describe('splitSentences', () => {
  test('splits the run-on the parser actually produced', () => {
    assert.deepEqual(
      splitSentences(
        'Synthesized and purified hundreds of oligonucleotides. Synthesized DNA. Constructed a cosmid library from human blood DNA.',
      ),
      [
        'Synthesized and purified hundreds of oligonucleotides.',
        'Synthesized DNA.',
        'Constructed a cosmid library from human blood DNA.',
      ],
    );
  });

  test('a company suffix is not the end of a sentence', () => {
    assert.deepEqual(
      splitSentences('Worked at ZymoGenetics, Inc. Executed a DNA fingerprinting project.'),
      ['Worked at ZymoGenetics, Inc. Executed a DNA fingerprinting project.'],
    );
  });

  test('an initial is not the end of a sentence', () => {
    assert.deepEqual(
      splitSentences('Reported to Andrew H. Peters on weekly lab results.'),
      ['Reported to Andrew H. Peters on weekly lab results.'],
    );
  });

  test('a degree abbreviation is not the end of a sentence', () => {
    assert.deepEqual(
      splitSentences('Supported a Ph.D. Candidate through two publication cycles.'),
      ['Supported a Ph.D. Candidate through two publication cycles.'],
    );
  });

  test('a decimal is never a boundary', () => {
    assert.deepEqual(splitSentences('Cut latency by 3.5x across the fleet.'), [
      'Cut latency by 3.5x across the fleet.',
    ]);
  });

  test('a lowercase continuation is not a boundary', () => {
    assert.deepEqual(splitSentences('Shipped v2.0 to production. then monitored it'), [
      'Shipped v2.0 to production. then monitored it',
    ]);
  });

  test('a single sentence stays one bullet', () => {
    assert.deepEqual(splitSentences('Built the thing.'), ['Built the thing.']);
    assert.deepEqual(splitSentences(''), []);
  });
});

describe('toBullets', () => {
  test('newlines still win when the parse gives us them', () => {
    assert.deepEqual(toBullets('• Built the thing.\n• Shipped the thing.'), [
      'Built the thing.',
      'Shipped the thing.',
    ]);
  });

  test('prose is recovered into one bullet per achievement', () => {
    assert.deepEqual(toBullets('Built the thing. Shipped the thing. Measured the thing.'), [
      'Built the thing.',
      'Shipped the thing.',
      'Measured the thing.',
    ]);
  });

  test('a mixed description keeps both structures', () => {
    assert.deepEqual(toBullets('- Built it. Shipped it.\n- Measured it.'), [
      'Built it.',
      'Shipped it.',
      'Measured it.',
    ]);
  });

  test('an empty description produces nothing to store', () => {
    assert.deepEqual(toBullets(''), []);
    assert.deepEqual(toBullets('   \n  '), []);
  });
});
