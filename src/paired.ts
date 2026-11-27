/**
 * Paired mode: the CLI pairs with bWalletX on a phone like a website does (src/pair/protocol.ts, shared
 * with the app), but as origin CLI_ORIGIN, which the app treats as "a program on a computer" and binds
 * to ONE agent account with scopes and an expiry (≤30 days). Keys never leave the phone: every call is
 * an end-to-end encrypted request through the relay, checked and signed by the app.
 *
 * Stored per pairing: ~/.bwalletx/paired/<name>.json (mode 600) — the pairing key (not a wallet key),
 * the phone's pairing public key, the channel and the message counters.
 */
import { PrivateKey } from '@bsv/sdk';
import QRCode from 'qrcode';
import { terminalQr, yellow, type QrStyle } from './brand.js';
import WebSocket from 'ws';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  CLAIM_FORMAT,
  DEFAULT_RELAY,
  PAIR_VERSION,
  QR_LIFETIME_S,
  Sealer,
  claimDigest,
  deriveSession,
  isSealed,
  newChannel,
  newClaim,
  pairUrl,
  compactPairCode,
  relaySocketUrl,
  sessionWalletClaim,
  walletClaimFor,
  type HelloFrame,
  type PairMessage,
  type RelayFrame,
} from './pair/protocol.js';
import { inOrder } from './pair/in-order.js';
import { DEFAULT_DAILY_CAP_USD, home, readConfig, readJsonFile, writeConfig, writeJsonFile } from './store.js';

export const CLI_ORIGIN = 'https://cli.bwalletx.com';
const CALL_TIMEOUT_MS = 75_000;

export type Pairing = {
  format: 'bwalletx.pairing/1';
  name: string;
  c: string;
  r: string;
  s: string; // pairing key (hex): NOT a wallet key
  k: string; // the phone's pairing public key
  sent: number;
  lastSeen: number;
  account: string;
  identityAddress: string;
  scopes: string[];
  expiresAt: number;
  pairedAt: number;
  /** Set when the pairing includes "Mint NFTs": the limits chosen on the phone. */
  mint?: MintInfo | null;
  /** 'brc100': a "main wallet" pairing (`bwalletx pair --main`) that `serve --wallet paired` forwards BRC-100 calls over. */
  mode?: 'agent' | 'brc100';
  /** The limits the phone set for a brc100 pairing (informational: the phone enforces them). */
  caps?: Brc100Caps | null;
  /** Our relay site claim, sent on every connect. Pairings saved before it get one on their next connect. */
  sc?: string;
  /** 2: the relay binds the phone's role to the pairing's session claim (wallet claim v2); we re-bind it on connect. */
  wv?: 2;
};
export type Brc100Caps = { dailyUsd?: number; perCallUsd?: number; origins?: string[] };
export type LoginOptions = {
  mode?: 'agent' | 'brc100';
  /**
   * Required. Ask whether the phone shows the same code; true only on a yes. Nothing is saved until the phone's Pair
   * AND a yes; a no tells the phone to unpair. Whoever joins the QR's channel first gets it, so a stranger who used
   * the QR first shows a different code (and the user's phone says the code was already used).
   */
  confirmCode: (code: string) => Promise<boolean>;
  /** Relay host. Default relay.bwallet.space (tests use a local one). */
  relay?: string;
  /** Also open the QR as an image (macOS Preview / the desktop's viewer), for terminals whose fonts break the text QR. */
  openQr?: boolean;
  /** QR the full pairing link instead of the compact code (wallets older than 5.2.56 read only the full link). */
  fullQr?: boolean;
  /** How to draw the terminal QR (brand.ts terminalQr). Default: solid in VS Code, small elsewhere. */
  qrStyle?: QrStyle;
};
export type MintInfo = { maxItems: number; maxUsd: number; itemsUsed: number; spentUsd: number; itemsLeft: number; usdLeft: number };

const file = (name: string) => join(home(), 'paired', `${name}.json`);
export const readPairing = (name: string) => readJsonFile<Pairing>(file(name));
const savePairing = (p: Pairing) => writeJsonFile(file(p.name), p, 0o600);
export const isPaired = (name: string) => existsSync(file(name));

/** A relay frame as JSON, or null when it isn't (never throws: the relay is not trusted). */
export const parseFrame = (raw: unknown): unknown => {
  try {
    const f = JSON.parse(String(raw)) as unknown;
    return f && typeof f === 'object' ? f : null;
  } catch {
    return null;
  }
};

const open = (url: string) => new WebSocket(url, { headers: { Origin: CLI_ORIGIN }, handshakeTimeout: 10_000 });

/**
 * The site socket URL for a saved pairing. Always carries our site claim (one is created and saved for pairings from
 * before claims), and a wallet binding: the session claim digest for a v2 pairing, the QR-bound claim's digest for a
 * v1 one, so a channel the relay re-creates admits only the paired phone. Exported for tests.
 */
export function pairedSiteUrl(p: Pairing, expiry: number, save: (p: Pairing) => void = savePairing): string {
  if (!p.sc || !CLAIM_FORMAT.test(p.sc)) {
    p.sc = newClaim();
    save(p);
  }
  // A v1 pairing sends the QR-bound claim's digest (review 13 Nov 2026): a channel the relay re-creates is then bound to
  // it, so someone who knows only the channel ID can't take the phone's role; the phone rejoins with it and upgrades.
  const key = PrivateKey.fromHex(p.s);
  const wc =
    p.wv === 2
      ? claimDigest(sessionWalletClaim(key, p.k, p.c))
      : claimDigest(walletClaimFor(p.c, key.toPublicKey().toString()));
  return relaySocketUrl(p.r, p.c, 'site', expiry, p.sc, wc);
}

/**
 * A sealed `ready` naming the phone's session claim (`wcv: 2`, `nc` = its digest) on a pairing not yet v2. True only
 * when `nc` matches the claim we derive from our key and the phone's; we then re-bind the phone's role to it on our
 * next connect (pairedSiteUrl), which is how a pairing that started as v1 upgrades. Exported for tests.
 */
export const learnsWalletClaimV2 = (p: Pick<Pairing, 'wv' | 's' | 'k' | 'c'>, msg: PairMessage) =>
  msg.t === 'ready' &&
  msg.wcv === 2 &&
  p.wv !== 2 &&
  typeof msg.nc === 'string' &&
  msg.nc === claimDigest(sessionWalletClaim(PrivateKey.fromHex(p.s), p.k, p.c));

/** The site socket URL for a new pairing: our site claim, and the digest of the claim only the QR gives (`wc`). */
export function newChannelUrl(relay: string, c: string, sitePub: string, expiry: number, sc: string): string {
  return relaySocketUrl(relay, c, 'site', expiry, sc, claimDigest(walletClaimFor(c, sitePub)));
}

/** The pairing QR as a PNG in the bwalletx home, opened in the system viewer. Best effort: the text QR and link stay. */
async function showQrImage(link: string, out: (s: string) => void) {
  try {
    const file = join(home(), 'pair-qr.png');
    await QRCode.toFile(file, link, { width: 560, margin: 4, errorCorrectionLevel: 'L' });
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(opener, [file], { stdio: 'ignore', detached: true }).unref();
    out(`QR image: ${file} (opened; scan that if the one above won't read)`);
  } catch (e) {
    out(`Couldn't open the QR image: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** `bwalletx login`: show a QR, wait for the phone, save the pairing as account `name`. */
export async function login(name: string, opts: LoginOptions, out: (s: string) => void = console.log): Promise<Pairing> {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name) || name.startsWith('.')) throw new Error(`Bad account name "${name}"`);
  // The code check is what stops someone who saw the QR first, so a pairing never finishes on the phone's Pair alone.
  if (typeof opts?.confirmCode !== 'function')
    throw new Error('login needs opts.confirmCode: ask whether the phone shows the same code');
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const r = await round(name, opts.mode ?? 'agent', out, opts.confirmCode, opts.relay ?? DEFAULT_RELAY, opts.openQr, opts.fullQr, opts.qrStyle);
    if (r) return r;
    out('\nThe code expired; here is a new one.\n');
  }
  throw new Error('Pairing timed out. Run `bwalletx login` again.');
}

function round(name: string, mode: 'agent' | 'brc100', out: (s: string) => void, confirmCode: LoginOptions['confirmCode'] | undefined, relay: string, openQr = false, fullQr = false, qrStyle?: QrStyle): Promise<Pairing | null> {
  const S = PrivateKey.fromRandom();
  const c = newChannel();
  const e = Math.floor(Date.now() / 1000) + QR_LIFETIME_S;
  const link = pairUrl({ v: PAIR_VERSION, r: relay, c, k: S.toPublicKey().toString(), o: CLI_ORIGIN, e });
  const sc = newClaim();
  return new Promise((resolve, reject) => {
    const ws = open(newChannelUrl(relay, c, S.toPublicKey().toString(), e, sc));
    let sealer: Sealer | null = null;
    let phoneKey = '';
    let v2 = false;
    let infoId = '';
    let answer: Promise<boolean> | null = null; // the user's reply to confirmCode
    let done = false;
    const timer = setTimeout(() => !sealer && (ws.close(), resolve(null)), QR_LIFETIME_S * 1000 - 5000);
    ws.on('open', async () => {
      // The compact code implies the default relay, so a test relay gets the full link.
      const qr = fullQr || relay !== DEFAULT_RELAY ? link : compactPairCode(c, S.toPublicKey().toString());
      out(terminalQr(QRCode.create(qr, { errorCorrectionLevel: 'L' }).modules, qrStyle));
      if (openQr) await showQrImage(qr, out);
      out(
        yellow(
          mode === 'brc100'
            ? 'In bWalletX: open your MAIN account, then Settings › Paired websites › Scan to connect (choose caps, sites and expiry)'
            : 'In bWalletX: open the account to use (an AGENT account, or any account for minting only), then ☰ menu › Connect CLI & MCP › Scan',
        ),
      );
      out(`Or open this link on the phone:\n${link}\n`);
    });
    ws.on('error', (err) => !sealer && (clearTimeout(timer), reject(new Error(`Pairing service unreachable: ${err.message}`))));
    // In order: the phone's ready can arrive while hello is still deriving the key.
    ws.on('message', inOrder(async (raw: unknown) => {
      // A bad frame from the relay must not crash the CLI (an unhandled rejection ends the process).
      const f = parseFrame(raw);
      if (!f) return;
      if ((f as HelloFrame).t === 'hello' && !sealer) {
        if (!/^0[23][0-9a-f]{64}$/i.test(String((f as HelloFrame).k))) return;
        clearTimeout(timer);
        phoneKey = (f as HelloFrame).k;
        v2 = (f as HelloFrame).wcv === 2;
        const { key, code } = await deriveSession(S, phoneKey, c);
        sealer = new Sealer(key, 'site');
        if (!confirmCode) {
          out(`Check your phone shows the code  ${code}  then choose what the CLI may do and tap Pair.`);
          return;
        }
        out(`The code is  ${code}`);
        const ask = confirmCode;
        answer = new Promise<boolean>((r) => r(ask(code))).catch(() => false);
        void answer.then(async (ok) => {
          if (ok || done || !sealer) return;
          done = true;
          await sealer.seal({ t: 'close', reason: 'codes did not match' }).then((fr) => ws.send(JSON.stringify(fr))).catch(() => {});
          ws.close();
          reject(new Error("The codes didn't match, so nothing was paired. Run the command again for a new code."));
        });
        if (!(await answer)) return;
        out('Code confirmed. Now tap Yes, pair on your phone (choose what the CLI may do first)…');
        return;
      }
      if (!sealer || !isSealed(f)) return;
      const msg = await sealer.open(f);
      if (!msg) return;
      if (msg.t === 'ready') {
        if (answer && !(await answer)) return; // a no unpairs the phone and rejects (above)
        if (done) return;
        // The phone's ready names its session claim (wallet claim v2) even when the relay didn't bind it yet.
        if (!v2 && learnsWalletClaimV2({ s: S.toHex(), k: phoneKey, c }, msg)) v2 = true;
        infoId = `info-${Date.now()}`;
        ws.send(JSON.stringify(await sealer.seal({ t: 'req', id: infoId, action: 'info', params: mode === 'brc100' ? { mode } : {} })));
      } else if (msg.t === 'res' && infoId && msg.id === infoId) {
        // Only the answer to our own info request, sent after ready (and after a yes, when asked).
        if (done || (answer && !(await answer))) return;
        if (msg.error) return (ws.close(), reject(new Error(msg.error.message)));
        const i = msg.result as { account: string; identityAddress: string; scopes: string[]; expiresAt: number; mint?: MintInfo | null; caps?: Brc100Caps | null; mode?: string };
        if (mode === 'brc100' && i.mode !== 'brc100') return (ws.close(), reject(new Error('This bWalletX version does not support main-wallet pairing yet (no brc100 mode in its answer).')));
        const p: Pairing = {
          format: 'bwalletx.pairing/1',
          name,
          c,
          r: relay,
          s: S.toHex(),
          k: phoneKey,
          ...sealer.counters,
          account: i.account,
          identityAddress: i.identityAddress,
          scopes: i.scopes,
          expiresAt: i.expiresAt,
          pairedAt: Date.now(),
          mint: i.mint ?? null,
          mode,
          ...(mode === 'brc100' && { caps: i.caps ?? null }),
          sc,
          ...(v2 && { wv: 2 as const }),
        };
        done = true;
        savePairing(p);
        const cfg = readConfig();
        cfg.accounts[name] = {
          name,
          kind: 'paired',
          identityAddress: i.identityAddress,
          payAddress: '',
          ordAddress: '',
          dailyCapUsd: cfg.accounts[name]?.dailyCapUsd !== undefined ? cfg.accounts[name].dailyCapUsd : DEFAULT_DAILY_CAP_USD,
          stopped: false,
          importedAt: Date.now(),
        };
        if (!cfg.defaultAccount) cfg.defaultAccount = name;
        writeConfig(cfg);
        ws.close();
        resolve(p);
      } else if (msg.t === 'close') {
        ws.close();
        reject(new Error('Cancelled on the phone.'));
      }
    }));
  });
}

/**
 * The relay allows 60 frames a minute per channel (both directions) and 4 MB per frame. A request and
 * its answer are two frames, so requests are spaced at least this far apart.
 */
export const MIN_REQUEST_GAP_MS = 2_200;

/**
 * One open connection to the phone for many requests (minting a batch). The app must be open (and
 * unlocked) on the paired account. Counters are saved after every frame, so a crash can't replay.
 */
export class PhoneSession {
  private ws!: WebSocket;
  private sealer!: Sealer;
  private p!: Pairing;
  private waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private lastSend = 0;
  private closed = false;
  private constructor(private name: string) {}

  static async open(name: string): Promise<PhoneSession> {
    const s = new PhoneSession(name);
    await s.connect();
    return s;
  }

  get isOpen() {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  get pairing() {
    return this.p;
  }

  private async connect() {
    const p = readPairing(this.name);
    if (!p) throw new Error(`"${this.name}" isn't a paired account`);
    if (Date.now() > p.expiresAt) throw new Error(`The pairing for ${this.name} expired. Run \`bwalletx login --account ${this.name}\` again.`);
    this.p = p;
    const { key } = await deriveSession(PrivateKey.fromHex(p.s), p.k, p.c);
    this.sealer = new Sealer(key, 'site');
    this.sealer.restore({ sent: p.sent, lastSeen: p.lastSeen });
    // A fresh expiry lets the relay recreate the channel if it was dropped; the phone rejoins on its own.
    this.ws = open(pairedSiteUrl(p, Math.floor(Date.now() / 1000) + QR_LIFETIME_S - 10));
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (e) => reject(new Error(`Pairing service unreachable: ${e.message}`)));
    });
    this.ws.on('message', inOrder((raw: unknown) => this.onFrame(String(raw))));
    this.ws.on('close', () => ((this.closed = true), this.failAll(new Error('Connection to the pairing service closed.'))));
  }

  private persist() {
    savePairing({ ...readPairing(this.name)!, ...this.sealer.counters });
  }

  private failAll(e: Error) {
    for (const [, w] of this.waiting) (clearTimeout(w.timer), w.reject(e));
    this.waiting.clear();
  }

  private async onFrame(raw: string) {
    const f = parseFrame(raw);
    if (!f) return;
    if ((f as { t?: string; error?: string }).t === 'relay' && (f as { error?: string }).error)
      return this.failAll(new Error(`Pairing service: ${(f as { error: string }).error}`));
    if (!isSealed(f)) return;
    const msg = await this.sealer.open(f);
    if (!msg) return;
    this.persist();
    if (learnsWalletClaimV2(this.p, msg)) {
      this.p = { ...this.p, wv: 2 };
      savePairing({ ...readPairing(this.name)!, ...this.sealer.counters, wv: 2 });
    }
    if (msg.t === 'res') {
      const w = this.waiting.get(msg.id);
      if (!w) return;
      clearTimeout(w.timer);
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else w.resolve(msg.result);
    } else if (msg.t === 'close') {
      forgetPairing(this.name);
      this.failAll(new Error('Disconnected on the phone. Run `bwalletx login` to pair again.'));
    }
  }

  async call<T = unknown>(action: string, params: unknown = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    if (this.closed) throw new Error('Session closed');
    const wait = this.lastSend + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastSend = Date.now();
    const id = `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`No answer from your phone. Open bWalletX on "${this.p.account}" (unlocked) and try again.`));
      }, timeoutMs);
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
    this.ws.send(JSON.stringify(await this.sealer.seal({ t: 'req', id, action, params } satisfies PairMessage)));
    this.persist();
    return result;
  }

  close() {
    this.closed = true;
    this.ws.close();
  }
}

/** One request to the phone. The app must be open (and unlocked) on the paired account. */
export async function callPhone<T = unknown>(name: string, action: string, params: unknown = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  const s = await PhoneSession.open(name);
  try {
    return await s.call<T>(action, params, timeoutMs);
  } finally {
    s.close();
  }
}

export { CALL_TIMEOUT_MS };

/**
 * One BRC-100 call forwarded to the paired main wallet, inside the usual {action, params} envelope.
 * The phone checks the grant, origin, method and caps, prompts as needed, and signs/broadcasts itself.
 * Pass `session` to reuse one connection (serve does: concurrent sessions would reuse counters).
 */
export async function callBrc100<T = unknown>(
  name: string,
  method: string,
  args: unknown,
  site: string,
  o: { session?: PhoneSession; timeoutMs?: number } = {},
): Promise<T> {
  const params = { method, args, site };
  if (o.session) return o.session.call<T>('brc100', params, o.timeoutMs ?? CALL_TIMEOUT_MS);
  return callPhone<T>(name, 'brc100', params, o.timeoutMs ?? CALL_TIMEOUT_MS);
}

/**
 * `bwalletx ping`: is the pairing service reachable, is the phone on the channel, does it answer? Sends one sealed
 * ping (counters saved like any request) and reports each step, so "No answer from your phone" can be traced.
 */
export async function pingPhone(name: string, out: (s: string) => void = console.log, timeoutMs = 15_000): Promise<boolean> {
  const p = readPairing(name);
  if (!p) throw new Error(`"${name}" isn't a paired account`);
  out(`Pairing "${name}": phone account "${p.account}", relay ${p.r}, channel ${p.c.slice(0, 6)}…, expires ${new Date(p.expiresAt).toISOString().slice(0, 10)}`);
  if (Date.now() > p.expiresAt) return (out('The pairing expired. Pair again.'), false);
  const { key } = await deriveSession(PrivateKey.fromHex(p.s), p.k, p.c);
  const sealer = new Sealer(key, 'site');
  sealer.restore({ sent: p.sent, lastSeen: p.lastSeen });
  const ws = open(pairedSiteUrl(p, Math.floor(Date.now() / 1000) + QR_LIFETIME_S - 10));
  return new Promise<boolean>((resolve) => {
    let answered = false;
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      ws.close();
      resolve(ok);
    };
    const timer = setTimeout(() => {
      out(`No answer from the phone in ${timeoutMs / 1000}s. bWalletX on "${p.account}" isn't connected to this pairing.`);
      finish(false);
    }, timeoutMs);
    ws.on('unexpected-response', (_req, res) => {
      out(`Pairing service refused the connection: HTTP ${res.statusCode} ${res.statusMessage ?? ''}`.trim());
      finish(false);
    });
    ws.on('error', (e) => (out(`Pairing service unreachable: ${e.message}`), finish(false)));
    ws.on('close', (code, reason) => !answered && out(`Pairing service closed the connection (${code}${reason.length ? ` ${reason}` : ''}).`));
    ws.on('open', async () => {
      out('Pairing service: connected. Asking the phone…');
      ws.send(JSON.stringify(await sealer.seal({ t: 'ping' })));
      savePairing({ ...readPairing(name)!, ...sealer.counters });
    });
    ws.on('message', inOrder(async (raw: unknown) => {
      const f = parseFrame(String(raw));
      if (!f) return;
      const rf = f as RelayFrame;
      if (rf.t === 'relay') {
        if (rf.peer) out(`Pairing service: the phone ${rf.peer === 'joined' ? 'joined' : 'left'} the channel.`);
        if (rf.error) out(`Pairing service: ${rf.error}`);
        return;
      }
      if (!isSealed(f)) return;
      const msg = await sealer.open(f);
      if (!msg) return out('A frame arrived that this pairing could not open (wrong key or replayed).');
      savePairing({ ...readPairing(name)!, ...sealer.counters });
      answered = true;
      out(`The phone answered (${msg.t}). Paired and online.`);
      finish(true);
    }));
  });
}

/** Forget a pairing here (and tell the phone, best effort). */
export async function unpair(name: string) {
  const p = readPairing(name);
  if (!p) throw new Error(`"${name}" isn't a paired account`);
  try {
    const { key } = await deriveSession(PrivateKey.fromHex(p.s), p.k, p.c);
    const sealer = new Sealer(key, 'site');
    sealer.restore({ sent: p.sent, lastSeen: p.lastSeen });
    const ws = open(pairedSiteUrl(p, Math.floor(Date.now() / 1000) + 100));
    await new Promise<void>((res) => {
      ws.on('open', async () => (ws.send(JSON.stringify(await sealer.seal({ t: 'close', reason: 'cli logout' }))), setTimeout(res, 500)));
      ws.on('error', () => res());
      setTimeout(res, 5000);
    });
    ws.close();
  } catch {
    /* the phone forgets it when the pairing expires anyway */
  }
  forgetPairing(name);
}

function forgetPairing(name: string) {
  rmSync(file(name), { force: true });
  const cfg = readConfig();
  delete cfg.accounts[name];
  if (cfg.defaultAccount === name) delete cfg.defaultAccount;
  writeConfig(cfg);
}
