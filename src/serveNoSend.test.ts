/**
 * `serve` (local mode) and noSend (13 Nov 2026 review):
 *   - never hand a noSend build to ARC; a later sendWith relays exactly those txids;
 *   - a site may only sendWith / chain on / abort ITS OWN noSend builds from this serve session;
 *   - the network fee counts toward the fee cap, the per-payment cap, the session budget and the daily cap.
 * A fake backend shaped like @bsv/wallet-toolbox 2.14 (see serveRealToolbox.test.ts for the real one); nothing is broadcast.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk';

const dir = mkdtempSync(join(tmpdir(), 'bwx-serve-nosend-'));
process.env.BWALLETX_HOME = dir;
const { writeConfig, readLog } = await import('./store');
const { serve, txidsToRelay, serveVersion, VERSION_FALLBACK, feeOf, pinLevelOf, versionWithPin } = await import('./brc100');
const { Beef } = await import('@bsv/sdk');
const { issueToken } = await import('./servePairing');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
let n = 0;
/** A 1 BSV coin from a fresh (unproven, partial) funding tx. */
const coin = () => {
  const fund = new Transaction();
  fund.addInput({ sourceTXID: (++n).toString(16).padStart(64, '0'), sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff });
  fund.addOutput({ lockingScript: lock, satoshis: 100_000_000 });
  return { tx: fund, vout: 0 };
};

type Opts = { noSend?: boolean; sendWith?: string[]; signAndProcess?: boolean; noSendChange?: string[]; acceptDelayedBroadcast?: boolean };
type Args = { outputs?: { lockingScript: string; satoshis: number }[]; inputs?: unknown[]; options?: Opts; reference?: string; description?: string };

/**
 * Shaped like @bsv/wallet-toolbox 2.14: a new tx's sendWithResults list what the wallet shared (the sendWith txids,
 * plus the new tx unless noSend: with noSend + sendWith it commits only the sendWith txids and keeps the new tx
 * nosend); signAction inherits noSend from its createAction; aborted or unknown txids come back 'failed'.
 * Fee: 50 sats + 100 sat/kB of output script.
 */
function fakeToolbox(failed: Set<string>) {
  const built = new Map<string, { tx: Transaction; change: number }>();
  const aborted = new Set<string>();
  const sent = new Set<string>();
  const pending = new Map<string, { opts: Opts; t: Transaction; change: number }>();
  const calls: { m: string; args: Args }[] = [];
  /** Test controls: make the next send step (sendWith-only createAction) throw; make abortAction refuse (tx already out). */
  const ctl = { throwOnSend: 0, abortRefuses: false };
  const statusOf = (txid: string) => (failed.has(txid) || aborted.has(txid) || !built.has(txid) ? 'failed' : 'sending');
  const share = (txids: string[]) => txids.map((txid) => ({ txid, status: statusOf(txid) }));
  const make = (args: Args) => {
    const t = new Transaction();
    const src = args.options?.noSendChange?.[0];
    const from = src ? { tx: built.get(src.split('.')[0])!.tx, vout: Number(src.split('.')[1]) } : coin();
    t.addInput({ sourceTransaction: from.tx, sourceOutputIndex: from.vout, unlockingScript: new Script(), sequence: 0xffffffff });
    const inSats = from.tx.outputs[from.vout].satoshis as number;
    let out = 0;
    let bytes = 0;
    for (const o of args.outputs ?? []) {
      t.addOutput({ lockingScript: Script.fromHex(o.lockingScript), satoshis: o.satoshis });
      out += o.satoshis;
      bytes += o.lockingScript.length / 2;
    }
    const fee = 50 + Math.floor(bytes / 10);
    t.addOutput({ lockingScript: lock, satoshis: inSats - out - fee });
    return { t, change: t.outputs.length - 1 };
  };
  const finish = (t: Transaction, change: number, opts: Opts) => {
    const txid = t.id('hex');
    built.set(txid, { tx: t, change });
    const list = [...(opts.sendWith ?? []), ...(opts.noSend ? [] : [txid])];
    for (const x of list) if (statusOf(x) !== 'failed') sent.add(x);
    return { txid, tx: t.toAtomicBEEF(true), noSendChange: opts.noSend ? [`${txid}.${change}`] : undefined, sendWithResults: share(list) };
  };
  const call = async (m: string, a: unknown) => {
    const args = a as Args;
    calls.push({ m, args: JSON.parse(JSON.stringify(args)) });
    const opts = args.options ?? {};
    if (m === 'createAction') {
      const isNew = !!(args.outputs?.length || args.inputs?.length) || !opts.sendWith?.length;
      if (!isNew) {
        if (ctl.throwOnSend > 0) {
          ctl.throwOnSend--;
          throw new Error('simulated storage failure on send');
        }
        const r = share(opts.sendWith ?? []);
        for (const x of r) if (x.status !== 'failed') sent.add(x.txid);
        return { sendWithResults: r };
      }
      const { t, change } = make(args);
      if (opts.signAndProcess === false) {
        const reference = `ref-${++n}`;
        pending.set(reference, { opts, t, change });
        return { signableTransaction: { reference, tx: t.toAtomicBEEF(true) } };
      }
      return finish(t, change, opts);
    }
    if (m === 'signAction') {
      const prior = pending.get(args.reference ?? '');
      if (!prior) throw new Error('recovery of out-of-session signAction reference data is not yet implemented.');
      pending.delete(args.reference ?? '');
      return finish(prior.t, prior.change, { noSend: args.options?.noSend ?? prior.opts.noSend, sendWith: args.options?.sendWith ?? prior.opts.sendWith });
    }
    if (m === 'abortAction') {
      if (ctl.abortRefuses) throw new Error('The reference parameter must be an inprocess, outgoing action that has not been signed and shared to the network.');
      aborted.add(args.reference ?? '');
      return { aborted: true };
    }
    return {};
  };
  /** What storage would say: invalid once aborted, sending once shared, nosend while held, null if unknown. */
  const txStatus = async (txid: string) => (aborted.has(txid) ? 'invalid' : sent.has(txid) ? 'sending' : built.has(txid) ? 'nosend' : null);
  return { call, calls, built, aborted, sent, ctl, txStatus };
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let acct = 0;
type Fake = ReturnType<typeof fakeToolbox>;
async function setup(o: { origins?: string[]; serve?: Record<string, unknown>; fake?: Fake } = {}) {
  const origins = o.origins ?? ['shop.example'];
  const account = `a${++acct}`; // a fresh account each test keeps the hourly rate limit out of the way
  writeConfig({ accounts: { [account]: { name: account, kind: 'paired', identityAddress: '1x', payAddress: '', ordAddress: '', dailyCapUsd: null, stopped: false, importedAt: Date.now() } }, defaultAccount: account } as never);
  const failed = new Set<string>();
  const fake = o.fake ?? fakeToolbox(failed);
  const w = { paired: false, call: (m: string, a: unknown) => fake.call(m, a), owned: async () => new Set<string>(), txStatus: (t: string) => fake.txStatus(t), close: async () => undefined };
  const relayed: { txid: string; tx: number[] }[] = [];
  // $50 per BSV: 1,000,000 sats = $0.50
  const server = await serve(w, { account, origins, port: 0, arc: async (r) => void relayed.push(r), usdPerBsv: async () => 50, ...o.serve });
  cleanups.push(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (method: string, body: unknown, site = origins[0]) => {
    const r = await fetch(`${url}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `https://${site}`, Authorization: `Bearer ${issueToken(site)}` }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  // The relay runs after the answer, in the background.
  const settle = () => new Promise((r) => setTimeout(r, 30));
  return { post, fake, relayed, settle, failed, account };
}
const pay = (sats: number, options: Opts = {}) => ({ description: 'two-phase payment', outputs: [{ lockingScript: lock.toHex(), satoshis: sats, outputDescription: 'pay' }], options });
const txids = (r: { txid: string }[]) => r.map((x) => x.txid);
const blob = (bytes: number) => '006a4e' + Buffer.from(Uint32Array.of(bytes).buffer).toString('hex') + 'ab'.repeat(bytes);

describe('serve never relays a noSend build', () => {
  it('a noSend createAction is answered with the signed tx but not relayed or sent', async () => {
    const { post, relayed, settle, fake } = await setup();
    const r = await post('createAction', pay(1000, { noSend: true }));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.tx)).toBe(true);
    expect(r.body.noSendChange).toHaveLength(1);
    await settle();
    expect(relayed).toEqual([]);
    expect(fake.sent.size).toBe(0);
  });

  it('a normal createAction is built noSend, priced, then sent and relayed once', async () => {
    const { post, relayed, settle, fake } = await setup();
    const r = await post('createAction', pay(1000));
    expect(r.status).toBe(200);
    expect(r.body.noSendChange).toBeUndefined();
    expect(fake.calls.map((c) => [c.m, c.args.options?.noSend ?? null, c.args.options?.sendWith ?? null])).toEqual([
      ['createAction', true, []],
      ['createAction', null, [r.body.txid]],
    ]);
    expect(r.body.sendWithResults).toEqual([{ txid: r.body.txid, status: 'sending' }]);
    await settle();
    expect(txids(relayed)).toEqual([r.body.txid]);
    expect(Transaction.fromAtomicBEEF(relayed[0].tx).id('hex')).toBe(r.body.txid);
  });

  it('returnTXIDOnly is honoured on the way out (serve still prices the full tx)', async () => {
    const { post, relayed, settle } = await setup();
    const r = await post('createAction', pay(1000, { returnTXIDOnly: true } as Opts));
    expect(r.status).toBe(200);
    expect(r.body.tx).toBeUndefined();
    await settle();
    expect(txids(relayed)).toEqual([r.body.txid]);
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
    expect(txids(relayed)).toEqual([a.body.txid, b.body.txid]);
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
    expect(txids(relayed)).toEqual([a.body.txid]);
  });

  it('a new tx that joins a sendWith batch is sent after its parents', async () => {
    const { post, relayed, settle } = await setup();
    const a = await post('createAction', pay(1000, { noSend: true }));
    const b = await post('createAction', pay(1000, { sendWith: [a.body.txid as string], noSendChange: a.body.noSendChange as string[] }));
    expect(b.status).toBe(200);
    await settle();
    expect(txids(relayed)).toEqual([a.body.txid, b.body.txid]);
    expect(Transaction.fromAtomicBEEF(relayed[0].tx).id('hex')).toBe(a.body.txid);
  });

  it('noSend + sendWith sends only the sendWith txids and keeps the new tx held', async () => {
    const { post, relayed, settle, fake } = await setup();
    const a = await post('createAction', pay(1000, { noSend: true }));
    const b = await post('createAction', pay(1000, { noSend: true, sendWith: [a.body.txid as string] }));
    expect(b.status).toBe(200);
    await settle();
    expect(txids(relayed)).toEqual([a.body.txid]);
    expect(fake.sent.has(b.body.txid as string)).toBe(false);
    // b is still this site's to send later.
    expect((await post('createAction', { description: 'send b now', options: { sendWith: [b.body.txid] } })).status).toBe(200);
    await settle();
    expect(txids(relayed)).toEqual([a.body.txid, b.body.txid]);
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
    expect(s2.status).toBe(200);
    await settle();
    expect(txids(relayed)).toEqual([s2.body.txid]);
  });

  it('a noSend build that is aborted is never relayed', async () => {
    const { post, relayed, settle } = await setup();
    const a = await post('createAction', pay(1000, { noSend: true }));
    expect((await post('abortAction', { reference: a.body.txid })).status).toBe(200);
    await settle();
    expect(relayed).toEqual([]);
  });

  it('txidsToRelay: noSend subject is dropped even if listed; parents first; fallback on the noSend flag', () => {
    const t = 'aa'.repeat(32);
    const p = 'bb'.repeat(32);
    expect(txidsToRelay({ txid: t, tx: [1], sendWithResults: [{ txid: t, status: 'unproven' }] }, { noSend: true })).toEqual([]);
    expect(txidsToRelay({ txid: t, tx: [1], sendWithResults: [{ txid: t, status: 'sending' }, { txid: p, status: 'unproven' }] }, { noSend: false })).toEqual([p, t]);
    expect(txidsToRelay({ txid: t, tx: [1], sendWithResults: [{ txid: p, status: 'failed' }] }, { noSend: false })).toEqual([]);
    expect(txidsToRelay({ txid: t, tx: [1] }, { noSend: true })).toEqual([]);
    expect(txidsToRelay({ txid: t, tx: [1] }, { noSend: false })).toEqual([t]);
    expect(txidsToRelay(null, { noSend: false })).toEqual([]);
  });
});

describe('a site may only send its own builds', () => {
  it("another site's noSend build: sendWith, noSendChange and abortAction are refused", async () => {
    const { post, relayed, settle, fake } = await setup({ origins: ['a.example', 'b.example'] });
    const a = await post('createAction', pay(1000, { noSend: true }), 'a.example');
    const s = await post('createAction', { description: 'B sends A build', options: { sendWith: [a.body.txid] } }, 'b.example');
    expect(s.status).toBe(400);
    expect(String(s.body.message)).toMatch(/sendWith names/);
    const c = await post('createAction', pay(1000, { noSendChange: a.body.noSendChange as string[] }), 'b.example');
    expect(c.status).toBe(400);
    expect(String(c.body.message)).toMatch(/noSendChange/);
    const ab = await post('abortAction', { reference: a.body.txid }, 'b.example');
    expect(ab.status).toBe(400);
    expect(fake.aborted.size).toBe(0);
    await settle();
    expect(relayed).toEqual([]);
    // A itself still can.
    expect((await post('createAction', { description: 'A sends its build', options: { sendWith: [a.body.txid] } }, 'a.example')).status).toBe(200);
  });

  it("a signAction or abort on another site's reference is refused", async () => {
    const { post } = await setup({ origins: ['a.example', 'b.example'] });
    const c = await post('createAction', pay(1000, { signAndProcess: false }), 'a.example');
    const ref = (c.body.signableTransaction as { reference: string }).reference;
    expect((await post('signAction', { reference: ref, spends: {} }, 'b.example')).status).toBe(400);
    expect((await post('abortAction', { reference: ref }, 'b.example')).status).toBe(400);
    expect((await post('signAction', { reference: ref, spends: {} }, 'a.example')).status).toBe(200);
  });

  it("a noSend build made outside serve (another app, the phone, `store buy`) can't be sent by a site", async () => {
    const { post, fake, relayed, settle } = await setup();
    const other = (await fake.call('createAction', pay(4_000_000, { noSend: true }))) as { txid: string };
    const s = await post('createAction', { description: 'site sends it', options: { sendWith: [other.txid] } });
    expect(s.status).toBe(400);
    expect(fake.sent.has(other.txid)).toBe(false);
    await settle();
    expect(relayed).toEqual([]);
  });

  it('a build from before a serve restart is refused on sendWith', async () => {
    const first = await setup();
    const a = await first.post('createAction', pay(1000, { noSend: true }));
    const second = await setup({ fake: first.fake });
    const s = await second.post('createAction', { description: 'send after restart', options: { sendWith: [a.body.txid] } });
    expect(s.status).toBe(400);
    expect(String(s.body.message)).toMatch(/serve restart/);
  });
});

describe('fees count', () => {
  it('feeOf: inputs minus outputs from the signed tx; unknown input value → undefined', () => {
    const c = coin();
    const t = new Transaction();
    t.addInput({ sourceTransaction: c.tx, sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff });
    t.addOutput({ lockingScript: lock, satoshis: 99_999_000 });
    expect(feeOf(t.toAtomicBEEF(true))).toBe(1000);
    const u = new Transaction();
    u.addInput({ sourceTXID: 'cd'.repeat(32), sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff });
    u.addOutput({ lockingScript: lock, satoshis: 1 });
    expect(feeOf(u.toAtomicBEEF(true))).toBeUndefined();
  });

  it('a 0-sat data write with $0 caps is refused for its fee, aborted, never sent', async () => {
    const { post, fake, relayed, settle } = await setup({ serve: { maxUsdPerAction: 0, sessionBudgetUsd: 0 } });
    const r = await post('createAction', { description: 'big data write', outputs: [{ lockingScript: blob(20_000), satoshis: 0, outputDescription: 'data blob' }] });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/network fee is over the \$0 per-payment cap/);
    expect(fake.aborted.size).toBe(1);
    expect(fake.sent.size).toBe(0);
    await settle();
    expect(relayed).toEqual([]);
  });

  it('the fee cap per payment (--max-fee-sats) refuses a costly write even under the USD caps', async () => {
    const { post, fake } = await setup({ serve: { maxFeeSats: 1000 } });
    const r = await post('createAction', { description: 'big data write', outputs: [{ lockingScript: blob(20_000), satoshis: 0, outputDescription: 'data blob' }] }); // ~2,050 sats fee
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/1000-sat fee cap/);
    expect(fake.aborted.size).toBe(1);
    expect(fake.sent.size).toBe(0);
  });

  it('a fee-only action is logged as a spend, with its fee, so it counts for the rate limit and daily cap', async () => {
    const { post, account } = await setup();
    expect((await post('createAction', { description: 'small data write', outputs: [{ lockingScript: '006a04deadbeef', satoshis: 0, outputDescription: 'data blob' }] })).status).toBe(200);
    const last = readLog(account).at(-1)!;
    expect(last.action).toBe('send');
    expect(last.detail).toMatch(/fee 50 sats/);
    expect(last.usd).toBeGreaterThan(0);
  });

  it('the fee is added to the session budget', async () => {
    // 999,950 sats + 50 fee = exactly $0.50 spent; then 999,940 + 50 fits only without the first fee.
    const { post } = await setup({ serve: { sessionBudgetUsd: 0.99997 } });
    expect((await post('createAction', pay(999_950))).status).toBe(200);
    const r = await post('createAction', pay(999_940));
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/budget/);
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
  it('serve answers for itself with a version that marks the fix', async () => {
    const { post, fake } = await setup();
    const r = await post('getVersion', {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ version: serveVersion() });
    expect(serveVersion()).toBe(`bwalletx-serve-${pkg.version}`);
    expect(fake.calls).toEqual([]);
  });

  it('the compiled-binary fallback version matches package.json', () => {
    expect(VERSION_FALLBACK).toBe(pkg.version);
  });
});

describe('knownTxids (13 Nov 2026 re-review)', () => {
  it('serve builds with the full BEEF to price the fee, then trims the reply to what the site declared', async () => {
    const { post, fake } = await setup();
    const a = await post('createAction', pay(1000, { noSend: true }));
    const b = await post('createAction', pay(1000, { noSendChange: a.body.noSendChange as string[], knownTxids: [a.body.txid as string] } as Opts));
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    const build = fake.calls.filter((c) => c.m === 'createAction' && c.args.outputs?.length).at(-1)!;
    expect((build.args.options as { knownTxids?: string[] }).knownTxids).toEqual([]);
    const beef = Beef.fromBinary(b.body.tx as number[]);
    expect(beef.findTxid(a.body.txid as string)?.isTxidOnly).toBe(true);
    expect(beef.findTxid(b.body.txid as string)?.isTxidOnly).toBe(false);
    expect(beef.txs).toHaveLength(2); // a's own parent isn't carried once a is omitted
  });
});

describe('a failed send leaves nothing stuck (13 Nov 2026 re-review)', () => {
  it('one failed send step is retried (commit is idempotent): a plain success', async () => {
    const { post, fake, relayed, settle } = await setup();
    fake.ctl.throwOnSend = 1;
    const r = await post('createAction', pay(1000));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await settle();
    expect(txids(relayed)).toEqual([r.body.txid]);
  });

  it('the send step throws twice: serve aborts the build, refunds, names the txid', async () => {
    const { post, fake, relayed, settle, account } = await setup({ serve: { sessionBudgetUsd: 0.6 } });
    fake.ctl.throwOnSend = 2;
    const r = await post('createAction', pay(1_000_000)); // $0.50
    expect(r.status).toBe(400);
    expect(typeof r.body.txid).toBe('string');
    expect(r.body.aborted).toBe(true);
    expect(String(r.body.message)).toMatch(/not sent .* aborted, so nothing was paid/);
    expect(fake.aborted.has(r.body.txid as string)).toBe(true);
    await settle();
    expect(relayed).toEqual([]);
    expect(readLog(account).filter((e) => e.action === 'send')).toEqual([]);
    // The $0.50 came back to the session budget.
    expect((await post('createAction', pay(1_000_000))).status).toBe(200);
  });

  it('the send step throws and the wallet refuses the abort (it may be out): txid named, still counted and logged', async () => {
    const { post, fake, account } = await setup({ serve: { sessionBudgetUsd: 0.6 } });
    fake.ctl.throwOnSend = 2;
    fake.ctl.abortRefuses = true;
    const r = await post('createAction', pay(1_000_000));
    expect(r.status).toBe(400);
    expect(r.body.aborted).toBe(false);
    expect(String(r.body.message)).toMatch(new RegExp(`check ${r.body.txid} before paying again`));
    const sends = readLog(account).filter((e) => e.action === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0].detail).toMatch(/send failed/);
    fake.ctl.abortRefuses = false;
    expect((await post('createAction', pay(1_000_000))).status).toBe(400); // budget still used
    // The site can retry its own build.
    expect((await post('createAction', { description: 'retry the send', options: { sendWith: [r.body.txid] } })).status).toBe(200);
  });
  it("an abort the wallet reports but storage doesn't confirm is treated as sent (batch commit raced the abort)", async () => {
    const { post, fake, account } = await setup({ serve: { sessionBudgetUsd: 0.6 } });
    fake.ctl.throwOnSend = 2;
    const realStatus = fake.txStatus;
    // The abort says aborted:true, but storage still has the tx queued to send (committed before the error).
    fake.txStatus = async (t: string) => (fake.aborted.has(t) ? 'unsent' : realStatus(t));
    const r = await post('createAction', pay(1_000_000));
    expect(r.status).toBe(400);
    expect(r.body.aborted).toBe(false);
    expect(readLog(account).filter((e) => e.action === 'send')).toHaveLength(1);
    expect((await post('createAction', pay(1_000_000))).status).toBe(400); // still charged to the budget
  });
});

describe('abort needs a known owner (13 Nov 2026 re-review)', () => {
  it("a site can't abort a build serve didn't make for it, even with no other site involved", async () => {
    const { post, fake } = await setup();
    const other = (await fake.call('createAction', pay(1000, { noSend: true }))) as { txid: string };
    const r = await post('abortAction', { reference: other.txid });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/brc100 abort/);
    expect(fake.aborted.size).toBe(0);
  });
});

describe('a signAction flow counts once toward the rate limit (13 Nov 2026 re-review)', () => {
  const spends = (account: string) => readLog(account).filter((e) => /^(send|buy|sell|list|failed|paper-)/.test(e.action));
  it('outputs counted at createAction: signAction logs its fee without counting again', async () => {
    const { post, account } = await setup();
    const c = await post('createAction', pay(1000, { signAndProcess: false }));
    const s = await post('signAction', { reference: (c.body.signableTransaction as { reference: string }).reference, spends: {} });
    expect(s.status).toBe(200);
    expect(readLog(account).map((e) => e.action)).toEqual(['send', 'brc100-signAction']);
    expect(spends(account)).toHaveLength(1);
    expect(readLog(account)[1].usd).toBeGreaterThan(0); // the fee still counts toward the daily cap
  });

  it('a 0-sat signable createAction is not counted; its signAction (the fee) is, once', async () => {
    const { post, account } = await setup();
    const c = await post('createAction', { description: 'sign flow data', outputs: [{ lockingScript: '006a04deadbeef', satoshis: 0, outputDescription: 'data blob' }], options: { signAndProcess: false } });
    await post('signAction', { reference: (c.body.signableTransaction as { reference: string }).reference, spends: {} });
    expect(readLog(account).map((e) => e.action)).toEqual(['sign', 'send']);
    expect(spends(account)).toHaveLength(1);
  });
});

describe('PIN level in the version (13 Nov 2026 re-review)', () => {
  it('reads `; pin=N;`, the legacy `+pN` and a pinnedProtocols field; caps the version at 30 bytes', () => {
    expect(pinLevelOf({ version: 'bwalletx-5.3.0; pin=3;' })).toBe(3);
    expect(pinLevelOf({ version: 'bwalletx-5.2.44+p2' })).toBe(2);
    expect(pinLevelOf({ version: 'wallet-brc100-1.0.0', pinnedProtocols: 4 })).toBe(4);
    expect(pinLevelOf('wallet-brc100-1.0.0')).toBe(0);
    expect(versionWithPin('bwalletx-serve-0.6.1', 3)).toBe('bwalletx-serve-0.6.1; pin=3;');
    expect(versionWithPin('bwalletx-serve-0.6.1', 0)).toBe('bwalletx-serve-0.6.1');
    expect(versionWithPin('bwalletx-serve-10.10.10', 123)).toBe('bwalletx-serve-10.10.10'); // would pass 30 bytes
  });
});
