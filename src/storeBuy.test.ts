import { afterEach, describe, expect, test, vi } from 'vitest';
import { P2PKH, PrivateKey, ProtoWallet, Utils, type WalletInterface } from '@bsv/sdk';
import { buy, checkQuote, PENDING_REPEATS_MS, setStoreDeps, signRequest, signedMessage, SIGN_KEY_ID, SIGN_PROTOCOL, type Quote, type StoreDeps } from './storeBuy';

const NOW = 1_800_000_000_000;
const PAY = new PrivateKey(7).toPublicKey().toAddress();
const RATE = 50;
const quoteFor = (over: Partial<Quote> = {}): Quote => ({
  product: 'theme',
  quote_id: 'a'.repeat(32),
  usd: 1,
  sats: 1_999_500,
  outputs: [{ script: new P2PKH().lock(PAY).toHex(), satoshis: 1_999_500 }],
  memo_hex: '006a0d6277782d7468656d652d627579',
  expires_at: new Date(NOW + 300_000).toISOString(),
  mnee: { amount: 1, accepted: false },
  ...over,
});

afterEach(() => setStoreDeps(null));

type RigOpts = {
  quote?: Quote;
  /** Answer to a quote request (default 200 with the quote). */
  quoteStatus?: number;
  /** Answer to the claim intent (default 202 pending, intent). */
  intentStatus?: number;
  /** Answers to the claims after the broadcast, in turn; the last one repeats (default 200). */
  claimStatus?: number | number[];
  /** The wallet's own broadcast verdict for the payment (default unproven), or a thrown review error. */
  send?: string | { throws: { reviewActionResults?: unknown; sendWithResults?: unknown } };
  gate?: ReturnType<StoreDeps['gate']>;
  stopped?: boolean;
};

const BODIES: Record<number, Record<string, unknown>> = {
  200: { product: 'theme', pack: 'vexvoid' },
  202: { product: 'theme', pack: 'vexvoid', pending: true, status: 'ANNOUNCED_TO_NETWORK' },
  402: { error: 'underpaid' },
  409: { error: 'payment_pending' },
  502: { error: 'broadcast_failed', pending: true },
};

const rig = (opts: RigOpts = {}) => {
  const priv = new PrivateKey(42);
  const pw = new ProtoWallet(priv);
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const claims = Array.isArray(opts.claimStatus) ? [...opts.claimStatus] : [opts.claimStatus ?? 200];
  const createAction = vi.fn(async (args: { options?: { sendWith?: string[] } }) => {
    if (!args.options?.sendWith) return { txid: 'bb'.repeat(32), tx: [1, 2, 3] };
    if (typeof opts.send === 'object') throw Object.assign(new Error('WERR_REVIEW_ACTIONS'), opts.send.throws);
    return { sendWithResults: [{ txid: 'bb'.repeat(32), status: opts.send ?? 'unproven' }] };
  });
  const abortAction = vi.fn(async () => ({ aborted: true }));
  const wallet = {
    getPublicKey: (a: { identityKey?: boolean }) => pw.getPublicKey(a as never),
    createSignature: (a: never) => pw.createSignature(a),
    createAction,
    abortAction,
  } as unknown as WalletInterface;
  const logs: unknown[] = [];
  const sleeps: number[] = [];
  setStoreDeps({
    api: () => 'https://store.test',
    fetch: (async (url: string, init?: { body?: string }) => {
      const path = String(url).split('/api/agent/')[1];
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push({ path, body });
      if (path === 'quote') {
        const qs = opts.quoteStatus ?? 200;
        return new Response(JSON.stringify(qs === 200 ? (opts.quote ?? quoteFor()) : BODIES[qs]), { status: qs });
      }
      const st = (body.fields as { intent?: string })?.intent === '1' ? (opts.intentStatus ?? 202) : claims.length > 1 ? claims.shift()! : claims[0];
      return new Response(JSON.stringify(BODIES[st] ?? { error: 'x' }), { status: st });
    }) as unknown as typeof fetch,
    open: async () => ({ name: 'agent1', wallet, close: async () => {} }),
    rate: async () => RATE,
    gate: () => opts.gate ?? { ok: true, paper: false },
    stopped: () => !!opts.stopped,
    log: (_n, e) => logs.push(e),
    now: () => NOW,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { calls, createAction, abortAction, logs, sleeps, identityKey: priv.toPublicKey().toString() };
};

describe('checkQuote', () => {
  const base = { product: 'theme' as const, maxUsd: 2, rate: RATE, now: NOW };
  test('a fair quote passes', () => expect(checkQuote(quoteFor(), base)).toBeNull());
  test('over maxUsd', () => expect(checkQuote(quoteFor({ usd: 99 }), base)).toMatch(/over maxUsd/));
  test('wrong product', () => expect(checkQuote(quoteFor({ product: 'edition' }), base)).toMatch(/not theme/));
  test('expired', () => expect(checkQuote(quoteFor(), { ...base, now: NOW + 300_001 })).toMatch(/expired/));
  test('sats inflated beyond our rate', () => {
    const q = quoteFor({ sats: 4_000_000, outputs: [{ script: new P2PKH().lock(PAY).toHex(), satoshis: 4_000_000 }] });
    expect(checkQuote(q, base)).toMatch(/our rate/);
  });
  test('extra outputs or odd scripts', () => {
    expect(checkQuote(quoteFor({ outputs: [...quoteFor().outputs, ...quoteFor().outputs] }), base)).toMatch(/exactly one/);
    expect(checkQuote(quoteFor({ outputs: [{ script: '51', satoshis: 1_999_500 }] }), base)).toMatch(/plain address/);
  });
});

describe('signRequest', () => {
  test('matches the server scheme (bwallet paymail, keyID 1, anyone)', async () => {
    const priv = new PrivateKey(5);
    const r = await signRequest(new ProtoWallet(priv), 'agent-buy-quote', { product: 'theme', pack: 'npg' }, NOW);
    const msg = signedMessage('agent-buy-quote', { product: 'theme', pack: 'npg', identityKey: r.identityKey, timestamp: String(NOW) });
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(msg, 'utf8'),
      signature: Utils.toArray(r.signature, 'hex'),
      protocolID: SIGN_PROTOCOL,
      keyID: SIGN_KEY_ID,
      counterparty: r.identityKey,
    });
    expect(valid).toBe(true);
  });
});

describe('buy', () => {
  test('quote → pay unsent → claim intent → the wallet broadcasts it → claim; 200 = bought, logged', async () => {
    const r = rig();
    const out = await buy({ product: 'theme', fields: { pack: 'vexvoid' }, maxUsd: 2 });
    expect(out).toMatchObject({ ok: true, txid: 'bb'.repeat(32) });
    expect(out.pending).toBeUndefined();
    expect(out.text).toMatch(/^Bought /);
    expect(r.createAction).toHaveBeenCalledTimes(2);
    const args = (r.createAction.mock.calls[0] as unknown[])[0] as { outputs: { satoshis: number }[]; options: { noSend: boolean } };
    expect(args.options.noSend).toBe(true);
    expect(args.outputs.map((o) => o.satoshis)).toEqual([1_999_500, 0]);
    // The account's own wallet sends it (AtomicBEEF with ancestors; the action leaves nosend, so change is spendable).
    const send = (r.createAction.mock.calls[1] as unknown[])[0] as { options: { sendWith: string[]; acceptDelayedBroadcast: boolean } };
    expect(send.options).toEqual({ sendWith: ['bb'.repeat(32)], acceptDelayedBroadcast: false });
    expect(r.calls.map((c) => c.path)).toEqual(['quote', 'buy', 'buy']);
    expect(r.calls[1].body).toMatchObject({ rawtx: '010203', fields: { product: 'theme', quote_id: 'a'.repeat(32), txid: 'bb'.repeat(32), intent: '1' } });
    expect((r.calls[2].body.fields as Record<string, string>).intent).toBeUndefined();
    expect(r.abortAction).not.toHaveBeenCalled();
    expect(r.logs).toHaveLength(1);
  });

  test('202 is pending, NOT bought: asked again a few times, then reported as pending, never released', async () => {
    const r = rig({ claimStatus: 202 });
    const out = await buy({ product: 'theme', fields: { pack: 'vexvoid' }, maxUsd: 2 });
    expect(out).toMatchObject({ ok: true, pending: true, txid: 'bb'.repeat(32) });
    expect(out.text).toMatch(/^Pending, not bought yet/);
    expect(out.text).toMatch(/Don't pay again/);
    expect(out.text).not.toMatch(/^Bought/);
    expect(r.calls.filter((c) => c.path === 'buy')).toHaveLength(1 + 1 + PENDING_REPEATS_MS.length);
    expect(r.sleeps).toEqual(PENDING_REPEATS_MS);
    expect(r.abortAction).not.toHaveBeenCalled();
  });

  test('202 then 200 on a repeat: bought', async () => {
    const r = rig({ claimStatus: [202, 200] });
    const out = await buy({ product: 'theme', fields: { pack: 'vexvoid' }, maxUsd: 2 });
    expect(out.ok).toBe(true);
    expect(out.pending).toBeUndefined();
    expect(out.text).toMatch(/^Bought /);
    expect(r.sleeps).toEqual([PENDING_REPEATS_MS[0]]);
  });

  test('409 payment_pending at quote time: nothing built, nothing paid, said plainly', async () => {
    const r = rig({ quoteStatus: 409 });
    const out = await buy({ product: 'theme', fields: { pack: 'vexvoid' }, maxUsd: 2 });
    expect(out).toMatchObject({ ok: false, pending: true });
    expect(out.text).toMatch(/already on its way/);
    expect(r.createAction).not.toHaveBeenCalled();
  });

  test('the network refuses the wallet broadcast: not bought, no claim, nothing released by us', async () => {
    for (const send of ['failed', { throws: { reviewActionResults: [{ txid: 'bb'.repeat(32), status: 'doubleSpend' }] } }] as const) {
      const r = rig({ send });
      const out = await buy({ product: 'theme', fields: { pack: 'vexvoid' }, maxUsd: 2 });
      expect(out.ok).toBe(false);
      expect(out.text).toMatch(/refused the payment/);
      expect(r.calls.map((c) => c.path)).toEqual(['quote', 'buy']); // the intent only
      expect(r.abortAction).not.toHaveBeenCalled(); // the toolbox already released the inputs
    }
  });

  test('an unclear wallet broadcast keeps the payment and still claims (the Store posts it too)', async () => {
    const r = rig({ send: { throws: {} } });
    const out = await buy({ product: 'theme', fields: { pack: 'vexvoid' }, maxUsd: 2 });
    expect(out.ok).toBe(true);
    expect(r.calls.map((c) => c.path)).toEqual(['quote', 'buy', 'buy']);
    expect(r.abortAction).not.toHaveBeenCalled();
  });

  test('gate refusal and paper mode: nothing built', async () => {
    let r = rig({ gate: { ok: false, reason: 'Over today' } });
    expect((await buy({ product: 'theme', fields: { pack: 'npg' }, maxUsd: 2 })).text).toMatch(/Over today/);
    expect(r.createAction).not.toHaveBeenCalled();
    r = rig({ gate: { ok: true, paper: true } });
    expect((await buy({ product: 'theme', fields: { pack: 'npg' }, maxUsd: 2 })).ok).toBe(false);
    expect(r.createAction).not.toHaveBeenCalled();
  });

  test('stopped agents and over-max quotes are refused before paying', async () => {
    let r = rig({ stopped: true });
    expect((await buy({ product: 'theme', maxUsd: 2 })).ok).toBe(false);
    expect(r.calls).toEqual([]);
    r = rig({ quote: quoteFor({ product: 'edition', usd: 99 }) });
    expect((await buy({ product: 'edition', maxUsd: 5 })).text).toMatch(/over maxUsd/);
    expect(r.createAction).not.toHaveBeenCalled();
  });

  test('the intent refused (4xx): nothing was broadcast, so the unsent payment is released and not sent', async () => {
    const r = rig({ intentStatus: 402 });
    await expect(buy({ product: 'theme', maxUsd: 2 })).rejects.toThrow(/underpaid/);
    expect(r.abortAction).toHaveBeenCalledWith({ reference: 'bb'.repeat(32) });
    expect(r.createAction).toHaveBeenCalledOnce(); // built, never sent
  });

  test('after the broadcast the payment is never released: a 502 is pending, a 4xx says so with the txid', async () => {
    let r = rig({ claimStatus: 502 });
    let out = await buy({ product: 'theme', maxUsd: 2 });
    expect(out).toMatchObject({ ok: true, pending: true });
    expect(r.abortAction).not.toHaveBeenCalled();
    r = rig({ claimStatus: 409 });
    out = await buy({ product: 'theme', maxUsd: 2 });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/was sent, but the Store refused the claim \(payment_pending\)/);
    expect(out.txid).toBe('bb'.repeat(32));
    expect(r.abortAction).not.toHaveBeenCalled();
  });
});
