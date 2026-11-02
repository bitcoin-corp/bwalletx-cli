/**
 * `bwalletx stamp <file>` and `bwalletx verify <file> <txid>`: put a file's SHA-256 on chain, and check it later.
 *
 * Use it to timestamp records (receipts, minutes, contracts): the file's hash goes on chain and its txid can be kept
 * in a Markdown register (`--register`). Only the hash goes on chain, in one 0-sat OP_RETURN output:
 *
 *   OP_FALSE OP_RETURN "bwx.stamp/1" <32-byte sha256>
 *
 * Never the file and never its name, so a stamp is private by default. It runs from an agent key-file account (no
 * phone tap), through the same gate as every spend (kill switch, daily cap, rate limit, strategy rules). A paired
 * account is refused: its keys stay on the phone.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { LockingScript, OP, Utils } from '@bsv/sdk';
import { gateAction } from './gate.js';
import { assertNothingUnsent } from './repair.js';
import { bsvUsd } from './market.js';
import { appendLog, withSpendLock } from './store.js';
import type { AgentWallet } from './brc100.js';

export const STAMP_TAG = 'bwx.stamp/1';
/** Rough network fee of a stamp, in sats, for the spending gate (a one-input, two-output tx at 100 sat/kB is ~25). */
const STAMP_FEE_SATS = 50;

export type StampResult = { file: string; sha256: string; txid: string; account: string; timestamp: string };

export const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The stamp's locking script for a hex SHA-256. */
export function stampScript(sha256Hex: string): LockingScript {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error('sha256 must be 64 hex characters');
  return new LockingScript([
    { op: OP.OP_FALSE },
    { op: OP.OP_RETURN },
    { op: STAMP_TAG.length, data: Utils.toArray(STAMP_TAG, 'utf8') },
    { op: 32, data: Utils.toArray(sha256Hex, 'hex') },
  ]);
}

/**
 * The SHA-256 a script stamps, or null if it isn't a bwx.stamp/1 output. Read from the raw bytes: the SDK parses
 * everything after OP_RETURN as one data chunk.
 */
export function stampedHash(scriptHex: string): string | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(scriptHex)) return null;
  const b = Utils.toArray(scriptHex, 'hex');
  const tag = Utils.toArray(STAMP_TAG, 'utf8');
  // OP_FALSE OP_RETURN <push tag> <push 32>
  if (b.length !== 2 + 1 + tag.length + 1 + 32 || b[0] !== OP.OP_FALSE || b[1] !== OP.OP_RETURN) return null;
  if (b[2] !== tag.length || tag.some((c, i) => b[3 + i] !== c)) return null;
  const at = 3 + tag.length;
  if (b[at] !== 32) return null;
  return Utils.toHex(b.slice(at + 1));
}

type StampWallet = Pick<AgentWallet, 'wallet' | 'sendWaiting' | 'db'>;

/** Stamp one file from an open agent wallet: gate, sign, broadcast, relay, log, optionally register. */
export function stampWith(
  name: string,
  w: StampWallet,
  file: string,
  o: { rate: number; register?: string; relay?: (r: unknown) => Promise<unknown>; now?: () => Date },
): Promise<StampResult> {
  return withSpendLock(name, async () => {
    const sha256 = sha256File(file);
    // Never build on a parent the network hasn't seen: it would be refused and lock the coins it spends (2 Nov 2026).
    await assertNothingUnsent(w.db, name);
    const usd = (STAMP_FEE_SATS / 1e8) * o.rate;
    const g = gateAction(name, { kind: 'send', token: 'BSV', usd, to: 'stamp' });
    if (!g.ok) throw new Error(`Refused: ${g.reason}`);
    if (g.paper) throw new Error('Paper mode: nothing is signed');
    const r = await w.wallet.createAction(
      {
        description: 'bwalletx stamp',
        outputs: [{ lockingScript: stampScript(sha256).toHex(), satoshis: 0, outputDescription: 'file hash stamp' }],
        options: { acceptDelayedBroadcast: false },
      },
      'bwalletx-cli',
    );
    if (!r.txid) throw new Error('The wallet returned no txid');
    await w.sendWaiting();
    if (o.relay) await o.relay(r).catch(() => undefined);
    const timestamp = (o.now?.() ?? new Date()).toISOString();
    const result: StampResult = { file: basename(file), sha256, txid: r.txid, account: name, timestamp };
    appendLog(name, { at: Date.now(), action: 'send', detail: `stamp ${result.file} ${sha256} ${r.txid}`, usd });
    if (o.register) registerStamp(o.register, result);
    return result;
  });
}

/** Append a row to a Markdown register table, creating the file with its header if missing. */
export function registerStamp(path: string, s: StampResult) {
  if (!existsSync(path))
    writeFileSync(path, '# Seal register\n\n| Time (UTC) | File | SHA-256 | Txid | Account |\n|---|---|---|---|---|\n');
  appendFileSync(path, `| ${s.timestamp} | ${s.file.replace(/\|/g, '\\|')} | ${s.sha256} | ${s.txid} | ${s.account} |\n`);
}

export type VerifyResult = {
  file: string;
  sha256: string;
  txid: string;
  match: boolean;
  stamped: string | null;
  confirmations: number;
  blockTime?: string;
};

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Recheck a file against a stamp on chain (WhatsOnChain). `match` is true only when the tx carries this file's hash. */
export async function verifyStamp(file: string, txid: string, f: FetchLike = fetch as unknown as FetchLike): Promise<VerifyResult> {
  if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('txid must be 64 hex characters');
  const sha256 = sha256File(file);
  const res = await f(`https://api.whatsonchain.com/v1/bsv/main/tx/hash/${txid.toLowerCase()}`);
  if (!res.ok) throw new Error(`Transaction lookup failed (HTTP ${res.status})`);
  const tx = (await res.json()) as { vout?: { scriptPubKey?: { hex?: string } }[]; confirmations?: number; blocktime?: number };
  const stamps = (tx.vout ?? []).map((v) => stampedHash(v.scriptPubKey?.hex ?? '')).filter((h): h is string => !!h);
  return {
    file: basename(file),
    sha256,
    txid: txid.toLowerCase(),
    match: stamps.includes(sha256),
    stamped: stamps[0] ?? null,
    confirmations: tx.confirmations ?? 0,
    ...(tx.blocktime && { blockTime: new Date(tx.blocktime * 1000).toISOString() }),
  };
}

/** The CLI entry: open the account's own BRC-100 wallet, stamp, close. */
export async function stampFile(file: string, o: { account?: string; register?: string }): Promise<StampResult> {
  const { brc100Account } = await import('./brc100Actions.js');
  const { name, b, w } = await brc100Account(o.account);
  try {
    return await stampWith(name, w, file, { rate: await bsvUsd(), register: o.register, relay: b.relayToArc });
  } finally {
    await w.close();
  }
}
