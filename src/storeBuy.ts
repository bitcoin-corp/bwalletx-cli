/**
 * bWalletX Store for agents: list products, quote, buy (themes $1, Theme edition $99/year, Branded edition
 * deposit from $999 by quote). Talks to the agent purchase API (yours-mobile site/api/agent-buy.js):
 *   GET  <api>/api/agent/products
 *   POST <api>/api/agent/quote   signed by the account's identity key (action agent-buy-quote)
 *   POST <api>/api/agent/buy     signed (agent-buy-claim) + the payment, built unsent; the server checks it and broadcasts
 * The payment comes from the account's own BRC-100 wallet and passes the same gate as every spend (kill switch,
 * daily cap, rate limit, strategy rules; paper mode never signs). The quote is checked here too before paying:
 * the dollar price must be within maxUsd and the sats must match it at our own BSV rate.
 * Env: BWALLETX_STORE_API (default https://pay.bwallet.space).
 */
import { Utils, type CreateActionArgs, type WalletInterface } from '@bsv/sdk';
import { gateAction } from './gate.js';
import { bsvUsd } from './market.js';
import { allStopped, appendLog } from './store.js';
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
  gate: (name: string, a: ActionRequest) => { ok: true; paper: boolean } | { ok: false; reason: string };
  stopped: () => boolean;
  log: (name: string, e: AgentLogEntry) => void;
  now: () => number;
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
  gate: (name, a) => gateAction(name, a),
  stopped: allStopped,
  log: appendLog,
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
export type BuyResult = { ok: boolean; text: string; dryRun?: boolean; quote?: Quote; built?: BuiltTx; txid?: string; result?: unknown };

/** Quote → check → gate → build the payment unsent → the server checks + broadcasts → granted to this identity key. */
export async function buy(o: BuyOpts): Promise<BuyResult> {
  const d = deps();
  if (!o.dryRun && d.stopped()) return { ok: false, text: 'Refused: all agents are stopped (bwalletx resume)' };
  const acct = await d.open(o.account);
  try {
    const q = await quoteWith(d, acct.wallet, o);
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
    const g = d.gate(acct.name, { kind: 'buy', token: 'bwalletx-store', usd: q.usd });
    if (!g.ok) return { ok: false, text: `Refused: ${g.reason}`, quote: q };
    if (g.paper) return { ok: false, text: 'Paper mode: nothing is signed (load the strategy --live, or unload it)', quote: q };
    const r = await acct.wallet.createAction(args);
    if (!r.txid || !r.tx) throw new Error('The wallet did not build the payment');
    const rawtx = Utils.toHex(r.tx);
    try {
      const claim = await call<Record<string, unknown>>(d, 'buy', { ...(await signRequest(acct.wallet, 'agent-buy-claim', { product: o.product, quote_id: q.quote_id, txid: r.txid }, d.now())), rawtx });
      const text = `Bought ${label}`;
      d.log(acct.name, { at: d.now(), action: 'buy', detail: `${text} quote ${q.quote_id}`, usd: q.usd, txid: r.txid });
      return { ok: true, text, txid: r.txid, quote: q, result: claim };
    } catch (e) {
      // Refused before broadcast (4xx): release the unsent payment. A 502 may follow a broadcast the network took: keep it.
      if (e instanceof StoreError && e.status >= 400 && e.status < 500) await acct.wallet.abortAction({ reference: r.txid }).catch(() => null);
      d.log(acct.name, { at: d.now(), action: 'failed', detail: `Store buy ${o.product} failed: ${e instanceof Error ? e.message : String(e)}`, usd: 0, txid: r.txid });
      throw e;
    }
  } finally {
    await acct.close();
  }
}
