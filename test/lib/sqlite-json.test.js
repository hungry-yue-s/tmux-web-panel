import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mutateSQLite, runSQLiteJson, splitStatements } from '../../lib/sqlite-json.js';
import { sqliteExec, sqliteRows } from '../helpers/sqlite.js';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-json-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');
  sqliteExec(path, "create table t(id integer primary key, v text); insert into t(v) values ('a'), ('b;c');");
  return path;
}

describe('SQLite without a sqlite3 command line', () => {
  it('splits statements only on semicolons outside quotes and comments', () => {
    expect(splitStatements(`begin; insert into t values ('x;y', "q;""", [a;b]); -- c;
      /* d; */ commit;  ;`)).toEqual([
      'begin',
      `insert into t values ('x;y', "q;""", [a;b])`,
      '-- c;\n      /* d; */ commit',
    ]);
  });

  it('answers queries as `sqlite3 -json` prints them, and nothing for no rows', async () => {
    const path = database();
    expect(JSON.parse(await runSQLiteJson(path, 'select id, v from t order by id', { readonly: true })))
      .toEqual([{ id: 1, v: 'a' }, { id: 2, v: 'b;c' }]);
    expect(await runSQLiteJson(path, "select v from t where v = 'none'", { readonly: true })).toBe('');
    expect(await runSQLiteJson(path, "update t set v = 'z' where id = 1")).toBe('');
    expect(sqliteRows(path, 'select v from t where id = 1')).toEqual([{ v: 'z' }]);
  });

  it('prints large integers, reals and BLOBs as the command line does', async () => {
    const path = database();
    sqliteExec(path, "create table w(big integer, neg integer, r real, b blob, n); insert into w values (9223372036854775807, -9007199254740993, 1.5, x'7a68e4b8ad', null);");
    const text = await runSQLiteJson(path, 'select * from w', { readonly: true });
    // What `sqlite3 -json` prints for that row.
    expect(text).toBe('[{"big":9223372036854775807,"neg":-9007199254740993,"r":1.5,"b":"zh中","n":null}]');
    expect(JSON.parse(text)[0]).toMatchObject({ r: 1.5, b: 'zh中', n: null });
  });

  it('refuses to write read-only and never creates a missing database', async () => {
    const path = database();
    await expect(runSQLiteJson(path, "update t set v = 'z'", { readonly: true })).rejects.toThrow();
    const missing = join(path, '..', 'missing.db');
    await expect(runSQLiteJson(missing, 'select 1', { readonly: true })).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(mutateSQLite(missing, 'create table x(a)')).rejects.toThrow('SQLite write failed');
    expect(existsSync(missing)).toBe(false);
  });

  it('runs a script as one transaction and leaves nothing of a failed one, saying nothing about it', async () => {
    const path = database();
    await mutateSQLite(path, "begin immediate; insert into t(v) values ('secret;1'); update t set v = 'x' where id = 1; commit;");
    expect(sqliteRows(path, 'select v from t order by id')).toEqual([{ v: 'x' }, { v: 'b;c' }, { v: 'secret;1' }]);

    const failure = await mutateSQLite(path, "begin immediate; insert into t(v) values ('secret-2'); insert into missing values (1); commit;")
      .catch((error) => error);
    expect(failure.message).toBe('SQLite write failed');
    expect(JSON.stringify(failure)).not.toContain('secret');
    expect(sqliteRows(path, "select count(*) as n from t where v = 'secret-2'")).toEqual([{ n: 0 }]);
  });

  it('falls back to the sqlite3 command line without node:sqlite', async () => {
    const path = database();
    // With no sqlite3 on PATH the fallback fails; either way it is the command line that ran.
    const result = await runSQLiteJson(path, 'select 1 as one', { readonly: true, sqlite: null }).then(
      (text) => ({ text }), (error) => ({ error }));
    if (result.error) expect(result.error.message).toMatch(/sqlite3/);
    else expect(JSON.parse(result.text)).toEqual([{ one: 1 }]);
  });
});
