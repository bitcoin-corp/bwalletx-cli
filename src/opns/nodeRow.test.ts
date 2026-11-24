// 24 Nov 2026: every "he*" name looped on "still catching up" from 26 Oct. createAction refused the wallet's own
// stored row for our "he" node (spendable=0, spentBy NULL), the refusal matched isDoubleSpend, and the node was
// marked spent. These pin the fix: the row is repaired and the same mint retried; never marked spent.
import { describe, expect, test } from 'vitest';
import { LockingScript, Transaction } from '@bsv/sdk';
import { isStoredInputRejection, repairNodeRow, StoredNodeRowError } from './nodeRow.js';
import { isDoubleSpend, mineName, type MineChar } from './opnsRegister.js';
import { OpnsTree, type KV } from './opnsTree.js';
import type { Db } from '../repair.js';
import type { Fetch } from './services.js';

type Row = Record<string, unknown>;
const fakeDb = (tables: Record<string, Row[]>): Db => (t: string) => ({
  where: (q: Row) => {
    const rows = () => (tables[t] ?? []).filter((r) => Object.entries(q).every(([k, v]) => r[k] === v));
    return {
      then: (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(rows()).then(res, rej),
      first: async () => rows()[0],
      update: async (u: Row) => {
        const hit = rows();
        for (const r of hit) Object.assign(r, u);
        return hit.length;
      },
    };
  },
});

const SCRIPT = new LockingScript([{ op: 0x6a, data: undefined }, { op: 0x4d, data: new Array(600).fill(7) }]);
const nodeTx = () => {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: SCRIPT, satoshis: 1 });
  tx.addOutput({ lockingScript: SCRIPT, satoshis: 1 });
  return tx;
};
const row = (tx: Transaction, extra: Row = {}): Row => ({
  outputId: 82560,
  transactionId: 25327,
  txid: tx.id('hex'),
  vout: 0,
  satoshis: 1,
  spendable: 0,
  change: 0,
  spentBy: null,
  scriptLength: SCRIPT.toBinary().length,
  scriptOffset: 6455,
  lockingScript: null,
  ...extra,
});

const chainUnspent = { isUnspent: async () => true, getTx: async () => ({ vin: [{ txid: 'c'.repeat(64), vout: 0 }] }) };

const MSG_SCRIPT = (op: string) => `The ${op} parameter must be output with valid lockingScript and satoshis.`;
const MSG_UNSPENDABLE = (op: string) => `The ${op} parameter must be spendable output unless noSend is true.`;
const MSG_SPENT = (op: string) =>
  `The inputs[0] parameter must be spendable output. output ${op.replace('.', ':')} appears to have been spent (spendable=false).`;

describe('isStoredInputRejection', () => {
  test("matches the toolbox's three stored-row refusals and nothing the chain says", () => {
    const op = `${'a'.repeat(64)}.0`;
    for (const m of [MSG_SCRIPT(op), MSG_UNSPENDABLE(op), MSG_SPENT(op)]) expect(isStoredInputRejection(new Error(m))).toBe(true);
    for (const m of ['txn-mempool-conflict', 'DOUBLE_SPEND_ATTEMPTED', 'missing inputs', 'WERR_REVIEW_ACTIONS'])
      expect(isStoredInputRejection(new Error(m))).toBe(false);
  });
  test('the old bug: "appears to have been spent" counted as a double spend', () => {
    expect(isDoubleSpend(new Error(MSG_SPENT(`${'a'.repeat(64)}.0`)))).toBe(true);
  });
});

describe('repairNodeRow', () => {
  test('a completed tx: only spendable is fixed (the script stays null, storage reads it from the raw tx)', async () => {
    const tx = nodeTx();
    const r = row(tx);
    const db = fakeDb({ outputs: [r], transactions: [{ transactionId: 25327, status: 'completed' }] });
    expect(await repairNodeRow(db, tx, 0, chainUnspent)).toEqual(['spendable']);
    expect(r.spendable).toBe(true);
    expect(r.lockingScript).toBeNull();
  });

  test('a failed tx that is on chain is un-failed like `bwalletx repair` (so the monitor keeps the fix) and gets its script', async () => {
    const tx = nodeTx();
    const r = row(tx, { transactionId: 4214 });
    const parentOut: Row = { outputId: 1, txid: 'c'.repeat(64), vout: 0, spendable: 1, spentBy: null };
    const t: Row = { transactionId: 4214, status: 'failed' };
    const req: Row = { txid: tx.id('hex'), status: 'invalid' };
    const db = fakeDb({ outputs: [r, parentOut], transactions: [t], proven_tx_reqs: [req] });
    expect((await repairNodeRow(db, tx, 0, chainUnspent)).sort()).toEqual(['script', 'spendable', 'unfailed']);
    expect([...(r.lockingScript as Buffer)]).toEqual(SCRIPT.toBinary());
    expect([t.status, req.status]).toEqual(['unproven', 'unmined']);
    expect([parentOut.spendable, parentOut.spentBy]).toEqual([false, 4214]);
    expect(typeof r.updated_at).toBe('string');
  });

  test('the chain decides: spent → ["spent"] and nothing changes; unknown (429, error) → nothing changes', async () => {
    for (const [isUnspent, want] of [
      [async () => false, ['spent']],
      [async () => undefined, []],
      [async () => Promise.reject(new Error('429')), []],
    ] as const) {
      const tx = nodeTx();
      const r = row(tx, { transactionId: 4214 });
      const t: Row = { transactionId: 4214, status: 'failed' };
      const db = fakeDb({ outputs: [r], transactions: [t], proven_tx_reqs: [] });
      expect(await repairNodeRow(db, tx, 0, { isUnspent: isUnspent as never, getTx: chainUnspent.getTx })).toEqual(want);
      expect([r.spendable, r.lockingScript, t.status]).toEqual([0, null, 'failed']);
    }
  });

  test('no offset: the script is written', async () => {
    const tx = nodeTx();
    const r = row(tx, { scriptLength: null, scriptOffset: null, spendable: 1 });
    const db = fakeDb({ outputs: [r], transactions: [{ transactionId: 25327, status: 'completed' }] });
    expect(await repairNodeRow(db, tx, 0, chainUnspent)).toEqual(['script']);
  });

  test('left alone: spent by one of our actions, change, other satoshis, other script, or no row', async () => {
    const tx = nodeTx();
    const tables = (r: Row) => ({ outputs: [r], transactions: [{ transactionId: 25327, status: 'failed' }] });
    for (const extra of [
      { spentBy: 31076 },
      { change: 1 },
      { satoshis: 2 },
      { scriptLength: 25 },
      { lockingScript: Buffer.from([0x51]), scriptLength: null },
    ]) {
      const r = row(tx, extra);
      expect(await repairNodeRow(fakeDb(tables(r)), tx, 0, chainUnspent)).toEqual([]);
      expect(r.spendable).toBe(0);
    }
    expect(await repairNodeRow(fakeDb({ outputs: [], transactions: [] }), tx, 0, chainUnspent)).toEqual([]);
  });
});

describe('mineName on a refused stored row', () => {
  const memKV = (): KV => {
    let v: string | null = null;
    return { getItem: () => v, setItem: (_k, x) => (v = x) };
  };
  const HE = `${'a'.repeat(64)}.0`;
  const fetch: Fetch = (async (url: string) => {
    if (url.includes('/mine/')) return new Response(JSON.stringify({ outpoint: HE, domain: 'he' }));
    return new Response('{}', { status: 404 }); // not taken; WhatsOnChain: unspent
  }) as unknown as Fetch;
  const load = async (_c: unknown, op: string) => ({
    outpoint: op,
    beef: [],
    tx: {} as Transaction,
    vout: 0,
    state: { claimed: [0], domain: 'he', pow: new Array(32).fill(1) },
  });
  const instantMiner: MineChar = async () => ({ nonce: new Array(32).fill(0), hash: new Array(32).fill(0) });
  const ok = { txid: 'b'.repeat(64), newDomain: 'hej', childOutpoint: `${'b'.repeat(64)}.1` };

  test('the row is repaired and the same mint is retried once: no new PoW, never marked spent', async () => {
    const tree = new OpnsTree(memKV(), 'k');
    let mints = 0;
    let mined = 0;
    const fixed: string[] = [];
    const logs: string[] = [];
    const steps = await mineName(
      {
        ctx: {} as never,
        fetch,
        tree,
        load: load as never,
        mineChar: async (...a) => (mined++, instantMiner(...a)),
        mint: (async () => {
          if (mints++ === 0) throw new Error(MSG_SPENT(HE));
          return ok;
        }) as never,
        fixNodeRow: async (n) => (fixed.push(n.outpoint), ['spendable']),
        log: (m) => logs.push(m),
      },
      'hej',
      new AbortController().signal,
      () => undefined,
    );
    expect(steps.map((s) => s.newDomain)).toEqual(['hej']);
    expect(mints).toBe(2);
    expect(mined).toBe(1);
    expect(fixed).toEqual([HE]);
    expect(logs.some((l) => /repaired its stored row: spendable; retrying/.test(l))).toBe(true);
  });

  test('nothing to repair (or no local storage): a clear error, not "catching up", and the node is not marked spent', async () => {
    for (const fixNodeRow of [undefined, async () => []]) {
      const tree = new OpnsTree(memKV(), 'k');
      const run = mineName(
        {
          ctx: {} as never,
          fetch,
          tree,
          load: load as never,
          mineChar: instantMiner,
          mint: (async () => {
            throw new Error(MSG_SPENT(HE));
          }) as never,
          fixNodeRow,
        },
        'hej',
        new AbortController().signal,
        () => undefined,
      );
      await expect(run).rejects.toBeInstanceOf(StoredNodeRowError);
      await expect(run).rejects.toThrow(/bwalletx repair/);
      expect(tree.isSpent(HE)).toBe(false);
    }
  });

  test('the chain says the node is spent: the normal double-spend path (marked spent), not the stored-row error', async () => {
    const tree = new OpnsTree(memKV(), 'k');
    const run = mineName(
      {
        ctx: {} as never,
        fetch,
        tree,
        load: load as never,
        mineChar: instantMiner,
        mint: (async () => {
          throw new Error(MSG_SPENT(HE));
        }) as never,
        fixNodeRow: async () => ['spent'],
      },
      'hej',
      new AbortController().signal,
      () => undefined,
    );
    await expect(run).rejects.toThrow(/catching up/);
    await expect(run).rejects.not.toBeInstanceOf(StoredNodeRowError);
    expect(tree.isSpent(HE)).toBe(true);
  });

  test('still refused after the repair: the clear error, one retry only', async () => {
    let mints = 0;
    const run = mineName(
      {
        ctx: {} as never,
        fetch,
        load: load as never,
        mineChar: instantMiner,
        mint: (async () => {
          mints++;
          throw new Error(MSG_UNSPENDABLE(HE));
        }) as never,
        fixNodeRow: async () => ['spendable'],
      },
      'hej',
      new AbortController().signal,
      () => undefined,
    );
    await expect(run).rejects.toBeInstanceOf(StoredNodeRowError);
    expect(mints).toBe(2);
  });
});

describe('batch isTransient vs a txid in the message', () => {
  test('status codes only as whole numbers: a txid containing 429 or 503 is not a network error', async () => {
    const { isTransient } = await import('./batch.js');
    const op = `${'0'.repeat(20)}4290${'0'.repeat(20)}503${'0'.repeat(20)}.0`;
    expect(isTransient(new StoredNodeRowError(op, new Error(MSG_SPENT(op))).message)).toBe(false);
    expect(isTransient('HTTP 429 Too Many Requests')).toBe(true);
    expect(isTransient('503 Service Unavailable')).toBe(true);
  });
});
