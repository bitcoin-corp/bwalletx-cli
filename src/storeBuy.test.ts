import { afterEach, describe, expect, test, vi } from 'vitest';
import { P2PKH, PrivateKey, ProtoWallet, Utils, type WalletInterface } from '@bsv/sdk';
import { buy, checkQuote, setStoreDeps, signRequest, signedMessage, SIGN_KEY_ID, SIGN_PROTOCOL, type Quote, type StoreDeps } from './storeBuy';

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

const rig = (opts: { quote?: Quote; claimStatus?: number; gate?: ReturnType<StoreDeps['gate']>; stopped?: boolean } = {}) => {
  const priv = new PrivateKey(42);
  const pw = new ProtoWallet(priv);
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const createAction = vi.fn(async () => ({ txid: 'bb'.repeat(32), tx: [1, 2, 3] }));
  const abortAction = vi.fn(async () => ({ aborted: true }));
  const wallet = {
    getPublicKey: (a: { identityKey?: boolean }) => pw.getPublicKey(a as never),
    createSignature: (a: never) => pw.createSignature(a),
    createAction,
    abortAction,
  } as unknown as WalletInterface;
  const logs: unknown[] = [];
  setStoreDeps({
    api: () => 'https://store.test',
    fetch: (async (url: string, init?: { body?: string }) => {
      const path = String(url).split('/api/agent/')[1];
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push({ path, body });
      if (path === 'quote') return new Response(JSON.stringify(opts.quote ?? quoteFor()), { status: 200 });
      const s = opts.claimStatus ?? 200;
      return new Response(JSON.stringify(s === 200 ? { product: 'theme', pack: 'vexvoid' } : { error: 'underpaid' }), { status: s });
    }) as unknown as typeof fetch,
    open: async () => ({ name: 'agent1', wallet, close: async () => {} }),
    rate: async () => RATE,
    gate: () => opts.gate ?? { ok: true, paper: false },
    stopped: () => !!opts.stopped,
    log: (_n, e) => logs.push(e),
    now: () => NOW,
  });
  return { calls, createAction, abortAction, logs, identityKey: priv.toPublicKey().toString() };
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
  test('quote → pay unsent → claim with rawtx; logged as a buy', async () => {
    const r = rig();
    const out = await buy({ product: 'theme', fields: { pack: 'vexvoid' }, maxUsd: 2 });
    expect(out.ok).toBe(true);
    expect(r.createAction).toHaveBeenCalledOnce();
    const args = (r.createAction.mock.calls[0] as unknown[])[0] as { outputs: { satoshis: number }[]; options: { noSend: boolean } };
    expect(args.options.noSend).toBe(true);
    expect(args.outputs.map((o) => o.satoshis)).toEqual([1_999_500, 0]);
    expect(r.calls.map((c) => c.path)).toEqual(['quote', 'buy']);
    expect(r.calls[1].body).toMatchObject({ rawtx: '010203', fields: { product: 'theme', quote_id: 'a'.repeat(32), txid: 'bb'.repeat(32) } });
    expect(r.logs).toHaveLength(1);
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

  test('a server refusal (4xx) releases the unsent payment; a 502 keeps it', async () => {
    let r = rig({ claimStatus: 402 });
    await expect(buy({ product: 'theme', maxUsd: 2 })).rejects.toThrow(/underpaid/);
    expect(r.abortAction).toHaveBeenCalledWith({ reference: 'bb'.repeat(32) });
    r = rig({ claimStatus: 502 });
    await expect(buy({ product: 'theme', maxUsd: 2 })).rejects.toThrow();
    expect(r.abortAction).not.toHaveBeenCalled();
  });
});
