import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDisplayName } from './profile';

describe('normalizeDisplayName', () => {
  test('recases a header printed in block capitals', () => {
    assert.equal(normalizeDisplayName('MIRANDA W. HUDSON'), 'Miranda W. Hudson');
    assert.equal(normalizeDisplayName('ANDREW PETERS'), 'Andrew Peters');
  });

  test('leaves a name that already has lowercase in it completely alone', () => {
    for (const name of ['Mehek Mandal', 'danah boyd', 'Ludwig van Beethoven', 'DeShawn Carter']) {
      assert.equal(normalizeDisplayName(name), name);
    }
  });

  test('keeps the internal capital of Mc, Mac and O names', () => {
    assert.equal(normalizeDisplayName('SEAN MCDONALD'), 'Sean McDonald');
    assert.equal(normalizeDisplayName("MAEVE O'BRIEN"), "Maeve O'Brien");
    assert.equal(normalizeDisplayName('FIONA MACLEOD'), 'Fiona MacLeod');
  });

  test('a hyphenated surname is two names, and both are capitalised', () => {
    assert.equal(normalizeDisplayName('ANNA SMITH-JONES'), 'Anna Smith-Jones');
  });

  test('a compound surname keeps its lowercase particle', () => {
    assert.equal(normalizeDisplayName('JAN VAN DER BERG'), 'Jan van der Berg');
    assert.equal(normalizeDisplayName('MARIA DE LA CRUZ'), 'Maria de la Cruz');
  });

  test('a middle initial stays an initial', () => {
    assert.equal(normalizeDisplayName('J R R TOLKIEN'), 'J R R Tolkien');
    assert.equal(normalizeDisplayName('SAMUEL L. JACKSON'), 'Samuel L. Jackson');
  });

  test('empty and whitespace input survive', () => {
    assert.equal(normalizeDisplayName(''), '');
    assert.equal(normalizeDisplayName('   '), '');
    assert.equal(normalizeDisplayName('  MIRANDA   HUDSON '), 'Miranda Hudson');
  });
});
