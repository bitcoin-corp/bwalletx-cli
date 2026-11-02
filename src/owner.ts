/**
 * Owner PIN and owner-signed settings (0.6.0, after the 2 Nov 2026 COO audit).
 *
 * The problem: `cap`, `ratelimit`, `approve-above`, `resume`, `strategy load --live` and `key import` were only
 * kept off MCP. An agent with a shell (Claude Code, a script) could run `bwalletx cap <acct> off`, or edit
 * ~/.bwalletx/config.json, and the MCP passphrase sits in the MCP client's config, so asking for it proves nothing.
 *
 * The fix, in this file (pure state + crypto; the prompts live in ownerGate.ts):
 *   - owner.json holds an scrypt verifier for a separate OWNER PIN and an Ed25519 public key. The private key is
 *     derived from the PIN (scrypt, random salt) and exists only in memory while a human is typing it.
 *   - owner-settings.json holds the safety ceilings (caps, rate limits, approve-above, stop flags, which live
 *     strategy is approved), signed with that key. The gate checks the signature with the public key, so it
 *     needs no PIN at spend time, and nobody without the PIN can produce a valid one.
 *   - The gate uses the TIGHTER of the signed value and config.json. So tightening (lowering a cap, stopping)
 *     works from anywhere with no PIN, and editing config.json can never loosen past what the owner signed.
 *   - A missing or bad signature counts as the most restrictive state: all stopped, default caps, no live
 *     strategies. `bwalletx stop` deliberately breaks the signature, so deleting the STOP file resumes nothing.
 *   - No owner.json yet (an upgrade from 0.5.x): "unset" mode. Settings are clamped to the defaults
 *     ($10/day, 30 actions/hour, strategies paper-only) until the human sets a PIN at a terminal.
 *
 * (The brief asked for an HMAC keyed from the PIN. An HMAC can only be checked by someone holding the key, and
 * the gate runs unattended without the PIN, so a PIN-derived signature key does the same job and can be checked.)
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, scryptSync, sign as edSign, timingSafeEqual, verify as edVerify, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DAILY_CAP_USD, home, RATE_LIMIT_PER_HOUR } from './limits.js';
import type { Loaded } from './strategy.js';

export const OWNER_FORMAT = 'bwalletx.owner/1';
export const SETTINGS_FORMAT = 'bwalletx.owner-settings/1';
export const PIN_MIN_LENGTH = 8;
/** ~0.2 s and 64 MiB per try on a laptop. Stored in owner.json, so it can be raised later. */
export const SCRYPT_DEFAULT = { N: 2 ** 16, r: 8, p: 1 };
const SCRYPT_N_MIN = 2 ** 10;
const SCRYPT_N_MAX = 2 ** 20;
const SIGN_DOMAIN = 'bwalletx-owner-settings/1\n';
const VERIFY_DOMAIN = 'bwalletx-owner-verify/1';
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export type ScryptParams = { N: number; r: number; p: number };
export type OwnerFile = {
  format: typeof OWNER_FORMAT;
  kdf: { alg: 'scrypt'; N: number; r: number; p: number; salt: string };
  verifier: string;
  publicKey: string;
  createdAt: number;
};
export type SignedAccount = {
  dailyCapUsd: number | null;
  ratePerHour: number | null;
  approveAboveUsd: number | null;
  stopped: boolean;
  /** sha256 of the canonical Loaded strategy file the owner approved to run live; null = paper only. */
  liveStrategy: string | null;
};
export type SettingsBody = {
  format: typeof SETTINGS_FORMAT;
  publicKey: string;
  seq: number;
  signedAt: number;
  stopAll: boolean;
  accounts: Record<string, SignedAccount>;
};
export type SettingsFile = SettingsBody & {
  sig: string | null;
  /** Set by `stop`: the signature is removed so the file reads as stopped until the owner re-signs. */
  broken?: { at: number; by: string; prevSigHash: string; prevStopAll: boolean };
};
export type OwnerState =
  | { state: 'unset' }
  | { state: 'ok'; owner: OwnerFile; settings: SettingsFile }
  | { state: 'tampered'; why: string; owner: OwnerFile | null; settings: SettingsFile | null };

export const ownerPath = () => join(home(), 'owner.json');
export const settingsPath = () => join(home(), 'owner-settings.json');

// ---- small helpers ----
const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const isHex = (s: unknown, len?: number): s is string => typeof s === 'string' && /^[0-9a-f]+$/.test(s) && (len === undefined || s.length === len);
const isNumOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

/** JSON with sorted keys at every level, so the signed bytes don't depend on key order. */
export const canonical = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
};

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const writeAtomic = (file: string, v: unknown) => {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
};

// ---- keys ----
const privateFromSeed = (seed: Buffer): KeyObject => createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
const rawPublicHex = (k: KeyObject) => Buffer.from(String((createPublicKey(k).export({ format: 'jwk' }) as { x: string }).x), 'base64url').toString('hex');
const publicFromHex = (hex: string): KeyObject => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') }, format: 'jwk' });

function derive(pin: string, kdf: OwnerFile['kdf']) {
  const dk = scryptSync(pin.normalize('NFC'), Buffer.from(kdf.salt, 'hex'), 64, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
  try {
    const verifier = sha256hex(Buffer.concat([Buffer.from(VERIFY_DOMAIN), dk.subarray(0, 32)]));
    const priv = privateFromSeed(Buffer.from(dk.subarray(32, 64)));
    return { verifier, priv, publicKey: rawPublicHex(priv) };
  } finally {
    dk.fill(0);
  }
}

/** PIN rules: long enough to make an offline scrypt guess slow. Callers also refuse the wallet passphrase. */
export const pinProblem = (pin: string): string | null =>
  pin.length < PIN_MIN_LENGTH ? `The owner PIN needs at least ${PIN_MIN_LENGTH} characters (a short passphrase is best)` : null;

/** A fresh owner key from a new PIN. Nothing is written; the caller saves `file`. */
export function createOwner(pin: string, params: ScryptParams = SCRYPT_DEFAULT, now = Date.now()) {
  const bad = pinProblem(pin);
  if (bad) throw new Error(bad);
  const kdf = { alg: 'scrypt' as const, ...params, salt: randomBytes(16).toString('hex') };
  const d = derive(pin, kdf);
  const file: OwnerFile = { format: OWNER_FORMAT, kdf, verifier: d.verifier, publicKey: d.publicKey, createdAt: now };
  return { file, priv: d.priv };
}

/** The owner key for a PIN, or null when the PIN is wrong. Constant-time compare. */
export function unlockOwner(pin: string, file: OwnerFile): { priv: KeyObject; publicKey: string } | null {
  const d = derive(pin, file.kdf);
  const a = Buffer.from(d.verifier, 'hex');
  const b = Buffer.from(file.verifier, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b) || d.publicKey !== file.publicKey) return null;
  return { priv: d.priv, publicKey: d.publicKey };
}

export const writeOwnerFile = (f: OwnerFile) => writeAtomic(ownerPath(), f);

const validOwner = (v: unknown): OwnerFile | null => {
  const o = v as OwnerFile | null;
  if (!o || o.format !== OWNER_FORMAT || !o.kdf || o.kdf.alg !== 'scrypt') return null;
  const { N, r, p, salt } = o.kdf;
  if (!Number.isInteger(N) || N < SCRYPT_N_MIN || N > SCRYPT_N_MAX || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  if (!isHex(salt, 32) || !isHex(o.verifier, 64) || !isHex(o.publicKey, 64)) return null;
  return o;
};
export const readOwnerFile = (): OwnerFile | null => validOwner(readJson(ownerPath()));

// ---- signed settings ----
export const bodyOf = (s: SettingsBody): SettingsBody => ({
  format: s.format,
  publicKey: s.publicKey,
  seq: s.seq,
  signedAt: s.signedAt,
  stopAll: s.stopAll,
  accounts: s.accounts,
});
export const signBody = (body: SettingsBody, priv: KeyObject) => edSign(null, Buffer.from(SIGN_DOMAIN + canonical(bodyOf(body))), priv).toString('hex');
const verifyBody = (body: SettingsBody, sig: string, publicKey: string) => {
  try {
    return edVerify(null, Buffer.from(SIGN_DOMAIN + canonical(bodyOf(body))), publicFromHex(publicKey), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
};

const validSettings = (v: unknown): SettingsFile | null => {
  const s = v as SettingsFile | null;
  if (!s || s.format !== SETTINGS_FORMAT || !isHex(s.publicKey, 64) || typeof s.seq !== 'number' || typeof s.signedAt !== 'number' || typeof s.stopAll !== 'boolean') return null;
  if (!s.accounts || typeof s.accounts !== 'object' || Array.isArray(s.accounts)) return null;
  for (const a of Object.values(s.accounts)) {
    if (!a || typeof a !== 'object' || typeof a.stopped !== 'boolean') return null;
    if (!isNumOrNull(a.dailyCapUsd) || !isNumOrNull(a.ratePerHour) || !isNumOrNull(a.approveAboveUsd)) return null;
    if (a.liveStrategy !== null && !isHex(a.liveStrategy, 64)) return null;
  }
  if (s.sig !== null && !isHex(s.sig, 128)) return null;
  return s;
};

export const writeSettings = (body: SettingsBody, priv: KeyObject) => {
  const b = bodyOf(body);
  writeAtomic(settingsPath(), { ...b, sig: signBody(b, priv) } satisfies SettingsFile);
};

/** Where the owner protection stands right now. Cheap: two small files and one Ed25519 verify. */
export function readOwnerState(): OwnerState {
  const ownerExists = existsSync(ownerPath());
  const rawSettings = existsSync(settingsPath()) ? readJson(settingsPath()) : undefined;
  const settings = rawSettings === undefined ? null : validSettings(rawSettings);
  if (!ownerExists) {
    if (rawSettings !== undefined) return { state: 'tampered', why: 'owner.json is missing but signed settings exist', owner: null, settings };
    return { state: 'unset' };
  }
  const owner = readOwnerFile();
  if (!owner) return { state: 'tampered', why: 'owner.json is unreadable or was edited', owner: null, settings };
  if (!settings) return { state: 'tampered', why: rawSettings === undefined ? 'owner-settings.json is missing' : 'owner-settings.json is unreadable or was edited', owner, settings: null };
  if (settings.publicKey !== owner.publicKey) return { state: 'tampered', why: 'owner-settings.json was signed by a different owner key', owner, settings };
  if (!settings.sig) return { state: 'tampered', why: settings.broken ? `stopped (${settings.broken.by}); the owner PIN resumes` : 'owner-settings.json is not signed', owner, settings };
  if (!verifyBody(settings, settings.sig, owner.publicKey)) return { state: 'tampered', why: 'owner-settings.json was edited (bad signature)', owner, settings };
  return { state: 'ok', owner, settings };
}

/** True when the owner state alone means "everything stopped": a bad/missing signature, or signed stopAll. */
export const ownerForcesStop = (st: OwnerState = readOwnerState()) => st.state === 'tampered' || (st.state === 'ok' && st.settings.stopAll);

/**
 * `stop` (anyone, no PIN): drop the signature so the settings read as stopped until the owner re-signs.
 * Keeps a hash of the old signature so the owner's `resume` can tell the values were not touched since
 * (Ed25519 is deterministic, so re-signing the same body gives the same signature). The hash alone can't
 * be turned back into a signature.
 */
export function breakSealForStop(by = 'stop', now = Date.now()) {
  const s = validSettings(readJson(settingsPath()));
  if (!s) return;
  if (!s.sig) {
    if (!s.stopAll) writeAtomic(settingsPath(), { ...s, stopAll: true });
    return;
  }
  writeAtomic(settingsPath(), { ...bodyOf(s), stopAll: true, sig: null, broken: { at: now, by, prevSigHash: sha256hex(s.sig), prevStopAll: s.stopAll } } satisfies SettingsFile);
}

/** After a stop: the last signed body, if the values are unchanged since the owner signed them (needs the key). */
export function recoverAfterStop(s: SettingsFile | null, priv: KeyObject, publicKey: string): SettingsBody | null {
  if (!s || s.sig || !s.broken || s.publicKey !== publicKey) return null;
  const before = { ...bodyOf(s), stopAll: s.broken.prevStopAll };
  return sha256hex(signBody(before, priv)) === s.broken.prevSigHash ? { ...before, stopAll: true } : null;
}

// ---- effective settings (what the gate enforces) ----
const usdOrder = (v: number | null | undefined) => (v == null ? Infinity : v);
/** Tighter of two USD limits; null = no limit. */
export const tighterUsd = (a: number | null | undefined, b: number | null | undefined): number | null => {
  const m = Math.min(usdOrder(a), usdOrder(b));
  return m === Infinity ? null : m;
};
const rateOrder = (v: number | null | undefined) => (v == null ? RATE_LIMIT_PER_HOUR : v === 0 ? Infinity : v);
/** Tighter of two rate limits; null = the default (30), 0 = off. Returns 0 only when both are off. */
export const tighterRate = (a: number | null | undefined, b: number | null | undefined): number => {
  const m = Math.min(rateOrder(a), rateOrder(b));
  return m === Infinity ? 0 : m;
};

export const restrictiveAccount = (stopped: boolean): SignedAccount => ({
  dailyCapUsd: DEFAULT_DAILY_CAP_USD,
  ratePerHour: RATE_LIMIT_PER_HOUR,
  approveAboveUsd: null,
  stopped,
  liveStrategy: null,
});

/** The signed ceiling for an account: the signed values when verified, else the restrictive defaults. */
export const signedFor = (st: OwnerState, name: string): SignedAccount =>
  st.state === 'ok' ? (st.settings.accounts[name] ?? restrictiveAccount(false)) : restrictiveAccount(st.state === 'tampered');

export type LocalLimits = { name: string; dailyCapUsd: number | null; ratePerHour?: number | null; approveAboveUsd?: number | null; stopped: boolean };
export type Effective = { dailyCapUsd: number | null; ratePerHour: number; approveAboveUsd: number | null; stopped: boolean };

/** What the gate enforces for an account: the tighter of the signed ceiling and config.json, field by field. */
export function effectiveAccount(a: LocalLimits, st: OwnerState = readOwnerState()): Effective {
  const s = signedFor(st, a.name);
  return {
    dailyCapUsd: tighterUsd(s.dailyCapUsd, a.dailyCapUsd),
    ratePerHour: tighterRate(s.ratePerHour, a.ratePerHour),
    approveAboveUsd: tighterUsd(s.approveAboveUsd, a.approveAboveUsd),
    stopped: s.stopped || !!a.stopped,
  };
}

export const hashLoaded = (l: Loaded) => sha256hex(canonical(l));

/** A live strategy may spend only if the owner signed exactly this strategy file for this account. */
export const liveApproved = (st: OwnerState, name: string, l: Loaded | null) =>
  !l || l.mode !== 'live' || (st.state === 'ok' && st.settings.accounts[name]?.liveStrategy === hashLoaded(l));
