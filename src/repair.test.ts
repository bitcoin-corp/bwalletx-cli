import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import knexFactory, { type Knex } from 'knex';
import { LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { assertNothingUnsent, extendedHex, repairWallet } from './repair';

let db: Knex;
beforeEach(async () => {
  db = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('proven_tx_reqs', (t) => {
    t.increments('provenTxReqId');
    t.string('status');
    t.string('txid');
    t.binary('rawTx');
    t.binary('inputBEEF');
  });
  await db.schema.createTable('transactions', (t) => {
    t.increments('transactionId');
    t.string('status');
    t.string('txid');
  });
  await db.schema.createTable('outputs', (t) => {
    t.increments('outputId');
    t.integer('transactionId');
    t.boolean('spendable');
    t.integer('spentBy').nullable();
    t.integer('satoshis');
    t.string('txid');
    t.integer('vout');
  });
});
afterEach(async () => db.destroy());

/** A parent paying a throwaway key, and a child spending it: the shape of an import tx. */
const pair = () => {
  const key = PrivateKey.fromRandom(); // throwaway, never a real wallet
  const parent = new Transaction();
  parent.addInput({ sourceTXID: 'aa'.repeat(32), sourceOutputIndex: 0, unlockingScript: LockingScript.fromHex('00'), sequence: 0xffffffff });
  parent.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: 58755 });
  const child = new Transaction();
  child.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: LockingScript.fromHex('00'), sequence: 0xffffffff });
  child.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: 5089 });
  child.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: 53600 });
  const inputBEEF = Buffer.from(parent.toAtomicBEEF());
  return { parent, child, inputBEEF };
};

/** The bstamp state of 2 Nov 2026: import unsent, two stamps failed, their inputs left unspendable. */
const seed = async () => {
  const { child, inputBEEF } = pair();
  const txid = child.id('hex');
  await db('proven_tx_reqs').insert({ status: 'unsent', txid, rawTx: Buffer.from(child.toBinary()), inputBEEF });
  await db('transactions').insert([
    { transactionId: 1, status: 'sending', txid },
    { transactionId: 2, status: 'failed', txid: 'b0'.repeat(32) },
  ]);
  await db('outputs').insert([
    { transactionId: 1, spendable: false, spentBy: null, satoshis: 5089, txid, vout: 0 }, // locked by the failed stamp
    { transactionId: 1, spendable: true, spentBy: null, satoshis: 53600, txid, vout: 1 },
    { transactionId: 2, spendable: false, spentBy: null, satoshis: 4975, txid: 'b0'.repeat(32), vout: 1 }, // change of the failed stamp
  ]);
  return { txid, child };
};

describe('bwalletx repair', () => {
  test('the stored tx goes out as Extended Format with its parent from the input BEEF', async () => {
    const { child, inputBEEF } = pair();
    const hex = extendedHex({ provenTxReqId: 1, txid: child.id('hex'), status: 'unsent', rawTx: child.toBinary(), inputBEEF });
    expect(hex.slice(8, 20)).toBe('0000000000ef'); // the EF marker after the version
  });

  test('spends refuse while a parent is unsent', async () => {
    await seed();
    await expect(assertNothingUnsent(db, 'bstamp')).rejects.toThrow(/bwalletx repair -a bstamp/);
  });

  test('re-broadcasts the unsent import, then frees the input a failed stamp locked (once the chain says unspent)', async () => {
    const { txid } = await seed();
    const posted: string[] = [];
    const r = await repairWallet(db, {
      post: async (hex) => (posted.push(hex), { ok: true, status: 200, txStatus: 'SEEN_ON_NETWORK' }),
      isUnspent: async (t, v) => t === txid && v === 0,
    });
    expect(posted).toHaveLength(1);
    expect(r.rebroadcast).toEqual([{ txid, ok: true, detail: 'SEEN_ON_NETWORK' }]);
    expect(r.freed).toEqual([{ outpoint: `${txid}.0`, satoshis: 5089 }]);
    expect((await db('proven_tx_reqs').first()).status).toBe('unmined');
    expect((await db('transactions').where({ transactionId: 1 }).first()).status).toBe('unproven');
    // The failed stamp's own change is never freed.
    expect(Boolean((await db('outputs').where({ satoshis: 4975 }).first()).spendable)).toBe(false);
    await expect(assertNothingUnsent(db, 'bstamp')).resolves.toBeUndefined();
  });

  test('a refused broadcast or an output the chain can’t confirm changes nothing', async () => {
    await seed();
    const r = await repairWallet(db, {
      post: async () => ({ ok: false, status: 465, detail: 'fee too low' }),
      isUnspent: async () => undefined,
    });
    expect(r.rebroadcast[0].ok).toBe(false);
    expect(r.freed).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/not confirmed/);
    expect((await db('proven_tx_reqs').first()).status).toBe('unsent');
  });
});
