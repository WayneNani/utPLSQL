#!/usr/bin/env -S npx tsx
/**
 * plcov – prototype CLI
 *
 *   plcov run --config plcov.json [--out report]     measure coverage, write report
 *   plcov instrument <file.sql> [--no-sql]           print instrumented source (offline)
 *   plcov deploy <file.sql ...> --config plcov.json  run SQL*Plus-style scripts (demo setup)
 *   plcov report <coverage.json> [--out report]      re-render HTML from saved JSON
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import oracledb from 'oracledb';
import { instrument } from './instrument.js';
import { newIds } from './model.js';
import { runCoverage, type RunConfig, type RunReport } from './run.js';
import { renderHtml } from './report.js';

const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (name: string) => {
  const k = args.indexOf(`--${name}`);
  if (k < 0) return undefined;
  const v = args[k + 1];
  args.splice(k, 2);
  return v;
};
const flag = (name: string) => {
  const k = args.indexOf(`--${name}`);
  if (k < 0) return false;
  args.splice(k, 1);
  return true;
};

function loadConfig(path: string | undefined): RunConfig {
  if (!path) throw new Error('--config fehlt');
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as RunConfig;
  cfg.password = process.env.PLCOV_PASSWORD ?? cfg.password;
  return cfg;
}

/** Splits a SQL*Plus style script into statements ("/" on its own line ends PL/SQL, ";" ends SQL). */
function splitScript(text: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let plsql = false;
  for (const line of text.split('\n')) {
    if (!buf.length && !line.trim()) continue;
    if (line.trim() === '/') {
      if (buf.length) out.push(buf.join('\n'));
      buf = [];
      plsql = false;
      continue;
    }
    if (!buf.length) plsql = /^\s*create\s+(or\s+replace\s+)?(editionable\s+|noneditionable\s+)?(package|procedure|function|trigger|type)\b/i.test(line) || /^\s*(declare|begin)\b/i.test(line);
    buf.push(line);
    if (!plsql && /;\s*$/.test(line)) {
      out.push(buf.join('\n').replace(/;\s*$/, ''));
      buf = [];
    }
  }
  if (buf.join('').trim()) out.push(buf.join('\n'));
  return out;
}

async function main() {
  switch (cmd) {
    case 'run': {
      const cfg = loadConfig(opt('config'));
      const out = resolve(opt('out') ?? 'plcov-report');
      const report = await runCoverage(cfg);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'coverage.json'), JSON.stringify(report, null, 1));
      writeFileSync(join(out, 'index.html'), renderHtml(report));
      console.error(`Bericht: ${join(out, 'index.html')}`);
      break;
    }
    case 'report': {
      const file = args.shift();
      if (!file) throw new Error('coverage.json fehlt');
      const out = resolve(opt('out') ?? 'plcov-report');
      const report = JSON.parse(readFileSync(file, 'utf8')) as RunReport;
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'index.html'), renderHtml(report));
      console.error(`Bericht: ${join(out, 'index.html')}`);
      break;
    }
    case 'instrument': {
      const noSql = flag('no-sql');
      const file = args.shift();
      if (!file) throw new Error('Datei fehlt');
      for (const stmt of splitScript(readFileSync(file, 'utf8'))) {
        const r = instrument(stmt + '\n', 'SCHEMA', newIds(), { sqlProbes: !noSql });
        process.stdout.write(r.instrumented + '/\n');
      }
      break;
    }
    case 'deploy': {
      const cfg = loadConfig(opt('config'));
      const conn = await oracledb.getConnection({ user: cfg.user, password: cfg.password, connectString: cfg.connectString });
      try {
        for (const file of args) {
          for (const stmt of splitScript(readFileSync(file, 'utf8'))) {
            try {
              await conn.execute(stmt);
            } catch (e) {
              const msg = (e as Error).message;
              if (/ORA-00955|ORA-02260|ORA-02275/.test(msg)) continue; // already exists
              throw new Error(`${file}: ${msg}`);
            }
          }
          console.error(`✓ ${file}`);
        }
        const inv = await conn.execute<[string, string]>(`select object_name, object_type from user_objects where status = 'INVALID'`);
        if (inv.rows?.length) console.error(`Ungültige Objekte: ${inv.rows.map((r) => r.join(' ')).join(', ')}`);
      } finally {
        await conn.close();
      }
      break;
    }
    default:
      console.error('Verwendung: plcov run|report|instrument|deploy …  (siehe README.md)');
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
