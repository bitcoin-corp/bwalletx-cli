/**
 * bNamesX PC miner: app data dir, the local hot key, the PC's name list and the 1 BSV cap.
 * Everything lives in one per-user folder (%APPDATA%\bnamesx-miner on Windows). Nothing is uploaded.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ACCOUNT, CAP_SATS, digitNames } from './defaults.js';

export const appDir = (): string => {
  if (process.env.BNAMESX_MINER_HOME) return process.env.BNAMESX_MINER_HOME;
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'bnamesx-miner');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'bnamesx-miner');
  return join(homedir(), '.bnamesx-miner');
};

/** Point the bwalletx code (config, key file, wallet store, batch state) at the app dir. Call before anything else. */
export const useAppDir = () => {
  const dir = appDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.BWALLETX_HOME = dir;
  return dir;
};

export const listPath = () => join(appDir(), 'opns-pc-digits.txt');
export const writeList = () => {
  const p = listPath();
  writeFileSync(p, digitNames().join('\n') + '\n');
  return p;
};

/**
 * The hot key's passphrase: random, made on first run, kept next to the encrypted key file in the app dir
 * (unattended mining needs it). It protects nothing from someone who already has this folder; the cap does.
 */
const passPath = () => join(appDir(), 'passphrase.secret');
export const loadOrMakePassphrase = (): { pass: string; created: boolean } => {
  const p = passPath();
  if (existsSync(p)) return { pass: readFileSync(p, 'utf8').trim(), created: false };
  const pass = randomBytes(32).toString('base64url');
  writeFileSync(p, pass, { mode: 0o600 });
  return { pass, created: true };
};

/** New hot key on first run (bwalletx `newKey`), saved only in the app dir. Returns the account's public info. */
export async function ensureHotKey(): Promise<{ payAddress: string; created: boolean }> {
  const { readConfig } = await import('../store.js');
  const { pass } = loadOrMakePassphrase();
  process.env.BWALLETX_PASSPHRASE = pass; // in memory only, for unlock()
  const have = readConfig().accounts[ACCOUNT];
  if (have) return { payAddress: have.payAddress, created: false };
  const { newKey } = await import('../actions.js');
  const acct = await newKey(ACCOUNT, join(appDir(), `${ACCOUNT}.agentkey.json`), pass);
  return { payAddress: acct.payAddress, created: true };
}

// ---- the cap ----

/** Every budget the app ever passes is clamped to the 1 BSV cap. */
export const clampBudget = (sats: number) => Math.max(0, Math.min(CAP_SATS, Math.floor(sats || 0)));

type Funding = { fundedSats: number; payments: { at: number; sats: number; txid?: string }[] };
const fundPath = () => join(appDir(), 'funding.json');
export const readFunding = (): Funding => {
  try {
    return JSON.parse(readFileSync(fundPath(), 'utf8')) as Funding;
  } catch {
    return { fundedSats: 0, payments: [] };
  }
};
/** How much more the extension may send to the hot key before the 1 BSV cap is reached. */
export const fundRoom = (f: Funding = readFunding()) => Math.max(0, CAP_SATS - f.fundedSats);
/** Throws when a top-up would take the machine over the cap. */
export const checkTopUp = (sats: number, f: Funding = readFunding()) => {
  if (!(Number.isInteger(sats) && sats > 0)) throw new Error('Top-up must be a whole number of sats above 0');
  if (sats > fundRoom(f)) throw new Error(`Over the 1 BSV cap: at most ${fundRoom(f)} sats more for this machine`);
};
export const recordTopUp = (sats: number, txid?: string) => {
  const f = readFunding();
  checkTopUp(sats, f);
  f.fundedSats += sats;
  f.payments.push({ at: Date.now(), sats, txid });
  writeFileSync(fundPath(), JSON.stringify(f, null, 2), { mode: 0o600 });
  return f;
};

/** Persisted choice of where names and proceeds go ('vault' = baked-in owner addresses). */
export type Dest = { names: 'vault' | 'wallet'; pay: 'vault' | 'wallet'; walletAddress?: string; walletIdentity?: string };
const destPath = () => join(appDir(), 'destination.json');
export const readDest = (): Dest => {
  try {
    return JSON.parse(readFileSync(destPath(), 'utf8')) as Dest;
  } catch {
    return { names: 'vault', pay: 'vault' };
  }
};
export const writeDest = (d: Dest) => writeFileSync(destPath(), JSON.stringify(d, null, 2), { mode: 0o600 });

export const isAddress = (a: unknown): a is string => typeof a === 'string' && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
