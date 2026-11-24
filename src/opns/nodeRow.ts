/**
 * The wallet's own stored row for an OpNS tree node (24 Nov 2026: every "he*" name sat on "still catching up"
 * from 26 Oct, ~200 failed mints of ~30 min PoW each).
 *
 * When a mint spends a node that one of OUR earlier mints created (a restated parent or a child), wallet-toolbox
 * createAction uses its stored output row for that outpoint instead of the BEEF we pass. Those rows can be unusable:
 * no lockingScript the storage can produce (long scripts are kept only as an offset into a raw tx it may not hold)
 * and spendable=0 with spentBy NULL (processAction never marked them spendable, e.g. the action was recorded as
 * failed although the tx landed). createAction then refuses the input before signing:
 *   "… parameter must be output with valid lockingScript and satoshis"
 *   "… parameter must be spendable output unless noSend is true"
 *   "… spendable output. output <txid>:<vout> appears to have been spent (spendable=false)."
 * The last one matched isDoubleSpend, so the node was marked spent, the indexer un-marked it, and the name looped on
 * "catching up" for a month. The node tx is already loaded and verified (loadNode), so the row is repaired from it.
 */
import type { Transaction } from '@bsv/sdk';
import type { Db } from '../repair.js';

/** createAction refused a stored input row (the wallet's own data, not the chain). */
export const isStoredInputRejection = (e: unknown) =>
  /output with valid lockingScript and satoshis|spendable output unless noSend|appears to have been spent \(spendable=/i.test(
    e instanceof Error ? e.message : String(e),
  );

/** The wallet refused the name-tree input because of its own stored row. Never a double-spend, never "catching up". */
export class StoredNodeRowError extends Error {
  constructor(outpoint: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(
      `The wallet's stored copy of name-tree node ${outpoint} can't be used (${msg}). Run "bwalletx repair" for this account to repair it.`,
    );
    this.name = 'StoredNodeRowError';
  }
}

export type NodeRowFix = 'script' | 'satoshis' | 'spendable';

const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * Make our stored row for `tx`:`vout` usable as a createAction input: spendable when nothing in storage spends it,
 * plus the script and satoshis from the tx when storage can't produce them. Rows that are change, spent by one of our actions, or disagree with
 * the tx (different satoshis, script length or script bytes) are left alone. Returns what was fixed (empty: nothing to do).
 */
export async function repairNodeRow(db: Db, tx: Transaction, vout: number): Promise<NodeRowFix[]> {
  const out = tx.outputs[vout];
  if (!out) return [];
  const script = out.lockingScript.toBinary();
  const rows: Record<string, unknown>[] = await db('outputs').where({ txid: tx.id('hex'), vout });
  const fixes = new Set<NodeRowFix>();
  for (const r of rows) {
    if (r.change || (r.spentBy !== null && r.spentBy !== undefined)) continue;
    if (Number.isInteger(r.satoshis) && r.satoshis !== out.satoshis) continue;
    if (typeof r.scriptLength === 'number' && r.scriptLength > 0 && r.scriptLength !== script.length) continue;
    const stored = r.lockingScript as ArrayLike<number> | null | undefined;
    if (stored && stored.length > 0 && !sameBytes(stored, script)) continue;
    const update: Record<string, unknown> = {};
    // A missing script is the toolbox's normal layout for long scripts (read back from the raw tx by offset). It can
    // only do that for txs it holds as valid, so write the script just when it can't: no offset, or a failed tx.
    const hasOffset = Number(r.scriptLength) > 0 && Number(r.scriptOffset) > 0;
    const t: { status?: string } | undefined = await db('transactions').where({ transactionId: r.transactionId }).first();
    if ((!stored || stored.length === 0) && (!hasOffset || t?.status === 'failed')) {
      update.lockingScript = Buffer.from(script);
      fixes.add('script');
    }
    if (!Number.isInteger(r.satoshis)) {
      update.satoshis = out.satoshis;
      fixes.add('satoshis');
    }
    if (!r.spendable) {
      update.spendable = true;
      fixes.add('spendable');
    }
    if (Object.keys(update).length)
      await db('outputs')
        .where({ outputId: r.outputId })
        .update({ ...update, updated_at: new Date() });
  }
  return [...fixes];
}
