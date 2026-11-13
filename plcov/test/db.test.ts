/**
 * Integration test against a real database (skipped unless PLCOV_DB is set):
 *   PLCOV_DB=demo/demo@localhost:1521/FREEPDB1 npm test
 * Compiles an instrumented package full of edge cases and checks that its
 * behaviour is identical to the original.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import oracledb from 'oracledb';
import { instrument } from '../src/instrument.js';
import { newIds } from '../src/model.js';
import { installRuntime } from '../src/run.js';

const db = process.env.PLCOV_DB;
const m = db ? /^([^/]+)\/([^@]+)@(.+)$/.exec(db) : null;

test('instrumented code behaves exactly like the original', { skip: !m && 'PLCOV_DB not set' }, async () => {
  const conn = await oracledb.getConnection({ user: m![1], password: m![2], connectString: m![3] });
  try {
    await installRuntime(conn);
    await conn.execute(`create or replace package plcov_torture is
      g_calls number := 0;
      function check_all return varchar2;
    end;`);
    const body = readFileSync(new URL('./fixtures/torture.pkb', import.meta.url), 'utf8');
    const check = async () => (await conn.execute<[string]>(`select plcov_torture.check_all from dual`)).rows![0][0];

    await conn.execute(`create or replace ${body}`);
    const expected = await check();

    const r = instrument(body, m![1].toUpperCase(), newIds(), { sqlProbes: true });
    await conn.execute(`create or replace ${r.instrumented}`);
    const errs = await conn.execute(`select line, text from user_errors where name = 'PLCOV_TORTURE'`);
    assert.deepEqual(errs.rows, [], 'instrumented package compiles');
    await conn.execute(`begin cov$.reset; end;`);
    const actual = await check();
    assert.equal(actual, expected);
    // golden value produced by the original (uninstrumented) package
    assert.equal(expected, 'Y2O3O3N3,D5A2D4A1D4D5,TFN,120,aCNF-6592,bigsmallZDT,midnullother,21:5');

    // the probes really recorded something: shortcircuit decision 1 saw (T,T)->T and (F,-)->F
    await conn.execute(`begin cov$.flush('torture'); end;`);
    const v = await conn.execute<[string]>(`select k from plcov_hits where run_id = 'torture' and kind = 'V' and k like '1|%'`);
    assert.ok(v.rows!.length >= 3, 'condition vectors recorded');
    await conn.execute(`delete from plcov_hits where run_id = 'torture'`);
    await conn.commit();
  } finally {
    await conn.execute(`drop package plcov_torture`).catch(() => undefined);
    await conn.close();
  }
});
