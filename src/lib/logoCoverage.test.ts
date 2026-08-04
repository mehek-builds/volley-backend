import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { logoCoverageFloor, MINIMUM_LOGO_COVERAGE, tallyCoverage } from './logoCoverage';

test('logo coverage can never be configured below 75 percent', () => {
  assert.equal(MINIMUM_LOGO_COVERAGE, 0.75);
  assert.equal(logoCoverageFloor(undefined), 0.75);
  assert.equal(logoCoverageFloor('0.55'), 0.75);
  assert.equal(logoCoverageFloor('invalid'), 0.75);
});

test('logo coverage may be raised but never above 100 percent', () => {
  assert.equal(logoCoverageFloor('0.8'), 0.8);
  assert.equal(logoCoverageFloor('2'), 1);
});

describe('tallyCoverage', () => {
  const mapped = (n: string) => ['Zscaler', 'Lucid'].includes(n);

  test('coverage is weighted by rows, not by companies', () => {
    // One big employer mapped and three tiny ones unmapped is a board that mostly shows logos.
    // Counting companies would call this 25%; counting rows calls it 99%, which is what a person
    // scrolling the board actually sees.
    const t = tallyCoverage([
      { company_name: 'Zscaler', rows: 300 },
      { company_name: 'Huckberry', rows: 1 },
      { company_name: 'Wrisk', rows: 1 },
      { company_name: 'Lifely', rows: 1 },
    ], mapped);

    assert.equal(t.totalRows, 303);
    assert.equal(t.rowsWithLogo, 300);
    assert.ok(t.coverage > 0.98 && t.coverage < 1);
    assert.deepEqual(t.withoutLogo, ['Huckberry', 'Wrisk', 'Lifely']);
    assert.equal(t.companies.length, 4);
  });

  test('an empty board is 0 coverage rather than a divide by zero', () => {
    const t = tallyCoverage([], mapped);
    assert.equal(t.totalRows, 0);
    assert.equal(t.coverage, 0);
    assert.deepEqual(t.companies, []);
  });

  test('a company with no rows cannot move the verdict', () => {
    const t = tallyCoverage([
      { company_name: 'Zscaler', rows: 10 },
      { company_name: 'Ghost Co', rows: 0 },
    ], mapped);
    assert.equal(t.totalRows, 10);
    assert.equal(t.coverage, 1);
    assert.deepEqual(t.withoutLogo, ['Ghost Co']);
  });

  test('a broken row count fails loudly instead of skewing coverage', () => {
    // A negative or NaN count means the measurement is wrong, and silently summing it would move
    // the number the floor is checked against.
    for (const rows of [-5, NaN, Infinity]) {
      assert.throws(
        () => tallyCoverage([{ company_name: 'Zscaler', rows }], mapped),
        /row count/,
        `rows=${rows} must be rejected`,
      );
    }
  });

  test('blank company names are skipped, not counted as an employer', () => {
    const t = tallyCoverage([
      { company_name: 'Zscaler', rows: 5 },
      { company_name: '', rows: 99 },
    ], mapped);
    assert.equal(t.totalRows, 5);
    assert.equal(t.companies.length, 1);
  });
});
