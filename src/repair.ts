/**
 * `bwalletx repair`: get an agent account's BRC-100 wallet back in step with the chain after a broadcast failed.
 *
 * Seen 2 Nov 2026 (company stamping account `bstamp`): `brc100 fund` signed the import tx but never broadcast it (the
 * first broadcaster timed out, TAAL ARC answered 401, sendWaiting swallowed it). Two stamps then spent its outputs, the
 * network refused them ("missing inputs"), and the toolbox marked them failed but left their inputs unspendable:
 * ~10,089 sats gone from the balance while nothing had left the wallet on chain.
 *
 * repair:
 *   1. re-broadcasts every unsent/sending tx to GorillaPool ARC as Extended Format (its parents come from the stored
 *      input BEEF), oldest first, and marks it unmined/unproven when ARC accepts it;
 *   2. frees outputs left unspendable by failed actions: an output that is not itself from a failed tx, is spent by
 *      nothing in storage, and the chain says is unspent becomes spendable again.
 * `assertNothingUnsent` lets spends refuse to build on a parent the network hasn't seen.
 */
import { Beef, Transaction, Utils } from '@bsv/sdk';

/** The slice of a knex handle this module uses (the CLI's SQLite storage). */
export type Db = (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const ARC_URL = 'https://arc.gorillapool.io';
const SEND_STATUSES = ['unsent', 'sending'];
const ARC_OK = /SEEN_ON_NETWORK|STORED|ANNOUNCED|SENT_TO_NETWORK|ACCEPTED|MINED|RECEIVED|REQUESTED|SEEN_IN_ORPHAN/;

type Req = { provenTxReqId: number; txid: string; status: string; rawTx: Uint8Array | number[] | null; inputBEEF: Uint8Array | number[] | null };

export type Post = (rawTxHex: string) => Promise<{ ok: boolean; status: number; txStatus?: string; detail?: string }>;
export type IsUnspent = (txid: string, vout: number) => Promise<boolean | undefined>;

/** POST one tx to ARC; ok when ARC took it (or already has it). */
export const postToArc: Post = async (rawTx) => {
  const r = await fetch(`${ARC_URL}/v1/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawTx }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await r.json().catch(() => ({}))) as { txStatus?: string; extraInfo?: string; detail?: string; title?: string };
  const txStatus = j.txStatus ?? '';
  const already = /already|known|duplicate/i.test(`${j.detail ?? ''} ${j.title ?? ''} ${j.extraInfo ?? ''}`);
  return { ok: (r.ok && ARC_OK.test(txStatus)) || already, status: r.status, txStatus, detail: j.detail ?? j.extraInfo ?? j.title };
};

/** WhatsOnChain: true unspent, false spent, undefined unknown (tx not found or the lookup failed). */
export const wocIsUnspent: IsUnspent = async (txid, vout) => {
  const tx = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/hash/${txid}`, { signal: AbortSignal.timeout(15_000) });
  if (!tx.ok) return undefined;
  const r = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/${vout}/spent`, { signal: AbortSignal.timeout(15_000) });
  if (r.status === 404) return true;
  if (!r.ok) return undefined;
  const j = (await r.json().catch(() => null)) as { txid?: string } | null;
  return j?.txid ? false : undefined;
};

/** The tx as Extended Format hex, its parents taken from the stored input BEEF; plain hex if they're missing. */
export function extendedHex(req: Req): string {
  const raw = Array.from(req.rawTx ?? []);
  if (!raw.length) throw new Error(`no raw tx stored for ${req.txid}`);
  const beef = req.inputBEEF?.length ? Beef.fromBinary(Array.from(req.inputBEEF)) : new Beef();
  beef.mergeRawTx(raw);
  try {
    return Transaction.fromAtomicBEEF(beef.toBinaryAtomic(req.txid)).toHexEF();
  } catch {
    return Utils.toHex(raw);
  }
}

export async function unsentReqs(db: Db): Promise<Req[]> {
  return db('proven_tx_reqs').whereIn('status', SEND_STATUSES).orderBy('provenTxReqId', 'asc');
}

/** Refuse to build a spend while any of the wallet's own txs hasn't reached the network. */
export async function assertNothingUnsent(db: Db | undefined, account: string) {
  if (!db) return;
  const n = (await unsentReqs(db)).length;
  if (n)
    throw new Error(
      `${n} of this wallet's transactions hasn't reached the network yet, so anything built on it would be refused. Run \`bwalletx repair -a ${account}\` first.`,
    );
}

export type RepairReport = {
  rebroadcast: { txid: string; ok: boolean; detail?: string }[];
  freed: { outpoint: string; satoshis: number }[];
  skipped: { outpoint: string; reason: string }[];
};

export async function repairWallet(db: Db, o: { post?: Post; isUnspent?: IsUnspent } = {}): Promise<RepairReport> {
  const post = o.post ?? postToArc;
  const isUnspent = o.isUnspent ?? wocIsUnspent;
  const report: RepairReport = { rebroadcast: [], freed: [], skipped: [] };

  for (const req of await unsentReqs(db)) {
    let res: Awaited<ReturnType<Post>>;
    try {
      res = await post(extendedHex(req));
    } catch (e) {
      res = { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) };
    }
    report.rebroadcast.push({ txid: req.txid, ok: res.ok, detail: res.txStatus || res.detail });
    if (!res.ok) continue;
    await db('proven_tx_reqs').where({ provenTxReqId: req.provenTxReqId }).update({ status: 'unmined' });
    await db('transactions').where({ txid: req.txid }).whereIn('status', ['sending', 'unprocessed']).update({ status: 'unproven' });
  }

  // Outputs a failed action locked: unspendable, spent by nothing in storage, from a tx that isn't failed itself.
  const failedIds = (await db('transactions').where({ status: 'failed' }).select('transactionId')).map(
    (r: { transactionId: number }) => r.transactionId,
  );
  const locked: { outputId: number; txid: string | null; vout: number; satoshis: number; transactionId: number }[] = await db('outputs')
    .where({ spendable: false })
    .whereNull('spentBy')
    .where('satoshis', '>', 0)
    .whereNotIn('transactionId', failedIds.length ? failedIds : [-1]);
  for (const out of locked) {
    const outpoint = `${out.txid}.${out.vout}`;
    if (!out.txid) {
      report.skipped.push({ outpoint, reason: 'no txid' });
      continue;
    }
    const unspent = await isUnspent(out.txid, out.vout);
    if (unspent !== true) {
      report.skipped.push({ outpoint, reason: unspent === false ? 'spent on chain' : 'not confirmed on chain yet; run repair again later' });
      continue;
    }
    await db('outputs').where({ outputId: out.outputId }).update({ spendable: true });
    report.freed.push({ outpoint, satoshis: Number(out.satoshis) });
  }
  return report;
}
