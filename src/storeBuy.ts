/**
 * bWalletX Store for agents: list products, quote, buy (themes $1, Theme edition $99/year, Branded edition
 * deposit from $999 by quote). Talks to the agent purchase API (yours-mobile site/api/agent-buy.js):
 *   GET  <api>/api/agent/products
 *   POST <api>/api/agent/quote   signed by the account's identity key (action agent-buy-quote)
 *   POST <api>/api/agent/buy     signed (agent-buy-claim) + the payment. As the bWalletX app does since the wallet
 *                                recovery release: an intent first (the Store records the txid, posts nothing), then
 *                                the account's own wallet broadcasts it, then the claim. 200 = bought; 202 = pending,
 *                                NOT bought yet (repeated a few times, then reported as pending); 409 payment_pending =
 *                                a payment for it is already on its way.
 * The payment comes from the account's own BRC-100 wallet and passes the same gate as every spend (kill switch,
 * daily cap, rate limit, strategy rules; paper mode never signs). Its dollars are reserved before signing, so
 * parallel buys can't all pass the cap, and stay counted once the payment may have left. The quote is checked here too before paying:
 * the dollar price must be within maxUsd and the sats must match it at our own BSV rate.
 * Env: BWALLETX_STORE_API (default https://pay.bwallet.space).
 */
import { Utils, type CreateActionArgs, type WalletInterface } from '@bsv/sdk';
import { reserveSpend, type Reserved } from './gate.js';
import { bsvUsd } from './market.js';
import { allStopped } from './store.js';
import { dryRunWallet, summariseArgs, type BuiltTx } from './sell.js';
import type { ActionRequest, AgentLogEntry } from './strategy.js';

export const DEFAULT_STORE_API = 'https://pay.bwallet.space';
/** Same BRC-43 scheme the in-app Store signs with (site/lib/paymail.js). */
export const SIGN_PROTOCOL: [2, string] = [2, 'bwallet paymail'];
export const SIGN_KEY_ID = '1';
/** How far the quoted sats may sit from our own rate before we refuse to pay (rates differ a little by source). */
export const RATE_TOLERANCE = 0.05;
const QUOTE_ID_RE = /^[0-9a-f]{32}$/;

export type Product = 'theme' | 'edition' | 'branded';
export type Quote = {
  product: Product;
  quote_id: string;
  usd: number;
  sats: number;
  outputs: { script: string; satoshis: number }[];
  memo_hex: string;
  expires_at: string;
  mnee?: { amount: number; accepted: boolean; note?: string };
  receipt?: unknown;
};
type Signer = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;
export type StoreAccount = { name: string; wallet: WalletInterface; close: () => Promise<void> };
export type StoreDeps = {
  api: () => string;
  fetch: typeof fetch;
  open: (account?: string) => Promise<StoreAccount>;
  rate: () => Promise<number>;
  /** Gate + reserve the dollars before signing (gate.ts reserveSpend); settled or released after. */
  reserve: (name: string, a: ActionRequest) => Promise<Reserved>;
  stopped: () => boolean;
  now: () => number;
  /** Waits between repeats of a pending claim. */
  sleep: (ms: number) => Promise<void>;
};

const defaultDeps = (): StoreDeps => ({
  api: () => (process.env.BWALLETX_STORE_API || DEFAULT_STORE_API).replace(/\/$/, ''),
  fetch: (...a) => fetch(...a),
  async open(account) {
    const { brc100Account } = await import('./brc100Actions.js');
    const { name, w } = await brc100Account(account);
    return { name, wallet: w.wallet as unknown as WalletInterface, close: () => w.close() };
  },
  rate: bsvUsd,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  reserve: (name, a) => reserveSpend(name, a),
  stopped: allStopped,
  now: () => Date.now(),
});
let override: Partial<StoreDeps> | null = null;
/** Tests: replace any network / wallet piece. `null` restores the real ones. */
export const setStoreDeps = (d: Partial<StoreDeps> | null) => (override = d);
const deps = (): StoreDeps => ({ ...defaultDeps(), ...(override ?? {}) });

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The message the server verifies: bwallet-paymail|v1|<action>|k=v sorted (site/lib/paymail.js signedMessage). */
export const signedMessage = (action: string, fields: Record<string, string>) =>
  ['bwallet-paymail', 'v1', action, ...Object.keys(fields).sort().map((k) => `${k}=${fields[k] ?? ''}`)].join('|');

const strings = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));

export async function signRequest(w: Signer, action: string, fields: Record<string, string>, now: number) {
  const { publicKey: identityKey } = await w.getPublicKey({ identityKey: true });
  const timestamp = now;
  const all = { ...fields, identityKey, timestamp: String(timestamp) };
  const { signature } = await w.createSignature({ data: Utils.toArray(signedMessage(action, all), 'utf8'), protocolID: SIGN_PROTOCOL, keyID: SIGN_KEY_ID, counterparty: 'anyone' });
  return { identityKey, timestamp, fields, signature: Utils.toHex(signature) };
}

async function call<T>(d: StoreDeps, path: string, body?: unknown): Promise<T> {
  const r = await d.fetch(`${d.api()}/api/agent/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new StoreError(`Store refused (${r.status}): ${String(j.error ?? 'error')}`, String(j.error ?? `http_${r.status}`), r.status);
  return j as T;
}

/** As call, but 2xx answers come back with their status: 200 = bought, 202 = pending (not bought yet). */
async function callStatus(d: StoreDeps, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await d.fetch(`${d.api()}/api/agent/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new StoreError(`Store refused (${r.status}): ${String(j.error ?? 'error')}`, String(j.error ?? `http_${r.status}`), r.status);
  return { status: r.status, body: j };
}

/** The catalogue: every product with its dollar price and the fields `quote` needs. */
export const listProducts = async () => call<Record<string, unknown>>(deps(), 'products');

export type QuoteOpts = { product: Product; fields?: Record<string, unknown>; account?: string };

async function quoteWith(d: StoreDeps, w: Signer, o: QuoteOpts): Promise<Quote> {
  const fields = strings({ ...(o.fields ?? {}), product: o.product });
  return call<Quote>(d, 'quote', await signRequest(w, 'agent-buy-quote', fields, d.now()));
}

/** A signed 5-minute quote (USD, sats, MNEE amount). Nothing is paid. */
export async function quote(o: QuoteOpts): Promise<Quote> {
  const d = deps();
  const acct = await d.open(o.account);
  try {
    return await quoteWith(d, acct.wallet, o);
  } finally {
    await acct.close();
  }
}

/** What we will and won't pay for. Returns a refusal, or null when the quote is fine to pay. */
export function checkQuote(q: Quote, o: { product: Product; maxUsd: number; rate: number; now: number }): string | null {
  if (q.product !== o.product) return `Quote is for ${q.product}, not ${o.product}`;
  if (!QUOTE_ID_RE.test(String(q.quote_id))) return 'Quote has no valid id';
  if (!(q.usd > 0) || q.usd > o.maxUsd + 1e-9) return `Quote is $${q.usd}, over maxUsd $${o.maxUsd}`;
  if (Date.parse(q.expires_at) <= o.now) return 'Quote expired';
  if (!Array.isArray(q.outputs) || q.outputs.length !== 1) return 'Quote must pay exactly one output';
  const out = q.outputs[0];
  if (!/^76a914[0-9a-f]{40}88ac$/.test(out.script)) return 'Quote output is not a plain address payment';
  if (out.satoshis !== q.sats || !(q.sats > 0)) return 'Quote sats do not match its output';
  if (!/^006a/.test(q.memo_hex)) return 'Quote memo is not a data output';
  if (o.rate > 0) {
    const atOurRate = (q.usd / o.rate) * 1e8;
    if (q.sats > atOurRate * (1 + RATE_TOLERANCE)) return `Quote asks ${q.sats} sats for $${q.usd}; our rate says about ${Math.round(atOurRate)}`;
  }
  return null;
}

export type BuyOpts = QuoteOpts & { maxUsd: number; dryRun?: boolean };
export type BuyResult = {
  ok: boolean;
  text: string;
  /** The payment is out (or another one is) but the network hasn't shown it yet: NOT bought yet. */
  pending?: boolean;
  dryRun?: boolean;
  quote?: Quote;
  built?: BuiltTx;
  txid?: string;
  result?: unknown;
};

/** How often a 202 claim is asked again, and the waits before each (the Store answers 200 once the network has it). */
export const PENDING_REPEATS_MS = [5_000, 10_000, 15_000];

/**
 * Send the unsent payment through the account's own wallet (createAction sendWith): its broadcaster posts the payment
 * with its ancestors, and the action leaves `nosend`, so its change can be spent again. 'refused' only when the
 * network answered no for this txid; anything unclear is 'unknown' and the payment is kept.
 */
async function sendOwnPayment(w: WalletInterface, txid: string): Promise<'sent' | 'refused' | 'unknown'> {
  const refused = new Set(['failed', 'invalidTx', 'doubleSpend']);
  const verdict = (rows: unknown): string | undefined =>
    Array.isArray(rows) ? (rows as { txid?: string; status?: string }[]).find((x) => x?.txid === txid)?.status : undefined;
  try {
    const r = await w.createAction({ description: 'bWalletX Store payment', options: { sendWith: [txid], acceptDelayedBroadcast: false } });
    const st = verdict(r.sendWithResults);
    return st === undefined ? 'unknown' : refused.has(st) ? 'refused' : 'sent';
  } catch (e) {
    const x = e as { sendWithResults?: unknown; reviewActionResults?: unknown };
    const st = verdict(x?.sendWithResults) ?? verdict(x?.reviewActionResults);
    return st !== undefined && refused.has(st) ? 'refused' : 'unknown';
  }
}

/**
 * Quote → check → gate → build the payment unsent → claim intent (the Store records the txid, posts nothing) → the
 * account's own wallet broadcasts it → claim. 200 = bought, granted to this identity key; 202 = pending, not bought yet.
 * The payment is released only when nothing was broadcast (the intent was refused). Once the wallet has sent it, it is
 * never released, whatever the Store answers.
 */
export async function buy(o: BuyOpts): Promise<BuyResult> {
  const d = deps();
  if (!o.dryRun && d.stopped()) return { ok: false, text: 'Refused: all agents are stopped (bwalletx resume)' };
  const acct = await d.open(o.account);
  try {
    let q: Quote;
    try {
      q = await quoteWith(d, acct.wallet, o);
    } catch (e) {
      if (e instanceof StoreError && e.code === 'payment_pending')
        return {
          ok: false,
          pending: true,
          text: 'Not paying again: a payment for this is already on its way (409 payment_pending). It completes once the network has it.',
        };
      throw e;
    }
    const bad = checkQuote(q, { product: o.product, maxUsd: o.maxUsd, rate: await d.rate().catch(() => 0), now: d.now() });
    if (bad) return { ok: false, text: `Refused: ${bad}`, quote: q };
    const args: CreateActionArgs = {
      description: `bWalletX Store: ${o.product}`,
      outputs: [
        { lockingScript: q.outputs[0].script, satoshis: q.sats, outputDescription: `bWalletX ${o.product}` },
        { lockingScript: q.memo_hex, satoshis: 0, outputDescription: 'Store order reference' },
      ],
      options: { noSend: true, randomizeOutputs: false, acceptDelayedBroadcast: false },
    };
    const label = `${o.product} for $${q.usd} (${q.sats} sats + network fee)`;
    if (o.dryRun) {
      const dry = dryRunWallet(acct.wallet);
      await dry.wallet.createAction(args).catch(() => null);
      const built = dry.captured[0] ? summariseArgs(dry.captured[0]) : undefined;
      return { ok: true, dryRun: true, quote: q, built, text: `Dry run: buy ${label}. Nothing signed, nothing broadcast.` };
    }
    const g = await d.reserve(acct.name, { kind: 'buy', token: 'bwalletx-store', usd: q.usd });
    if (!g.ok) return { ok: false, text: `Refused: ${g.reason}`, quote: q };
    if (g.paper) return { ok: false, text: 'Paper mode: nothing is signed (load the strategy --live, or unload it)', quote: q };
    // From the claim intent on, the signed payment has left this process: it stays counted against the cap.
    let out = false;
    let settled = false;
    let txid: string | undefined;
    const settle = (e: AgentLogEntry) => {
      settled = true;
      g.settle(e);
    };
    try {
      const r = await acct.wallet.createAction(args);
      if (!r.txid || !r.tx) throw new Error('The wallet did not build the payment');
      const id = r.txid;
      txid = id;
      const rawtx = Utils.toHex(r.tx);
      const claimBody = async (intent: boolean) => ({
        ...(await signRequest(acct.wallet, 'agent-buy-claim', { product: o.product, quote_id: q.quote_id, txid: id, ...(intent ? { intent: '1' } : {}) }, d.now())),
        rawtx,
      });
      const failed = (detail: string, usd = 0) => settle({ at: d.now(), action: 'failed', detail: `Store buy ${o.product}: ${detail}`, usd, txid: id });

      // 1. Intent: the Store checks the payment and records its txid. Nothing is posted, so a refusal releases it.
      try {
        await callStatus(d, 'buy', await claimBody(true));
      } catch (e) {
        await acct.wallet.abortAction({ reference: id }).catch(() => null);
        failed(`not sent, released: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
      out = true;

      // 2. The account's own wallet broadcasts it (ancestors included) and its change becomes spendable.
      const sent = await sendOwnPayment(acct.wallet, id);
      if (sent === 'refused') {
        failed('the network refused the payment');
        return { ok: false, text: `Not bought: the network refused the payment for ${label}. Nothing was paid.`, txid: id, quote: q };
      }

      // 3. Claim. From here the payment is out: never released, whatever the answer.
      let claim: { status: number; body: Record<string, unknown> } | undefined;
      let lastError: unknown;
      for (let i = 0; i <= PENDING_REPEATS_MS.length; i++) {
        if (i > 0) await d.sleep(PENDING_REPEATS_MS[i - 1]);
        try {
          claim = await callStatus(d, 'buy', await claimBody(false));
          lastError = undefined;
          if (claim.status === 200) break;
        } catch (e) {
          lastError = e;
          if (!(e instanceof StoreError && e.status === 502)) break;
        }
      }
      if (claim?.status === 200) {
        const text = `Bought ${label}`;
        settle({ at: d.now(), action: 'buy', detail: `${text} quote ${q.quote_id}`, usd: q.usd, txid: id });
        return { ok: true, text, txid: id, quote: q, result: claim.body };
      }
      if (lastError instanceof StoreError && lastError.status >= 400 && lastError.status < 500) {
        failed(`sent, but the Store refused the claim: ${lastError.message} (counted against the cap)`, q.usd);
        return {
          ok: false,
          text: `The payment for ${label} was sent, but the Store refused the claim (${lastError.code}). It is not released; email support@bwalletx.com with the txid.`,
          txid: id,
          quote: q,
        };
      }
      const why = lastError instanceof Error ? ` (${lastError.message})` : '';
      settle({ at: d.now(), action: 'buy', detail: `Pending, not bought yet: ${label} quote ${q.quote_id}${why}`, usd: q.usd, txid: id });
      return {
        ok: true,
        pending: true,
        text: `Pending, not bought yet: the payment for ${label} is sent, but the network hasn't shown it yet${why}. Don't pay again: the Store grants it once the network has it, even after the quote expires.`,
        txid: id,
        quote: q,
        result: claim?.body,
      };
    } finally {
      // Anything not settled above (a throw): counted if the payment may have left, else released.
      if (settled) {
        /* logged above */
      } else if (out) settle({ at: d.now(), action: 'failed', detail: `Store buy ${o.product}: interrupted after sending (counted against the cap)`, usd: q.usd, ...(txid && { txid }) });
      else g.release();
    }
  } finally {
    await acct.close();
  }
}
