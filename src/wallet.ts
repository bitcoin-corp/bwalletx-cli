/**
 * Live signing for standalone mode: plain P2PKH BSV sends with @bsv/sdk against WhatsOnChain UTXOs,
 * broadcast to ARC (GorillaPool) with WhatsOnChain as fallback. Paymail via bsvalias (P2P destinations,
 * then basic paymentDestination). Keys only ever live in memory, decrypted from the key file.
 *
 * A paymail host chooses the scripts (and, for P2P, the amounts) it wants paid. Those are checked against what the
 * person asked to send before anything is signed: see checkPaymentOutputs.
 */
import { ARC, P2PKH, PrivateKey, SatoshisPerKilobyte, Script, Transaction } from '@bsv/sdk';
import { getJson, WOC } from './market.js';

export const DEFAULT_SATS_PER_KB = 100;
export const ARC_URL = 'https://arc.gorillapool.io';

type Utxo = { tx_hash: string; tx_pos: number; value: number; height: number };

export async function utxos(address: string): Promise<Utxo[]> {
  const r = await getJson<Utxo[] | { result?: Utxo[] }>(`${WOC}/address/${address}/unspent`);
  return Array.isArray(r) ? r : (r.result ?? []);
}

export async function rawTx(txid: string): Promise<string> {
  let res = await fetch(`${WOC}/tx/${txid}/hex`, { signal: AbortSignal.timeout(15_000) });
  for (let i = 1; res.status === 429 && i <= 3; i++) {
    await new Promise((r) => setTimeout(r, 800 * i));
    res = await fetch(`${WOC}/tx/${txid}/hex`, { signal: AbortSignal.timeout(15_000) });
  }
  if (!res.ok) throw new Error(`WhatsOnChain tx ${res.status}`);
  return (await res.text()).trim();
}

export type Destination = { outputs: { script: string; satoshis: number }[]; p2p?: { url: string; reference: string } };

/** At most this many outputs from one paymail host (the bWalletX app's own host returns 1). */
export const MAX_PAYMAIL_OUTPUTS = 10;
/** A standard P2PKH locking script: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG. */
const P2PKH_SCRIPT = /^76a914[0-9a-f]{40}88ac$/;
const isSats = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

export class PaymentOutputMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentOutputMismatch';
  }
}

/**
 * Check outputs a paymail host returned for a payment of `requested` sats, as the bWalletX app does (5.2.41):
 * 1 to MAX_PAYMAIL_OUTPUTS outputs, each a standard P2PKH script with a whole number of sats above 0, adding up to
 * exactly `requested`. Returns the outputs (scripts lower-cased) or throws PaymentOutputMismatch, which states the
 * requested and returned amounts. Nothing is signed before this passes.
 */
export function checkPaymentOutputs(to: string, outputs: unknown, requested: number): Destination['outputs'] {
  const list: unknown[] = Array.isArray(outputs) ? outputs : [];
  const returned = list.reduce<number>((s, o) => {
    const v = (o as { satoshis?: unknown } | null)?.satoshis;
    return typeof v === 'number' && Number.isFinite(v) ? s + v : s;
  }, 0);
  const refuse = (why: string) =>
    new PaymentOutputMismatch(
      `Payment to ${to} refused: ${why}. Requested ${requested} sats; the paymail host returned ${returned} sats in ${list.length} output${list.length === 1 ? '' : 's'}. Nothing was sent.`,
    );
  if (!isSats(requested)) throw refuse('the requested amount is not a whole number of sats above 0');
  if (!list.length) throw refuse('the paymail host returned no outputs');
  if (list.length > MAX_PAYMAIL_OUTPUTS) throw refuse(`the paymail host returned more than ${MAX_PAYMAIL_OUTPUTS} outputs`);
  const checked: Destination['outputs'] = [];
  for (const o of list) {
    const { script, satoshis } = (o ?? {}) as { script?: unknown; satoshis?: unknown };
    if (!isSats(satoshis)) throw refuse('an output has an invalid amount (each must be a whole number of sats above 0)');
    const hex = typeof script === 'string' ? script.toLowerCase() : '';
    if (!P2PKH_SCRIPT.test(hex)) throw refuse('an output is not a standard P2PKH script');
    checked.push({ script: hex, satoshis });
  }
  if (returned !== requested)
    throw refuse(returned > requested ? 'the outputs add up to more than the amount requested' : 'the outputs add up to less than the amount requested');
  return checked;
}

/** Turn an address or paymail into locking scripts for `sats`. Paymail outputs are checked (checkPaymentOutputs). */
export async function resolveDestination(to: string, sats: number, sender: string): Promise<Destination> {
  if (!to.includes('@')) {
    return { outputs: [{ script: new P2PKH().lock(to).toHex(), satoshis: sats }] };
  }
  const [alias, domain] = to.toLowerCase().split('@');
  if (!alias || !domain) throw new Error(`Bad paymail ${to}`);
  const caps = (await getJson<{ capabilities?: Record<string, unknown> }>(`https://${domain}/.well-known/bsvalias`)).capabilities ?? {};
  const fill = (u: string) => u.replace('{alias}', alias).replace('{domain.tld}', domain);
  const p2pDest = caps['2a40af698840'];
  const p2pRecv = caps['5f1323cddf31'];
  if (typeof p2pDest === 'string' && typeof p2pRecv === 'string') {
    const r = await getJson<{ outputs?: unknown; reference?: unknown }>(fill(p2pDest), 15_000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ satoshis: sats }),
    });
    // The host chooses these: never pay them unchecked, and never fall back to another path when they fail the check.
    const outputs = checkPaymentOutputs(to, r?.outputs, sats);
    if (typeof r.reference !== 'string' || !r.reference) throw new PaymentOutputMismatch(`Payment to ${to} refused: the paymail host returned no reference. Nothing was sent.`);
    return { outputs, p2p: { url: fill(p2pRecv), reference: r.reference } };
  }
  const basic = caps.paymentDestination;
  if (typeof basic === 'string') {
    const r = await getJson<{ output: string }>(fill(basic), 15_000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ senderHandle: sender, senderName: 'bwalletx-cli', dt: new Date().toISOString(), amount: sats, purpose: 'bwalletx send' }),
    });
    if (!r?.output) throw new Error('Paymail returned no output');
    // The amount is ours here; the script is the host's, so it gets the same check.
    return { outputs: checkPaymentOutputs(to, [{ script: r.output, satoshis: sats }], sats) };
  }
  throw new Error(`${domain} doesn't offer a paymail payment destination`);
}

/** Build + sign a tx paying `dest` from the pay key's P2PKH UTXOs, change back to the pay address. */
export async function buildSend(payWif: string, dest: Destination, satsPerKb = DEFAULT_SATS_PER_KB): Promise<Transaction> {
  const key = PrivateKey.fromWif(payWif);
  const address = key.toAddress();
  const need = dest.outputs.reduce((s, o) => s + o.satoshis, 0);
  // Coins of 1 sat may be ordinals/tokens: never spend them as fee money.
  const coins = (await utxos(address)).filter((u) => u.value > 1).sort((a, b) => b.value - a.value);
  const tx = new Transaction();
  let have = 0;
  for (const u of coins) {
    if (have >= need + 200 + tx.inputs.length * 20) break;
    tx.addInput({
      sourceTransaction: Transaction.fromHex(await rawTx(u.tx_hash)),
      sourceOutputIndex: u.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(key),
    });
    have += u.value;
  }
  if (have < need) throw new Error(`Not enough BSV: have ${have} sats, need ${need} + fee`);
  for (const o of dest.outputs) tx.addOutput({ lockingScript: Script.fromHex(o.script), satoshis: o.satoshis });
  tx.addOutput({ lockingScript: new P2PKH().lock(address), change: true });
  await tx.fee(new SatoshisPerKilobyte(satsPerKb));
  await tx.sign();
  return tx;
}

export async function broadcast(tx: Transaction): Promise<string> {
  const txid = tx.id('hex');
  let arcErr = 'unknown';
  try {
    const arc = await tx.broadcast(new ARC(ARC_URL));
    if (arc.status === 'success') return txid;
    arcErr = `${arc.code ?? ''} ${arc.description ?? ''}`.trim();
  } catch (e) {
    arcErr = e instanceof Error ? e.message : String(e);
  }
  const res = await fetch(`${WOC}/tx/raw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txhex: tx.toHex() }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.text()).replace(/"/g, '').trim();
  if (res.ok && /^[0-9a-f]{64}$/.test(body)) return body;
  // ARC accepted it but answered oddly, then WhatsOnChain sees it already: that is a success (13 Oct 2026, a gift send).
  if (/already in the mempool|already known|txn-already-known/i.test(body)) return txid;
  throw new Error(`Broadcast failed: ARC ${arcErr}; WhatsOnChain ${res.status} ${body.slice(0, 200)}`);
}

/** Hand a P2P paymail payment to the receiver (it broadcasts too). */
export async function notifyP2p(p2p: NonNullable<Destination['p2p']>, tx: Transaction, sender: string) {
  const res = await fetch(p2p.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hex: tx.toHex(), reference: p2p.reference, metadata: { sender, note: 'bwalletx' } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Paymail receiver refused the payment (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

export const addressOf = (wif: string) => PrivateKey.fromWif(wif).toAddress();
