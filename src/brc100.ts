/**
 * BRC-100 mode: an agent account as a full BRC-100 wallet (createAction, signAction, getPublicKey,
 * createSignature, listOutputs, internalizeAction…), built on @bsv/wallet-toolbox with a local
 * SQLite store at ~/.bwalletx/brc100/<account>.sqlite. Standalone accounts only: the keys are
 * decrypted from the key file into memory, never written anywhere.
 *
 * `serve` puts it on http://localhost:3321, the port BRC-100 sites already probe for a desktop
 * wallet (BSV Desktop / Metanet), so any such site can use the agent account. Guard rails:
 *   - only origins on the allowlist get an answer;
 *   - every createAction passes the same gate as `send` (kill switch, daily cap, rate limit,
 *     loaded strategy) for the BSV it would take out of the account, network fee included (local
 *     mode builds noSend first, prices the signed tx, then sends it);
 *   - a site can only send, chain on or abort the noSend builds it made in this serve session;
 *   - every call that spends or signs is logged to ~/.bwalletx/log/<account>.jsonl.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { CreateActionArgs, WalletInterface } from '@bsv/sdk';
import type { Wallet } from '@bsv/wallet-toolbox';
import { gateAction } from './gate.js';
import { bsvUsd } from './market.js';
import { appendLog, home, withSpendLock } from './store.js';
import { utxos } from './wallet.js';
import type { AgentKeys } from './keyfile.js';
import { repairStaleProofs, type RepairResult } from './opns/proofRepair.js';
import { syncProofs, type SyncResult } from './opns/proofSync.js';
import { bearerOf, checkToken, comparisonCode, issueToken } from './servePairing.js';
import { randomBytes } from 'node:crypto';

/** proven_tx_reqs statuses still waiting for a merkle proof (toolbox TaskCheckForProofs / TaskCheckNoSends). */
const UNPROVEN = ['callback', 'unmined', 'sending', 'unknown', 'unconfirmed', 'nosend'];

export const BRC100_PORT = 3321;

// The toolbox is CommonJS and checks keys against the SDK's CommonJS build, so everything handed
// to it comes from that same build (mixing in the ESM build's classes fails its instanceof checks).
const require = createRequire(import.meta.url);
const sdk = require('@bsv/sdk') as typeof import('@bsv/sdk');
const toolbox = require('@bsv/wallet-toolbox') as typeof import('@bsv/wallet-toolbox');
const { Beef, CachedKeyDeriver, KeyDeriver, PrivateKey, normalizeBRC100WalletByteFields, stringifyBRC100 } = sdk;
const { Monitor, Services, Setup, StorageKnex, WalletStorageManager } = toolbox;

export type AgentWallet = {
  wallet: Wallet;
  identityKey: string;
  payAddress: string;
  /** Broadcast whatever the wallet has queued (the toolbox sends in the background by default). */
  sendWaiting: () => Promise<void>;
  /** Run the monitor in the background (broadcasts, proofs, status) while a long-lived command runs. */
  startMonitor: () => void;
  /** Re-check stored merkle proofs against the chain and re-prove any from an orphaned block (see opns/proofRepair.ts). */
  repairProofs?: () => Promise<RepairResult>;
  /** Fetch merkle proofs for the wallet's unproven txs and mark them completed (see opns/proofSync.ts). */
  syncProofs?: () => Promise<SyncResult>;
  close: () => Promise<void>;
  /** The wallet's own SQLite storage (knex), for `bwalletx repair` and the unsent-parent guard. */
  db?: import('./repair.js').Db;
};

/** The storage the bWalletX app syncs every account to (1Sat Storage). */
export const SHARED_STORAGE_URL = 'https://wallet.1sat.app';

/**
 * The account's wallet exactly as the bWalletX app sees it: rooted on the account's identity key, with
 * 1Sat Storage as the active store. For the app and the CLI to share it safely, the account's active
 * storage in the app must be that remote too (Settings › Wallet Backup), not the phone's local store.
 * No local monitor: with a remote active store the storage server broadcasts and tracks proofs.
 */
export async function openSharedWallet(keys: AgentKeys, url = SHARED_STORAGE_URL): Promise<AgentWallet> {
  const rootKey = PrivateKey.fromWif(keys.identityPk);
  const keyDeriver = new CachedKeyDeriver(rootKey);
  const storage = new WalletStorageManager(keyDeriver.identityKey);
  const services = new Services('main');
  const wallet = new toolbox.Wallet({ chain: 'main', keyDeriver: keyDeriver as never, storage, services });
  await storage.addWalletStorageProvider(new toolbox.StorageClient(wallet, url));
  await storage.makeAvailable();
  return {
    wallet,
    identityKey: keyDeriver.identityKey,
    payAddress: PrivateKey.fromWif(keys.payPk).toAddress(),
    sendWaiting: async () => undefined,
    startMonitor: () => undefined,
    close: async () => {
      await wallet.destroy().catch(() => undefined);
    },
  };
}

/**
 * The CLI's original private wallet (0.3.0–0.3.3): rooted on the pay key, local SQLite. Kept so its
 * balance can be moved into the shared wallet with `brc100 migrate`.
 */
export async function openWallet(account: string, keys: AgentKeys): Promise<AgentWallet> {
  const dir = join(home(), 'brc100');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rootKey = PrivateKey.fromWif(keys.payPk);
  const keyDeriver = new CachedKeyDeriver(rootKey);
  const identityKey = keyDeriver.identityKey;
  const storage = new WalletStorageManager(identityKey);
  const services = new Services('main');
  const knex = Setup.createSQLiteKnex(join(dir, `${account.replace(/[^\w.-]/g, '_')}.sqlite`));
  const active = new StorageKnex({ chain: 'main', knex, commissionSatoshis: 0, commissionPubKeyHex: undefined, feeModel: { model: 'sat/kb', value: 100 } });
  await active.migrate(`bwalletx-${account}`, identityKey);
  await active.makeAvailable();
  await storage.addWalletStorageProvider(active);
  const monitor = new Monitor(Monitor.createDefaultWalletMonitorOptions('main', storage, services));
  monitor.addDefaultTasks();
  // `as never`: same CJS class at runtime; TypeScript only sees the ESM typings for our require.
  const wallet = new toolbox.Wallet({ chain: 'main', keyDeriver: keyDeriver as never, storage, services, monitor });
  return {
    wallet,
    identityKey,
    payAddress: rootKey.toAddress(),
    db: knex as unknown as import('./repair.js').Db,
    sendWaiting: async () => {
      await monitor.runTask('SendWaiting').catch(() => undefined);
    },
    startMonitor: () => {
      monitor.startTasks().catch(() => undefined);
    },
    // The local monitor gets no reorg events, so proofs taken from a losing block stay put (16 Oct 2026).
    repairProofs: async () => {
      const tracker = await services.getChainTracker();
      return repairStaleProofs({
        roots: async () =>
          (await knex('proven_txs').distinct('height', 'merkleRoot').orderBy('height', 'desc')) as { height: number; merkleRoot: string }[],
        isValidRoot: (root, height) => tracker.isValidRootForHeight(root, height),
        reprove: async (height, root) => {
          const r = await storage.reproveHeightMerkleRoot(height, root);
          return { updated: r.updated.length, unavailable: r.unavailable.length + r.unchanged.length };
        },
      });
    },
    syncProofs: () =>
      syncProofs({
        unproven: async () => {
          const r = (await knex('proven_tx_reqs').whereIn('status', UNPROVEN).count({ n: '*' })) as { n: number | string }[];
          return Number(r[0]?.n ?? 0);
        },
        tip: async () => {
          const h = await monitor.chaintracks.findChainTipHeader();
          return h as unknown as { height: number; hash: string };
        },
        newHeader: (h) => monitor.processNewBlockHeader(h as never),
        runTask: (t) => monitor.runTask(t),
      }),
    close: async () => {
      await monitor.destroy().catch(() => undefined);
      await wallet.destroy().catch(() => undefined);
    },
  };
}

/**
 * The addresses the bWalletX app shows for this account: BRC-42 children of the identity key at
 * protocol [0,'onesat'] (and the older [0,'p 1sat']), keyID "1sat <n>", counterparty self, n = 0…
 * The app's receive screen shows index 0 and adds more with "new address".
 */
/** Smallest coin `fund` moves; smaller ones cost about as much in fees as they hold. */
export const FUND_MIN = 1_000;

export const DEPOSIT_PROTOCOLS: [0, string][] = [
  [0, 'onesat'],
  [0, 'p 1sat'],
];
export function appAddresses(identityWif: string, count = 10) {
  const kd = new KeyDeriver(PrivateKey.fromWif(identityWif));
  const out: { address: string; key: InstanceType<typeof PrivateKey>; label: string }[] = [];
  for (const proto of DEPOSIT_PROTOCOLS)
    for (let n = 0; n < count; n++) {
      const key = kd.derivePrivateKey(proto, `1sat ${n}`, 'self');
      out.push({ address: key.toAddress(), key, label: `app receive address ${n}${proto[1] === 'onesat' ? '' : ' (legacy)'}` });
    }
  return out;
}

/**
 * Move plain BSV into the BRC-100 wallet from the account's pay address (what `send` spends and the
 * key file names) and from the receive addresses the bWalletX app shows for it.
 * Coins of 1 sat are left alone: they may hold ordinals or tokens.
 */
export async function fundFromPayAddress(w: AgentWallet, keys: AgentKeys) {
  const pay = PrivateKey.fromWif(keys.payPk);
  const sources = [{ address: w.payAddress, key: pay, label: 'pay address' }, ...appAddresses(keys.identityPk)];
  const results: { outpoint: string; success: boolean; error?: string; from?: string }[] = [];
  let moved = 0;
  let sats = 0;
  for (const src of sources) {
    // Skip dust: below FUND_MIN a coin costs about as much to move as it holds.
    const coins = (await utxos(src.address).catch(() => [])).filter((u) => u.value >= FUND_MIN);
    if (!coins.length) continue;
    let r: { outpoint: string; success: boolean; error?: string }[];
    try {
      r = await Setup.fundWalletFromP2PKHOutpoints(
        w.wallet,
        coins.map((u) => `${u.tx_hash}.${u.tx_pos}`),
        { privateKey: src.key, publicKey: src.key.toPublicKey(), address: src.address } as never,
      );
    } catch (e) {
      // One address failing (e.g. a provider can't serve a source tx) must not block the others.
      const error = e instanceof Error ? e.message : String(e);
      results.push(...coins.map((u) => ({ outpoint: `${u.tx_hash}.${u.tx_pos}`, success: false, error, from: `${src.label} ${src.address}` })));
      continue;
    }
    const ok = new Set(r.filter((x) => x.success).map((x) => x.outpoint));
    moved += ok.size;
    sats += coins.filter((u) => ok.has(`${u.tx_hash}.${u.tx_pos}`)).reduce((n, u) => n + u.value, 0);
    results.push(...r.map((x) => ({ ...x, from: `${src.label} ${src.address}` })));
  }
  // The toolbox queues new transactions for its monitor to broadcast; send them before we return.
  if (moved) await w.sendWaiting();
  return { moved, sats, results };
}

export async function walletBalance(w: AgentWallet) {
  const r = await w.wallet.listOutputs({ basket: 'default', limit: 10_000 }, 'bwalletx-cli');
  return r.outputs.filter((o) => o.spendable).reduce((n, o) => n + o.satoshis, 0);
}

/**
 * Move everything in the old local wallet into the shared one, as a BRC-29 payment the shared wallet
 * internalizes (so it lands in its default basket, spendable by the app and the CLI alike).
 */
export async function migrateLocalToShared(local: AgentWallet, shared: AgentWallet, note: (detail: string) => void = () => undefined) {
  const have = await walletBalance(local);
  const sats = have - 300; // leave the network fee
  if (sats < FUND_MIN) return { sats: 0, txid: null as string | null };
  const derivationPrefix = sdk.Utils.toBase64(sdk.Random(8));
  const derivationSuffix = sdk.Utils.toBase64(sdk.Random(8));
  const { publicKey } = await shared.wallet.getPublicKey(
    { protocolID: [2, '3241645161d8'], keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: local.identityKey },
    'bwalletx-cli',
  );
  const lockingScript = new sdk.P2PKH().lock(sdk.PublicKey.fromString(publicKey).toAddress()).toHex();
  // Recorded before broadcasting: if internalizing fails, these recover the payment.
  note(`migrate remittance: prefix ${derivationPrefix} suffix ${derivationSuffix} sender ${local.identityKey} to ${shared.identityKey}`);
  const r = await local.wallet.createAction(
    { description: 'bwalletx: move into the shared wallet', outputs: [{ lockingScript, satoshis: sats, outputDescription: 'to the shared wallet' }], options: { acceptDelayedBroadcast: false, randomizeOutputs: false } },
    'bwalletx-cli',
  );
  if (!r.tx) throw new Error('The local wallet returned no transaction');
  await shared.wallet.internalizeAction(
    {
      tx: r.tx,
      description: 'bwalletx: moved in from the CLI wallet',
      outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: local.identityKey } }],
    },
    'bwalletx-cli',
  );
  return { sats, txid: r.txid ?? null };
}

/**
 * Sats a createAction takes out of the account: what its outputs carry minus what the caller's
 * own inputs (from inputBEEF, e.g. a pool's coins in a trade) bring in. The wallet's change and
 * fee are on top; the fee is small, change comes back.
 */
export function outgoingSats(args: CreateActionArgs, owned: ReadonlySet<string> = new Set()): number {
  const out = (args.outputs ?? []).reduce((n, o) => n + o.satoshis, 0);
  if (!args.inputs?.length || !args.inputBEEF) return out;
  let brought = 0;
  try {
    const beef = Beef.fromBinary(Array.from(args.inputBEEF));
    for (const i of args.inputs) {
      // The wallet's OWN coins named as inputs are not brought in by the caller: counting them would let a
      // site spend the account's balance past the cap with outgoingSats = 0 (18 Oct 2026 review).
      if (owned.has(i.outpoint)) continue;
      const [txid, vout] = i.outpoint.split('.');
      const tx = beef.findTxid(txid)?.tx;
      brought += tx?.outputs[Number(vout)]?.satoshis ?? 0;
    }
  } catch {
    return out; // unreadable BEEF: count the outputs in full
  }
  return Math.max(0, out - brought);
}

/**
 * The toolbox's default broadcasters can land a transaction at WhatsOnChain without it ever reaching
 * the miners (seen live: two agent txs sat unmined until re-sent to ARC). So everything the agent signs
 * is also handed to GorillaPool's ARC, as Extended Format when the BEEF carries the parents. Idempotent.
 */
export async function relayToArc(result: unknown, url = 'https://arc.gorillapool.io') {
  const tx = (result as { tx?: number[] } | null)?.tx;
  if (!tx?.length) return;
  const t = sdk.Transaction.fromAtomicBEEF(Array.from(tx));
  let rawTx: string;
  try {
    rawTx = t.toHexEF();
  } catch {
    rawTx = t.toHex();
  }
  await fetch(`${url}/v1/tx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rawTx }), signal: AbortSignal.timeout(15_000) });
}

type SendWithResult = { txid?: unknown; status?: unknown };
type ActionResult = { txid?: string; tx?: number[]; sendWithResults?: SendWithResult[]; signableTransaction?: { reference?: string } };

/**
 * Which txids serve may hand to ARC after a createAction/signAction, given what the wallet did.
 *
 * Only what the wallet itself shared with the network: the toolbox lists exactly those in sendWithResults (the new
 * tx unless it was built noSend, plus every txid named in options.sendWith), with status 'failed' for any it
 * refused. A noSend build is never relayed itself, whatever the result says: the app asked for it to be held
 * (build → check → sendWith, or abortAction), and broadcasting it anyway pays twice and breaks the wallet's
 * records (13 Nov 2026 review). A result without sendWithResults (not the toolbox) relays its own tx only when
 * it wasn't noSend. Parents first: the new tx goes last, after the sendWith txids it may spend.
 */
export function txidsToRelay(out: unknown, o: { noSend: boolean }): string[] {
  const r = (out ?? {}) as ActionResult;
  const subject = typeof r.txid === 'string' ? r.txid : undefined;
  let ids: string[];
  if (Array.isArray(r.sendWithResults)) {
    ids = r.sendWithResults.filter((x) => typeof x?.txid === 'string' && x.status !== 'failed').map((x) => x.txid as string);
  } else {
    ids = !o.noSend && subject && r.tx?.length ? [subject] : [];
  }
  if (o.noSend && subject) ids = ids.filter((t) => t !== subject);
  const uniq = [...new Set(ids)];
  return subject && uniq.includes(subject) ? [...uniq.filter((t) => t !== subject), subject] : uniq;
}

/**
 * The package version, read lazily: the Bun-compiled bNamesX PC miner has no package.json beside it, and reading it
 * at import crashed the miner ('/$bunfs/package.json' ENOENT). Falls back to this constant; a test keeps them equal.
 */
export const VERSION_FALLBACK = '0.6.1';
let serveVersionCache: string | undefined;
/** What `getVersion` answers from serve. 0.6.1+ never relays a noSend build and only sends a site's own builds. */
export function serveVersion(): string {
  if (serveVersionCache) return serveVersionCache;
  let v = VERSION_FALLBACK;
  try {
    const p = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    if (typeof p.version === 'string' && p.version) v = p.version;
  } catch {
    // a compiled binary: no package.json
  }
  return (serveVersionCache = `bwalletx-serve-${v}`);
}
/** Paired mode: serve's version plus the phone's PIN level, which sites read as `pin=N`. */
export const pairedVersion = (phoneVersion: unknown) => {
  const m = /pin=(\d+)/.exec(String(phoneVersion ?? ''));
  return m ? `${serveVersion()}; pin=${m[1]};` : serveVersion();
};

/** Network fee of a signed AtomicBEEF tx: what its inputs bring minus what its outputs carry. undefined if an input's value is unknown. */
export function feeOf(tx: ArrayLike<number>, inputBEEF?: ArrayLike<number>): number | undefined {
  let t: InstanceType<typeof sdk.Transaction>;
  try {
    t = sdk.Transaction.fromAtomicBEEF(Array.from(tx));
  } catch {
    return undefined;
  }
  let caller: InstanceType<typeof Beef> | undefined;
  try {
    if (inputBEEF?.length) caller = Beef.fromBinary(Array.from(inputBEEF));
  } catch {
    caller = undefined;
  }
  let ins = 0;
  for (const i of t.inputs) {
    let v = i.sourceTransaction?.outputs[i.sourceOutputIndex]?.satoshis;
    if (v === undefined && i.sourceTXID) v = caller?.findTxid(i.sourceTXID)?.tx?.outputs[i.sourceOutputIndex]?.satoshis;
    if (v === undefined) return undefined;
    ins += v;
  }
  return ins - t.outputs.reduce((n, x) => n + (x.satoshis ?? 0), 0);
}

/** Calls a site may make. Everything else (privileged key linkage, certificates) is refused. */
const ALLOWED = new Set([
  'createAction',
  'signAction',
  'abortAction',
  'listActions',
  'internalizeAction',
  'listOutputs',
  'relinquishOutput',
  'getPublicKey',
  'encrypt',
  'decrypt',
  'createHmac',
  'verifyHmac',
  'createSignature',
  'verifySignature',
  'isAuthenticated',
  'waitForAuthentication',
  'getHeight',
  'getHeaderForHeight',
  'getNetwork',
  'getVersion',
]);
const LOGGED = new Set(['createAction', 'signAction', 'internalizeAction', 'createSignature', 'relinquishOutput']);

const hostOf = (origin: string) => {
  try {
    return new URL(origin.includes('://') ? origin : `https://${origin}`).host.toLowerCase();
  } catch {
    return origin.toLowerCase();
  }
};

/** A wallet error the SDK client turns back into a proper error with our message (code 6). */
const refusal = (message: string) => ({ isError: true, code: 6, parameter: 'bwalletx', message });

/**
 * The wallet behind `serve`: the CLI's own (local or shared storage) or the owner's paired bWalletX.
 * `paired` backends sign and broadcast on the phone, so serve doesn't relay to ARC for them and only
 * forwards the calls in PAIRED_FORWARD.
 */
export type ServeWallet = {
  paired: boolean;
  call: (method: string, args: unknown, site: string) => Promise<unknown>;
  /** Outpoints ("txid.vout") the wallet itself holds as spendable BSV; inputs naming them are the account's money. */
  owned?: () => Promise<Set<string>>;
  close: () => Promise<void>;
};

export const localBackend = (w: AgentWallet): ServeWallet => {
  const api = w.wallet as unknown as Record<string, (args: unknown, originator?: string) => Promise<unknown>>;
  return {
    paired: false,
    call: (m, args, site) => api[m](args, site),
    owned: async () => {
      const r = await w.wallet.listOutputs({ basket: 'default', limit: 10_000 }, 'bwalletx-cli');
      return new Set(r.outputs.map((o) => o.outpoint));
    },
    close: () => w.close(),
  };
};

/** Phase 1 (read-only) and phase 2 (createAction/signAction: the phone prompts every time). */
export const PAIRED_FORWARD = new Set(['getPublicKey', 'listOutputs', 'isAuthenticated', 'waitForAuthentication', 'getNetwork', 'getHeight', 'createAction', 'signAction']);
/** Never leave the machine, whatever the mode. */
export const NEVER_FORWARD = new Set(['revealCounterpartyKeyLinkage', 'revealSpecificKeyLinkage']);

export class WalletUnreachable extends Error {
  name = 'WalletUnreachable';
}

/**
 * Forward to the paired main wallet over the pairing relay. One connection, reopened when it drops.
 * No fallback to a local wallet: a timeout or a dead relay is a "wallet unreachable" error.
 */
export async function pairedBackend(name: string, o: { timeoutMs?: number } = {}): Promise<ServeWallet> {
  const { PhoneSession, callBrc100 } = await import('./paired.js');
  let session: import('./paired.js').PhoneSession | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const one = async (method: string, args: unknown, site: string) => {
    try {
      if (!session?.isOpen) session = await PhoneSession.open(name);
    } catch (e) {
      throw new WalletUnreachable(`wallet unreachable: ${(e as Error).message}`);
    }
    try {
      return await callBrc100(name, method, args, site, { session, timeoutMs: o.timeoutMs });
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code) throw err; // the phone answered (refused, cap, user said no)
      throw new WalletUnreachable(`wallet unreachable: ${err.message}`);
    }
  };
  return {
    paired: true,
    // Serialised: one sealed request at a time keeps the counters and the relay's rate limit happy.
    call: (method, args, site) => {
      const r = queue.then(() => one(method, args, site));
      queue = r.catch(() => undefined);
      return r;
    },
    close: async () => session?.close(),
  };
}

export type ServeOptions = {
  account: string;
  origins: string[];
  port?: number;
  onEvent?: (line: string) => void;
  /**
   * For tests: what is called to hand one signed tx to ARC (local mode only), as { txid, tx: AtomicBEEF }.
   * Called only for txids the wallet itself broadcast or queued (see txidsToRelay), never for a noSend build.
   */
  arc?: (result: { txid: string; tx: number[] }) => Promise<void>;
  /** For tests: BSV price instead of fetching it. */
  usdPerBsv?: () => Promise<number>;
  /** Most one createAction may move, in USD, whatever the account's own caps say. Default SERVE_MAX_USD_PER_ACTION. */
  maxUsdPerAction?: number;
  /** Most this serve session may move in total, in USD. Default SERVE_SESSION_BUDGET_USD. */
  sessionBudgetUsd?: number;
  /** Most network fee one action may pay, in sats (local mode). Default SERVE_MAX_FEE_SATS. */
  maxFeeSats?: number;
  /**
   * Let sites move tokens/ordinals: createActions with BSV-20/21 inscribed outputs or that name the
   * wallet's own outputs as inputs. Off by default: the caps value satoshis only, and a token output
   * is 1 sat however much the token is worth, so these would otherwise slip under every cap.
   */
  allowTokenTransfers?: boolean;
  /**
   * Ask the owner to approve a new site: shows the origin and the 8-digit comparison code, resolves y/N.
   * Without it every pairing request is refused (no site can get a token).
   */
  confirmPairing?: (req: { origin: string; code: string }) => Promise<boolean>;
};

/** Calls a site may make before pairing, so it can detect the wallet. They are answered by serve itself and leak nothing. */
export const UNAUTHENTICATED = new Set(['getVersion', 'isAuthenticated']);

/**
 * Defaults for automatic payments from sites (24 Oct 2026 audit, after the x402 SDK findings): an account
 * with no daily cap and no approval threshold must not be drainable by one 402 asking for everything.
 */
export const SERVE_MAX_USD_PER_ACTION = 1;

/** Does any output carry a BSV-20/21 inscription (the token transfer JSON inside an ord envelope)? */
const BSV20_MARK = Buffer.from('"p":"bsv-20"').toString('hex');
export const hasTokenOutputs = (args: CreateActionArgs) =>
  (args.outputs ?? []).some((o) => typeof o.lockingScript === 'string' && o.lockingScript.toLowerCase().includes(BSV20_MARK));

/** Outpoints the site named that are the wallet's own (its tokens, ordinals or coins). */
export const namedOwnedInputs = (args: CreateActionArgs, owned: ReadonlySet<string>) =>
  (args.inputs ?? []).map((i) => i.outpoint).filter((op) => owned.has(op));
export const SERVE_SESSION_BUDGET_USD = 5;
/** Default most network fee per action: ~100 KB of data at the wallet's 100 sat/kB. A plain payment pays ~50. */
export const SERVE_MAX_FEE_SATS = 10_000;

/**
 * BRC-103/104 mutual-auth signatures and nonces. Keys are derived per counterparty, not per site, so an
 * allowed site could ask for a login signature addressed to ANOTHER site's server and relay it. Those are
 * only signed when serve allows a single origin, so the requester is the only site the login can be for.
 */
const AUTH_PROTOCOLS = new Set(['auth message signature', 'server hmac']);
export const isAuthProtocolCall = (call: string, args: unknown) => {
  if (!['createSignature', 'createHmac'].includes(call)) return false;
  const p = (args as { protocolID?: unknown } | null)?.protocolID;
  return Array.isArray(p) && typeof p[1] === 'string' && AUTH_PROTOCOLS.has(p[1].trim().toLowerCase());
};

/** Serve a wallet over the BRC-100 HTTP JSON substrate. Resolves once listening. */
export async function serve(input: AgentWallet | ServeWallet, o: ServeOptions) {
  const w: ServeWallet = 'call' in input ? input : localBackend(input);
  const allowed = new Set(o.origins.map(hostOf));
  // No wildcards, ever (0.6.0): '*' (or '*.example') would let any web page on this machine drive the wallet.
  if ([...allowed].some((h) => !h || h.includes('*'))) throw new Error("bwalletx serve: wildcard origins like '*' are not allowed; name each site (e.g. --origin www.example.com localhost:3000)");
  if (!allowed.size) throw new Error('bwalletx serve: name at least one site with --origin');
  const maxPerAction = o.maxUsdPerAction ?? SERVE_MAX_USD_PER_ACTION;
  const budget = o.sessionBudgetUsd ?? SERVE_SESSION_BUDGET_USD;
  let sessionSpentUsd = 0;
  const singleSite = allowed.size === 1;
  const say = o.onEvent ?? (() => undefined);
  const arc = o.arc ?? relayToArc;
  const price = o.usdPerBsv ?? bsvUsd;
  const maxFee = o.maxFeeSats ?? SERVE_MAX_FEE_SATS;

  // Local mode bookkeeping (13 Nov 2026 review). The noSend builds each site made in this session: only that site
  // may sendWith them, chain on their noSendChange or abort them. Their AtomicBEEF is kept for the ARC relay,
  // capped in bytes (oldest dropped first: an evicted build can still be sent, it just gets no ARC nudge).
  const owners = new Map<string, string>();
  const beefs = new Map<string, Uint8Array>();
  let beefBytes = 0;
  const MAX_HELD = 10_000;
  const MAX_BEEF_BYTES = 64 * 1024 * 1024;
  type Pending = {
    origin: string;
    noSend: boolean;
    sendWith: string[];
    acceptDelayedBroadcast?: boolean;
    returnTXIDOnly: boolean;
    /** Sats the outputs take (counted at createAction) and the USD reserved for them then. */
    sats: number;
    usd: number;
    description: string;
    inputBEEF?: number[];
  };
  /** createActions waiting for signAction, by reference: whose they are and what the site asked for. */
  const signRefs = new Map<string, Pending>();
  const dropBeef = (txid: string) => {
    const b = beefs.get(txid);
    if (b) beefBytes -= b.length;
    beefs.delete(txid);
  };
  const hold = (txid: string, origin: string, tx: ArrayLike<number>) => {
    owners.delete(txid);
    owners.set(txid, origin);
    while (owners.size > MAX_HELD) {
      const k = owners.keys().next().value as string;
      owners.delete(k);
      dropBeef(k);
    }
    dropBeef(txid);
    const b = Uint8Array.from(tx);
    if (b.length > MAX_BEEF_BYTES) return;
    beefs.set(txid, b);
    beefBytes += b.length;
    while (beefBytes > MAX_BEEF_BYTES) dropBeef(beefs.keys().next().value as string);
  };
  const release = (txid: string) => {
    owners.delete(txid);
    dropBeef(txid);
  };
  const rememberRef = (ref: string, p: Pending) => {
    signRefs.delete(ref);
    signRefs.set(ref, p);
    while (signRefs.size > 1_000) signRefs.delete(signRefs.keys().next().value as string);
  };
  const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

  const beefFor = (txid: string, subject: string | undefined, full: number[] | undefined): number[] | undefined => {
    if (subject === txid && full?.length) return full;
    const h = beefs.get(txid);
    if (h) return Array.from(h);
    if (!full?.length) return undefined;
    try {
      return Beef.fromBinary(full).findAtomicTransaction(txid)?.toAtomicBEEF(true);
    } catch {
      return undefined;
    }
  };
  /** After the CLI's own wallet acted: relay only what the wallet itself sent or queued, never a noSend build. */
  const relay = (out: ActionResult, noSend: boolean, full: number[] | undefined) => {
    const ids = txidsToRelay({ ...out, tx: full }, { noSend });
    if (!ids.length) return;
    const jobs = ids.map((txid) => ({ txid, tx: beefFor(txid, out.txid, full) }));
    for (const j of jobs) release(j.txid); // sent: no longer held
    void (async () => {
      for (const j of jobs) {
        if (!j.tx) {
          say(`${j.txid}: sent by the wallet; its BEEF isn't held any more, so no ARC relay`);
          continue;
        }
        await arc({ txid: j.txid, tx: j.tx }).catch(() => undefined);
      }
    })();
  };

  /** Local mode: refuse what touches another site's builds, or builds serve doesn't know (13 Nov 2026 review). */
  const localCheck = (call: string, args: Record<string, unknown>, host: string): string | null => {
    const opts = (args.options ?? {}) as { sendWith?: unknown; noSendChange?: unknown };
    const ref = typeof args.reference === 'string' ? args.reference : undefined;
    if (call === 'signAction') {
      const p = ref ? signRefs.get(ref) : undefined;
      if (!p || p.origin !== host) return 'this signAction reference was not created by this site in this serve session';
    }
    if (call === 'createAction' || call === 'signAction') {
      const bad = strings(opts.sendWith).filter((t) => owners.get(t) !== host);
      if (bad.length)
        return `sendWith names ${bad.join(', ')}, which this site did not build with noSend in this serve session (a build from before a serve restart can't be sent this way: abort it and build again)`;
      const badChange = strings(opts.noSendChange).filter((op) => owners.get(op.split('.')[0]) !== host);
      if (badChange.length) return `noSendChange names ${badChange.join(', ')}, which this site did not build in this serve session`;
    }
    if (call === 'abortAction' && ref) {
      const who = owners.get(ref) ?? signRefs.get(ref)?.origin;
      if (who && who !== host) return 'this action was built by another site';
    }
    return null;
  };

  const isNewTx = (args: Record<string, unknown>) =>
    !!((args.outputs as unknown[] | undefined)?.length || (args.inputs as unknown[] | undefined)?.length) || !strings((args.options as { sendWith?: unknown } | undefined)?.sendWith).length;
  /** Every build is made noSend first, so serve can price it (fee included) before anything leaves; serve then sends it. */
  const forced = (opts: Record<string, unknown>) => ({ ...opts, noSend: true, sendWith: [], returnTXIDOnly: false });
  type Ctx = { committed: boolean };
  type Done = { out: ActionResult & Record<string, unknown>; full?: number[]; fee: number; noSend: boolean } | { refused: string };

  /**
   * Local mode createAction/signAction: build noSend, check the real cost (outputs + network fee) against the fee cap,
   * the per-payment cap, the session budget and the account gate, abort if over, else send it with sendWith
   * (unless the site asked for noSend). A sendWith-only createAction moves no new money (its txids were checked).
   */
  const localAction = async (call: string, args: Record<string, unknown>, host: string, sats: number, usd: number, ctx: Ctx): Promise<Done> => {
    const opts = (args.options ?? {}) as Record<string, unknown>;
    if (call === 'createAction' && !isNewTx(args)) {
      const out = (await w.call(call, args, host)) as ActionResult & Record<string, unknown>;
      return { out, fee: 0, noSend: false };
    }
    const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    let p: Pending;
    let result: ActionResult & Record<string, unknown>;
    const ref = typeof args.reference === 'string' ? args.reference : '';
    if (call === 'createAction') {
      p = {
        origin: host,
        noSend: opts.noSend === true,
        sendWith: strings(opts.sendWith),
        acceptDelayedBroadcast: bool(opts.acceptDelayedBroadcast),
        returnTXIDOnly: opts.returnTXIDOnly === true,
        sats,
        usd,
        description: String(args.description ?? ''),
        inputBEEF: Array.isArray(args.inputBEEF) ? (args.inputBEEF as number[]) : undefined,
      };
      result = (await w.call('createAction', { ...args, options: forced(opts) }, host)) as typeof result;
      const pendingRef = result.signableTransaction?.reference;
      if (typeof pendingRef === 'string') {
        rememberRef(pendingRef, p);
        return { out: result, fee: 0, noSend: true };
      }
    } else {
      const prior = signRefs.get(ref) as Pending;
      p = {
        ...prior,
        noSend: bool(opts.noSend) ?? prior.noSend,
        sendWith: Array.isArray(opts.sendWith) ? strings(opts.sendWith) : prior.sendWith,
        acceptDelayedBroadcast: bool(opts.acceptDelayedBroadcast) ?? prior.acceptDelayedBroadcast,
        returnTXIDOnly: bool(opts.returnTXIDOnly) ?? prior.returnTXIDOnly,
      };
      result = (await w.call('signAction', { ...args, options: forced(opts) }, host)) as typeof result;
      signRefs.delete(ref);
    }

    const txid = typeof result.txid === 'string' ? result.txid : undefined;
    const full = result.tx?.length ? Array.from(result.tx) : undefined;
    const refuse = async (why: string): Promise<Done> => {
      if (txid) await w.call('abortAction', { reference: txid }, host).catch(() => undefined);
      // signAction: the whole action is dropped and the site never got it signed, so its createAction reservation goes back.
      if (call === 'signAction') sessionSpentUsd = Math.max(0, sessionSpentUsd - p.usd);
      return { refused: why };
    };
    let fee: number | undefined;
    try {
      if (!txid || !full) return await refuse('the wallet returned no transaction to check');
      fee = feeOf(full, p.inputBEEF);
      if (fee === undefined) return await refuse("could not work out this payment's network fee, so nothing was sent");
      if (fee > maxFee) return await refuse(`the network fee, ${fee} sats, is over the ${maxFee}-sat fee cap per payment (serve --max-fee-sats)`);
      const rate = await price();
      const feeUsd = (fee / 1e8) * rate;
      const totalUsd = ((p.sats + fee) / 1e8) * rate;
      if (totalUsd > maxPerAction + 1e-9) return await refuse(`$${totalUsd.toFixed(4)} with the network fee is over the $${maxPerAction} per-payment cap for sites`);
      // The outputs are reserved already (this call, or the createAction before a signAction); add the fee.
      if (sessionSpentUsd + feeUsd > budget + 1e-9) return await refuse(`this serve session's $${budget} budget is used ($${sessionSpentUsd.toFixed(4)} spent)`);
      // createAction: nothing logged yet, so the gate sees outputs + fee. signAction: its outputs were logged at createAction.
      const g = gateAction(o.account, { kind: 'send', token: 'BSV', usd: call === 'createAction' ? totalUsd : feeUsd, to: host });
      if (!g.ok) return await refuse(g.reason);
      if (g.paper) return await refuse('paper mode: nothing is signed');
      sessionSpentUsd += feeUsd;
    } catch (e) {
      if (txid) await w.call('abortAction', { reference: txid }, host).catch(() => undefined);
      throw e;
    }
    ctx.committed = true;
    hold(txid, host, full); // until it is sent; a failed send leaves it to this site to retry or abort
    const sw = [...p.sendWith, ...(p.noSend ? [] : [txid])];
    if (sw.length) {
      const sent = (await w.call(
        'createAction',
        {
          description: p.description.length >= 5 ? p.description : 'bwalletx serve: send',
          options: { sendWith: sw, ...(p.acceptDelayedBroadcast !== undefined && { acceptDelayedBroadcast: p.acceptDelayedBroadcast }) },
        },
        host,
      )) as ActionResult & { notDelayedResults?: unknown };
      result.sendWithResults = sent.sendWithResults;
      result.notDelayedResults = sent.notDelayedResults;
    }
    if (!p.noSend) delete result.noSendChange;
    if (p.returnTXIDOnly) delete result.tx;
    return { out: result, full, fee, noSend: p.noSend };
  };

  const send = (res: ServerResponse, status: number, body: unknown, origin?: string) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      ...(origin && { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }),
    });
    res.end(stringifyBRC100(body));
  };

  let port = o.port ?? BRC100_PORT;
  let prompts: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Promise<boolean>>();
  const askOwner = (host: string, code: string) => {
    const r = prompts.then(() => (o.confirmPairing ? o.confirmPairing({ origin: host, code }) : false)).catch(() => false);
    prompts = r;
    return r;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // DNS rebinding: a page on evil.example resolving to 127.0.0.1 sends Host: evil.example.
    const hostHeader = String(req.headers.host ?? '').toLowerCase();
    if (hostHeader !== `localhost:${port}` && hostHeader !== `127.0.0.1:${port}`) {
      say(`refused Host ${hostHeader || '(none)'}: not localhost:${port}`);
      return send(res, 403, refusal('bwalletx serve: bad Host header'));
    }
    const origin = String(req.headers.origin ?? req.headers.originator ?? '');
    const host = hostOf(origin);
    const ok = host && allowed.has(host);
    if (req.method === 'OPTIONS') {
      res.writeHead(ok ? 204 : 403, {
        ...(ok && {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, Originator, Authorization',
          'Access-Control-Allow-Private-Network': 'true',
          Vary: 'Origin',
        }),
      });
      return res.end();
    }
    if (!ok) {
      say(`refused ${host || '(no origin)'}: not on the allowlist`);
      return send(res, 403, refusal(`bwalletx serve: ${host || 'this origin'} is not allowed (start with --origin ${host || '<site>'})`));
    }
    const call = (req.url ?? '').replace(/^\/+/, '').split('?')[0];
    if (call === 'pair' && req.method === 'POST') {
      // One prompt per origin at a time; a second request while one is open is refused, not queued.
      if (pending.has(host)) return send(res, 409, refusal('bwalletx serve: a pairing request for this site is already waiting'), origin);
      const code = comparisonCode(host, randomBytes(16).toString('hex'));
      say(`pairing request from ${host}, code ${code}`);
      const p = askOwner(host, code);
      pending.set(host, p);
      // The site gets the code first (chunked) so it can show it while the owner decides.
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
      res.write(`{"code":${JSON.stringify(code)}`);
      const yes = await p.finally(() => pending.delete(host));
      if (!yes) {
        say(`pairing for ${host} refused`);
        return res.end(',"approved":false}');
      }
      const token = issueToken(host);
      say(`paired ${host}`);
      return res.end(`,"approved":true,"token":${JSON.stringify(token)}}`);
    }
    const authed = checkToken(host, bearerOf(req.headers.authorization));
    if (!authed) {
      if (req.method === 'POST' && UNAUTHENTICATED.has(call)) {
        return send(res, 200, call === 'getVersion' ? { version: serveVersion() } : { authenticated: false }, origin);
      }
      say(`refused ${host} ${call || '(no call)'}: not paired (no valid token)`);
      return send(res, 401, refusal('bwalletx serve: this site is not paired; POST /pair and approve it in the serve terminal'), origin);
    }
    // serve answers for itself, so a client can tell a 0.6.1+ serve from an older one. Paired mode adds the phone's
    // PIN level (`; pin=N;`), which sites read.
    if (call === 'getVersion' && req.method === 'POST') {
      if (!w.paired) return send(res, 200, { version: serveVersion() }, origin);
      const phone = (await w.call('getVersion', {}, host).catch(() => null)) as { version?: unknown } | null;
      return send(res, 200, { version: pairedVersion(phone?.version) }, origin);
    }
    if (req.method !== 'POST' || !ALLOWED.has(call) || NEVER_FORWARD.has(call) || (w.paired && !PAIRED_FORWARD.has(call))) return send(res, 400, refusal(`bwalletx serve: ${call || 'this call'} is not offered`), origin);

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 64 * 1024 * 1024) return send(res, 413, refusal('Request too large'), origin);
      chunks.push(c as Buffer);
    }
    let args: Record<string, unknown>;
    try {
      args = normalizeBRC100WalletByteFields(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) as Record<string, unknown>;
    } catch {
      return send(res, 400, refusal('bwalletx serve: bad JSON'), origin);
    }
    if (w.paired && args && typeof args === 'object' && args.privileged === true) {
      say(`refused ${host} ${call}: privileged calls are never forwarded`);
      return send(res, 400, refusal('bwalletx serve: privileged calls are not offered'), origin);
    }

    // createAction/signAction: gate → sign → log under the account's spend lock, so parallel requests
    // (or another process on the same account) can't all pass the daily cap before any is logged.
    const spends = call === 'createAction' || call === 'signAction';
    return spends ? withSpendLock(o.account, () => runAndRefund(res, call, args, host, origin)) : run(res, call, args, host, origin, { committed: false });
  };

  const run = async (res: ServerResponse, call: string, args: Record<string, unknown>, host: string, origin: string, ctx: Ctx) => {
    let sats = 0;
    let reservedUsd = 0;
    if (!w.paired) {
      const why = localCheck(call, args, host);
      if (why) {
        say(`REFUSED ${host} ${call}: ${why}`);
        return send(res, 400, refusal(`bWalletX agent refused: ${why}`), origin);
      }
    }
    if (isAuthProtocolCall(call, args) && !singleSite) {
      say(`refused ${host} ${call}: login signatures need serve to allow exactly one site`);
      return send(res, 400, refusal('bwalletx serve: login (BRC-103) signatures are only made when one site is allowed; restart with a single --origin'), origin);
    }
    if (call === 'createAction') {
      const a = args as unknown as CreateActionArgs;
      const owned = a.inputs?.length && w.owned ? await w.owned().catch(() => null) : new Set<string>();
      if (!owned) return send(res, 503, refusal('bwalletx serve: could not read the wallet to check inputs; try again'), origin);
      if (!o.allowTokenTransfers) {
        const mine = namedOwnedInputs(a, owned);
        if (hasTokenOutputs(a) || mine.length) {
          say(`REFUSED ${host} createAction: moves tokens/ordinals (${mine.length ? `spends wallet outputs ${mine.join(', ')}` : 'BSV-21 inscribed output'}), which the USD caps cannot value`);
          return send(res, 400, refusal('bWalletX agent refused: this payment moves tokens or ordinals, which the spending caps cannot value; restart serve with --allow-token-transfers to permit it'), origin);
        }
      }
      sats = outgoingSats(a, owned);
      const usd = sats ? (sats / 1e8) * (await price()) : 0;
      if (usd > maxPerAction + 1e-9) {
        say(`REFUSED ${host} createAction (${sats} sats, $${usd.toFixed(2)}): over the $${maxPerAction} per-payment cap`);
        return send(res, 400, refusal(`bWalletX agent refused: $${usd.toFixed(2)} is over the $${maxPerAction} per-payment cap for sites`), origin);
      }
      if (sessionSpentUsd + usd > budget + 1e-9) {
        say(`REFUSED ${host} createAction (${sats} sats): session budget $${budget} used`);
        return send(res, 400, refusal(`bWalletX agent refused: this serve session's $${budget} budget is used ($${sessionSpentUsd.toFixed(2)} spent)`), origin);
      }
      const g = gateAction(o.account, { kind: 'send', token: 'BSV', usd, to: host });
      if (!g.ok) {
        say(`REFUSED ${host} createAction (${sats} sats): ${g.reason}`);
        return send(res, 400, refusal(`bWalletX agent refused: ${g.reason}`), origin);
      }
      if (g.paper) return send(res, 400, refusal('bWalletX agent is in paper mode: nothing is signed'), origin);
      sessionSpentUsd += usd; // reserved under the spend lock; a failed sign below gives it back
      reservedUsd = usd;
    }

    const acts = call === 'createAction' || call === 'signAction';
    try {
      let out: unknown;
      let fee = 0;
      let noSend = acts && (args.options as { noSend?: unknown } | undefined)?.noSend === true;
      if (!w.paired && acts) {
        const d = await localAction(call, args, host, sats, reservedUsd, ctx);
        if ('refused' in d) {
          say(`REFUSED ${host} ${call}: ${d.refused}`);
          return send(res, 400, refusal(`bWalletX agent refused: ${d.refused}`), origin);
        }
        out = d.out;
        fee = d.fee;
        noSend = d.noSend;
        // The phone broadcasts what it signs; only the CLI's own wallet needs the ARC nudge (never a noSend build).
        relay(d.out, d.noSend, d.full);
      } else {
        out = await w.call(call, args, host);
      }
      if (!w.paired && call === 'abortAction' && typeof args.reference === 'string') {
        release(args.reference);
        signRefs.delete(args.reference);
      }
      if (LOGGED.has(call)) {
        const a = args as { description?: string };
        const r = out as { txid?: string };
        const spent = sats + fee;
        const usd = spent ? (spent / 1e8) * (await price().catch(() => 0)) : 0;
        const tag = noSend && r?.txid ? ' (noSend: built, not sent)' : '';
        appendLog(o.account, {
          at: Date.now(),
          // A fee-only action is still a spend: it counts toward the rate limit and the daily cap.
          action: acts && spent ? 'send' : call === 'createAction' ? 'sign' : `brc100-${call}`,
          detail: `${host}: ${call}${a.description ? ` "${a.description}"` : ''}${r?.txid ? ` ${r.txid}` : ''}${sats ? ` (${sats} sats)` : ''}${fee ? ` (fee ${fee} sats)` : ''}${tag}`,
          usd,
        });
        say(`${host} ${call}${a.description ? `: ${a.description}` : ''}${r?.txid ? ` → ${r.txid}` : ''}${tag}`);
      }
      send(res, 200, out ?? {}, origin);
    } catch (e) {
      const err = e as { code?: number; message?: string; name?: string } & Record<string, unknown>;
      say(`${host} ${call} failed: ${err.message ?? String(e)}`);
      if (err.name === 'WalletUnreachable') return send(res, 503, refusal(`bWalletX: ${err.message}`), origin);
      if (err.name === 'WERR_INSUFFICIENT_FUNDS') return send(res, 400, { isError: true, code: 7, totalSatoshisNeeded: err.totalSatoshisNeeded, moreSatoshisNeeded: err.moreSatoshisNeeded }, origin);
      send(res, 400, refusal(err.message ?? String(e)), origin);
    }
  };
  const runAndRefund = async (res: ServerResponse, call: string, args: Record<string, unknown>, host: string, origin: string) => {
    const before = sessionSpentUsd;
    const ctx: Ctx = { committed: false };
    await run(res, call, args, host, origin, ctx);
    // Refund only what was never signed and sent: once a build passed every check and was handed on, it stays counted.
    if (res.statusCode !== 200 && !ctx.committed && sessionSpentUsd > before) sessionSpentUsd = before;
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, refusal(e instanceof Error ? e.message : String(e))));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? BRC100_PORT, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (addr && typeof addr === 'object') port = addr.port;
  return server;
}

export type { WalletInterface };
