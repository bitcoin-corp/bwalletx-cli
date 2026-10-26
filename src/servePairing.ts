/**
 * Pairing for `bwalletx serve`. The Origin header alone proves nothing: any local process can send one.
 * So a site pairs once: it asks `POST /pair`, serve shows the origin and an 8-digit comparison code in the
 * terminal (the site shows the same code), and the owner answers y/N. Approval issues a random per-origin
 * bearer token. Every wallet call must then carry `Authorization: Bearer <token>`.
 *
 * Tokens are stored only as SHA-256 hashes in ~/.bwalletx/serve-pairings.json (0600), so the file can't
 * be replayed as a token. Revoke with `bwalletx serve --revoke <origin>`; list with `--list-pairings`.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from './store.js';

export type Pairing = { origin: string; tokenHash: string; createdAt: number; lastUsedAt?: number };

const file = () => join(home(), 'serve-pairings.json');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function listPairings(): Pairing[] {
  if (!existsSync(file())) return [];
  try {
    const v = JSON.parse(readFileSync(file(), 'utf8')) as { pairings?: Pairing[] };
    return Array.isArray(v.pairings) ? v.pairings : [];
  } catch {
    return [];
  }
}

function save(pairings: Pairing[]) {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pairings }, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file());
}

/** Issue a fresh token for an origin (replacing any earlier one). Returns the token; only its hash is kept. */
export function issueToken(origin: string): string {
  const token = randomBytes(32).toString('base64url');
  save([...listPairings().filter((p) => p.origin !== origin), { origin, tokenHash: sha(token), createdAt: Date.now() }]);
  return token;
}

/** Remove an origin's pairing. True if one existed. */
export function revokePairing(origin: string): boolean {
  const all = listPairings();
  const rest = all.filter((p) => p.origin !== origin);
  if (rest.length === all.length) return false;
  save(rest);
  return true;
}

/** Does this bearer token belong to this origin? Read from disk each time so a revoke takes effect at once. */
export function checkToken(origin: string, token: string | undefined): boolean {
  if (!token) return false;
  const p = listPairings().find((x) => x.origin === origin);
  if (!p) return false;
  const a = Buffer.from(sha(token), 'hex');
  const b = Buffer.from(p.tokenHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 8-digit comparison code (same shape as the wallet's BRC-185 cd=8): both sides show it, the owner compares. */
export function comparisonCode(origin: string, nonce: string): string {
  const n = createHash('sha256').update(`bwalletx-serve-pair|${origin}|${nonce}`).digest().readUInt32BE(0) % 100_000_000;
  const s = String(n).padStart(8, '0');
  return `${s.slice(0, 4)} ${s.slice(4)}`;
}

export const bearerOf = (h: string | string[] | undefined) => {
  const v = Array.isArray(h) ? h[0] : h;
  const m = /^Bearer\s+(\S+)$/i.exec(v ?? '');
  return m?.[1];
};
