import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  ENTERPRISE_OWNED_SQL, ENTERPRISE_OWNER, RELAY_OWNED_SQL, RELAY_OWNER, ownsEnterprise, ownsRelay,
} from '../../lib/agent-providers/ownership.js';

const rows = {
  enterprise: { anymuxEnterprise: ENTERPRISE_OWNER },
  legacyEnterprise: { tmuxPanelEnterprise: 'tmux-panel-token-switch-v1' },
  relay: { anymuxRelay: RELAY_OWNER },
  legacyRelay: { tmuxPanelRelay: RELAY_OWNER },
  foreign: { anymuxEnterprise: 'someone-else', tmuxPanelRelay: 'someone-else' },
};

describe('CC Switch provider ownership marks', () => {
  it('counts rows written before the rename as the panel\'s own', () => {
    expect(Object.entries(rows).filter(([, meta]) => ownsEnterprise(meta)).map(([id]) => id)).toEqual(['enterprise', 'legacyEnterprise']);
    expect(Object.entries(rows).filter(([, meta]) => ownsRelay(meta)).map(([id]) => id)).toEqual(['relay', 'legacyRelay']);
    expect(ownsEnterprise(undefined)).toBe(false);
  });

  it('applies the same rules in SQL, including to rows whose meta is not JSON', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('create table providers (id text, meta text)');
    const insert = db.prepare('insert into providers values (?, ?)');
    for (const [id, meta] of Object.entries(rows)) insert.run(id, JSON.stringify(meta));
    insert.run('broken', '{not json');
    const ids = (condition) => db.prepare(`select id from providers where ${condition} order by rowid`).all().map((row) => row.id);
    expect(ids(ENTERPRISE_OWNED_SQL)).toEqual(['enterprise', 'legacyEnterprise']);
    expect(ids(RELAY_OWNED_SQL)).toEqual(['relay', 'legacyRelay']);
    db.close();
  });
});
