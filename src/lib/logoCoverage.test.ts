import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { logoCoverageFloor, MINIMUM_LOGO_COVERAGE, tallyCoverage } from './logoCoverage';

test('the floor is 99.9 percent and cannot be configured below it', () => {
  /* Deliberately 0.999 rather than 1, for the reasons written at the constant: the residue on a
     continuously growing board rotates run to run and probes clean afterwards, so exactly 1 fails
     for reasons that are not defects. About 210 postings at today's size, far below any real
     regression. A run may only ever be made STRICTER from the environment. */
  assert.equal(MINIMUM_LOGO_COVERAGE, 0.999);
  assert.equal(logoCoverageFloor(undefined), 0.999);
  assert.equal(logoCoverageFloor('0.55'), 0.999, 'a laxer request is clamped up to the floor');
  assert.equal(logoCoverageFloor('invalid'), 0.999);
});

test('a stricter floor can be asked for, and nothing above 100 percent is possible', () => {
  assert.equal(logoCoverageFloor('0.9995'), 0.9995);
  assert.equal(logoCoverageFloor('1'), 1);
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
