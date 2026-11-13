/**
 * `serve` (local mode) must never hand a noSend build to ARC (13 Nov 2026 review). A two-phase send is
 * build (noSend) → check → createAction { sendWith } or abortAction; relaying the build at step one paid twice
 * when the app aborted or rebuilt. A fake toolbox-shaped backend; nothing is broadcast.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk';

const dir = mkdtempSync(join(tmpdir(), 'bwx-serve-nosend-'));
process.env.BWALLETX_HOME = dir;
const { writeConfig } = await import('./store');
const { serve, txidsToRelay, SERVE_VERSION } = await import('./brc100');
const { issueToken } = await import('./servePairing');
const pkg = (await import('../package.json', { with: { type: 'json' } })).default as { version: string };

const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
let n = 0;
/** A real (unsigned) tx so the BEEF round-trips; spends `parent` when given. */
const mkTx = (parent?: Transaction) => {
  const t = new Transaction();
  n++;
  t.addInput(
    parent
      ? { sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff }
      : { sourceTXID: n.toString(16).padStart(64, '0'), sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff },
  );
  t.addOutput({ lockingScript: lock, satoshis: 10_000 - n });
  return t;
};

type Opts = { noSend?: boolean; sendWith?: string[]; signAndProcess?: boolean };
type Args = { outputs?: unknown[]; inputs?: unknown[]; options?: Opts; reference?: string };

/**
 * Shaped like @bsv/wallet-toolbox 2.14: sendWithResults lists what the wallet shared (the new tx unless noSend,
 * plus the sendWith txids); signAction inherits noSend from its createAction when it doesn't set it.
 */
function fakeToolbox(o: { failed: Set<string>; noSendWithResults?: boolean }) {
  const built = new Map<string, Transaction>();
  const pending = new Map<string, Opts>();
  const calls: { m: string; args: Args }[] = [];
  const swr = (txids: string[]) => (o.noSendWithResults ? undefined : txids.map((txid) => ({ txid, status: o.failed.has(txid) ? 'failed' : 'unproven' })));
  const finish = (t: Transaction, opts: Opts) => {
    const txid = t.id('hex');
    built.set(txid, t);
    const share = [...(opts.sendWith ?? []), ...(opts.noSend && !opts.sendWith?.length ? [] : [txid])];
    return { txid, tx: t.toAtomicBEEF(true), sendWithResults: swr(share) };
  };
  const call = async (m: string, a: unknown) => {
    const args = a as Args;
    calls.push({ m, args: JSON.parse(JSON.stringify(args)) });
    const opts = args.options ?? {};
    if (m === 'createAction') {
      const isNew = !!(args.outputs?.length || args.inputs?.length) || !opts.sendWith?.length;
      if (!isNew) return { sendWithResults: swr(opts.sendWith ?? []) };
      // Spend the last build when there is one, so a sendWith build is the new tx's parent.
      const t = mkTx([...built.values()].at(-1));
      if (opts.signAndProcess === false) {
        const reference = `ref-${n}`;
        pending.set(reference, opts);
        built.set(t.id('hex'), t);
        return { signableTransaction: { reference, tx: t.toAtomicBEEF(true) } };
      }
      return finish(t, opts);
    }
    if (m === 'signAction') {
      const prior = pending.get(args.reference ?? '');
      if (!prior) throw new Error('unknown reference');
      pending.delete(args.reference ?? '');
      const t = [...built.values()].at(-1) as Transaction;
      const merged: Opts = { noSend: args.options?.noSend ?? prior.noSend, sendWith: args.options?.sendWith ?? prior.sendWith };
      return finish(t, merged);
    }
    if (m === 'abortAction') return { aborted: true };
    return {};
  };
  return { call, calls, built };
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let acct = 0;
async function setup(o: { noSendWithResults?: boolean; serve?: Record<string, unknown> } = {}) {
  const account = `a${++acct}`; // a fresh account each test keeps the hourly rate limit out of the way
  writeConfig({ accounts: { [account]: { name: account, kind: 'paired', identityAddress: '1x', payAddress: '', ordAddress: '', dailyCapUsd: null, stopped: false, importedAt: Date.now() } }, defaultAccount: account } as never);
  const failed = new Set<string>();
  const fake = fakeToolbox({ failed, noSendWithResults: o.noSendWithResults });
  const w = { paired: false, call: (m: string, a: unknown) => fake.call(m, a), owned: async () => new Set<string>(), close: async () => undefined };
  const relayed: { txid: string; tx: number[] }[] = [];
  // $50 per BSV: 1,000,000 sats = $0.50
  const server = await serve(w, { account, origins: ['shop.example'], port: 0, arc: async (r) => void relayed.push(r), usdPerBsv: async () => 50, ...o.serve });
  cleanups.push(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = `Bearer ${issueToken('shop.example')}`;
  const post = async (method: string, body: unknown) => {
    const r = await fetch(`${url}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://shop.example', Authorization: auth }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  // The relay runs after the answer, in the background.
  const settle = () => new Promise((r) => setTimeout(r, 30));
  return { post, fake, relayed, settle, failed };
}
const pay = (sats: number, options: Opts = {}) => ({ description: 'two-phase payment', outputs: [{ lockingScript: lock.toHex(), satoshis: sats, outputDescription: 'pay' }], options });

describe('serve never relays a noSend build', () => {
  it('a noSend createAction is answered with the signed tx but not relayed', async () => {
    const { post, relayed, settle } = await setup();
    const r = await post('createAction', pay(1000, { noSend: true }));
    expect(r.status).toBe(200);
    expect(typeof r.body.txid).toBe('string');
    expect(Array.isArray(r.body.tx)).toBe(true);
    await settle();
    expect(relayed).toEqual([]);
  });

  it('a normal createAction still relays its own tx, once', async () => {
    const { post, relayed, settle } = await setup();
    const r = await post('createAction', pay(1000));
    expect(r.status).toBe(200);
    await settle();
    expect(relayed.map((x) => x.txid)).toEqual([r.body.txid]);
    expect(Transaction.fromAtomicBEEF(relayed[0].tx).id('hex')).toBe(r.body.txid);
  });

  it('sendWith relays exactly the held build(s), with their own BEEF', async () => {
    const { post, relayed, settle } = await setup();
    const a = await post('createAction', pay(1000, { noSend: true }));
    const b = await post('createAction', pay(1000, { noSend: true }));
    await settle();
    expect(relayed).toEqual([]);
    const s = await post('createAction', { description: 'send the batch', options: { sendWith: [a.body.txid, b.body.txid] } });
    expect(s.status).toBe(200);
    await settle();
    expect(relayed.map((x) => x.txid)).toEqual([a.body.txid, b.body.txid]);
    expect(relayed.map((x) => Transaction.fromAtomicBEEF(x.tx).id('hex'))).toEqual([a.body.txid, b.body.txid]);
  });

  it('sendWith skips txids the wallet reports as failed', async () => {
    const { post, relayed, settle, failed } = await setup();
    const a = await post('createAction', pay(1000, { noSend: true }));
    const b = await post('createAction', pay(1000, { noSend: true }));
    failed.add(b.body.txid as string); // e.g. its inputs were spent meanwhile (delayed broadcast reports, doesn't throw)
    const s = await post('createAction', { description: 'send the batch', options: { sendWith: [a.body.txid, b.body.txid] } });
    expect(s.status).toBe(200);
    await settle();
    expect(relayed.map((x) => x.txid)).toEqual([a.body.txid]);
  });

  it('a new tx that joins a sendWith batch goes after its parents; a noSend one is never relayed', async () => {
    const { post, relayed, settle } = await setup();
    const a = await post('createAction', pay(1000, { noSend: true }));
    const b = await post('createAction', pay(1000, { sendWith: [a.body.txid as string] }));
    expect(b.status).toBe(200);
    await settle();
    expect(relayed.map((x) => x.txid)).toEqual([a.body.txid, b.body.txid]);
    // The parent's BEEF comes from the held build (or, failing that, out of the new tx's BEEF).
    expect(Transaction.fromAtomicBEEF(relayed[0].tx).id('hex')).toBe(a.body.txid);
  });

  it('signAction inherits noSend from its createAction; an explicit noSend:false on signAction sends', async () => {
    const { post, relayed, settle } = await setup();
    const c1 = await post('createAction', pay(1000, { noSend: true, signAndProcess: false }));
    const ref1 = (c1.body.signableTransaction as { reference: string }).reference;
    const s1 = await post('signAction', { reference: ref1, spends: {} });
    expect(s1.status).toBe(200);
    await settle();
    expect(relayed).toEqual([]);

    const c2 = await post('createAction', pay(1000, { noSend: true, signAndProcess: false }));
    const ref2 = (c2.body.signableTransaction as { reference: string }).reference;
    const s2 = await post('signAction', { reference: ref2, spends: {}, options: { noSend: false } });
    await settle();
    expect(relayed.map((x) => x.txid)).toEqual([s2.body.txid]);
  });

  it('a noSend build that is aborted is never relayed', async () => {
    const { post, relayed, settle } = await setup();
    const a = await post('createAction', pay(1000, { noSend: true }));
    expect((await post('abortAction', { reference: a.body.txid })).status).toBe(200);
    await settle();
    expect(relayed).toEqual([]);
  });

  it('without sendWithResults (not the toolbox) it falls back to the noSend flag', async () => {
    const { post, relayed, settle } = await setup({ noSendWithResults: true });
    await post('createAction', pay(1000, { noSend: true }));
    await settle();
    expect(relayed).toEqual([]);
    const r = await post('createAction', pay(1000));
    await settle();
    expect(relayed.map((x) => x.txid)).toEqual([r.body.txid]);
  });

  it('txidsToRelay: noSend subject is dropped even if listed; parents first', () => {
    const t = 'aa'.repeat(32);
    const p = 'bb'.repeat(32);
    expect(txidsToRelay({ txid: t, tx: [1], sendWithResults: [{ txid: t, status: 'unproven' }] }, { noSend: true })).toEqual([]);
    expect(txidsToRelay({ txid: t, tx: [1], sendWithResults: [{ txid: t, status: 'sending' }, { txid: p, status: 'unproven' }] }, { noSend: false })).toEqual([p, t]);
    expect(txidsToRelay({ txid: t, tx: [1], sendWithResults: [] }, { noSend: false })).toEqual([]);
    expect(txidsToRelay({ txid: t, tx: [1] }, { noSend: true })).toEqual([]);
    expect(txidsToRelay({ txid: t, tx: [1] }, { noSend: false })).toEqual([t]);
    expect(txidsToRelay(null, { noSend: false })).toEqual([]);
  });
});

describe('two-phase send against the caps', () => {
  it('the build is what counts; the sendWith call moves nothing; an abort does not refund', async () => {
    const { post } = await setup({ serve: { maxUsdPerAction: 1, sessionBudgetUsd: 0.6 } });
    // Over the per-payment cap: refused at build time, nothing signed.
    expect((await post('createAction', pay(4_000_000, { noSend: true }))).status).toBe(400);
    const a = await post('createAction', pay(1_000_000, { noSend: true })); // $0.50
    expect(a.status).toBe(200);
    // Sending it is free under the caps (no outputs): fine even with only $0.10 left.
    expect((await post('createAction', { description: 'send it', options: { sendWith: [a.body.txid] } })).status).toBe(200);
    // Build-then-abort still used the budget: the signed tx was handed to the site, which could broadcast it.
    const b = await post('createAction', pay(400_000, { noSend: true })); // $0.20 > $0.10 left
    expect(b.status).toBe(400);
    expect(String(b.body.message)).toMatch(/budget/);
  });
});

describe('getVersion', () => {
  it('serve answers for itself with a version that marks the noSend fix, paired or not', async () => {
    const { post, fake } = await setup();
    const r = await post('getVersion', {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ version: SERVE_VERSION });
    expect(SERVE_VERSION).toBe(`bwalletx-serve-${pkg.version}`);
    expect(fake.calls).toEqual([]);
  });
});
