import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { buildQueue, newState, runHeadless, type RunDeps } from '../opns/batch.js';
import { checkTopUp, clampBudget, ensureHotKey, fundRoom, readFunding, recordTopUp, useAppDir } from './app.js';
import { CAP_SATS, digitNames, VAULT_PAY, VAULT_TO } from './defaults.js';
import { allowed } from './server.js';

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));

beforeEach(() => {
  process.env.BNAMESX_MINER_HOME = mkdtempSync(join(tmpdir(), 'bnx-'));
  useAppDir();
});

describe('defaults', () => {
  test('vault addresses are full public addresses', () => {
    for (const a of [VAULT_TO, VAULT_PAY]) expect(a).toMatch(/^1[1-9A-HJ-NP-Za-km-z]{33}$/);
  });
  test('the PC slice is every all-digit name of 1–4 chars', () => {
    const n = digitNames();
    expect(n.length).toBe(11_110);
    expect(new Set(n).size).toBe(n.length);
    expect(n.every((x) => /^[0-9]{1,4}$/.test(x))).toBe(true);
    expect(n).toContain('007');
  });
});

describe('1 BSV cap', () => {
  test('budgets are clamped to the cap', () => {
    expect(clampBudget(5e9)).toBe(CAP_SATS);
    expect(clampBudget(-1)).toBe(0);
    expect(clampBudget(1234.9)).toBe(1234);
  });

  test('top-ups stop at the cap in total', () => {
    expect(fundRoom()).toBe(CAP_SATS);
    recordTopUp(60_000_000);
    expect(readFunding().fundedSats).toBe(60_000_000);
    expect(() => checkTopUp(40_000_001)).toThrow(/cap/);
    expect(() => recordTopUp(40_000_001)).toThrow(/cap/);
    recordTopUp(40_000_000);
    expect(fundRoom()).toBe(0);
    expect(() => checkTopUp(1)).toThrow(/cap/);
    expect(() => checkTopUp(0)).toThrow();
  });

  test('the batch runner stops before a name that would go over the clamped cap', async () => {
    const names = digitNames(2); // 110 names
    const state = newState('opns4', buildQueue([], names), { to: VAULT_TO, budgetSats: clampBudget(10 * CAP_SATS) });
    const ours = new Set<string>();
    const deps: RunDeps = {
      fetch: async (url) => (url.includes('/origin/') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ outpoint: `${'a'.repeat(64)}.1`, domain: '' }))),
      mine: async (name) => (ours.add(name), [{ txid: `${name}-tx`, newDomain: name }]),
      list: async () => 'x',
      isListed: async () => false,
      rate: async () => 17,
      charsNeeded: async () => 1,
      isOurs: (n) => ours.has(n),
      perCharSats: 30_000_000, // 0.3 BSV a character: the cap covers three names
      listFeeSats: 200,
      save: () => undefined,
      onUpdate: () => undefined,
      sleep: async () => undefined,
    };
    const r = await runHeadless(deps, state, new AbortController().signal);
    expect(r.stopped).toBe('budget');
    expect(r.state.spentSats).toBeLessThanOrEqual(CAP_SATS);
    expect(r.state.items.filter((i) => i.status === 'done').length).toBe(3);
  });
});

describe('hot key', () => {
  test('is made once and written only inside the app data dir', async () => {
    const dir = process.env.BNAMESX_MINER_HOME!;
    expect(process.env.BWALLETX_HOME).toBe(dir);
    const a = await ensureHotKey();
    expect(a.created).toBe(true);
    expect(a.payAddress).toMatch(/^1/);
    const b = await ensureHotKey();
    expect(b).toEqual({ payAddress: a.payAddress, created: false });
    const files = walk(dir).map((f) => relative(dir, f)).sort();
    expect(files).toEqual(expect.arrayContaining(['accounts/opns4.key.json', 'config.json', 'opns4.agentkey.json', 'passphrase.secret']));
    for (const f of files) expect(f.startsWith('..')).toBe(false);
    const { keyFilePath } = await import('../store.js');
    expect(keyFilePath('opns4').startsWith(dir)).toBe(true);
    // The key file is encrypted: no WIF in it.
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(dir, 'accounts/opns4.key.json'), 'utf8')).not.toMatch(/"(payPk|ordPk|identityPk)"/);
    expect(existsSync(join(dir, 'opns-pc-digits.txt'))).toBe(false); // the list is written by main, not by the key step
  });
});

describe('local page guard', () => {
  const port = 47402;
  const tok = 'tok_abcdefghijklmnopqrstuvwx';
  const req = (h: Record<string, string>, url = `/?t=${tok}`) => ({ headers: h, url });
  test('needs the right host, origin and token', () => {
    expect(allowed(req({ host: `127.0.0.1:${port}` }), port, tok)).toBe(true);
    expect(allowed(req({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }), port, tok)).toBe(true);
    expect(allowed(req({ host: `127.0.0.1:${port}`, 'x-token': tok }, '/api/status'), port, tok)).toBe(true);
    expect(allowed(req({ host: `localhost:${port}` }), port, tok)).toBe(false);
    expect(allowed(req({ host: `evil.example:${port}` }), port, tok)).toBe(false);
    expect(allowed(req({ host: `127.0.0.1:${port}`, origin: 'https://evil.example' }), port, tok)).toBe(false);
    expect(allowed(req({ host: `127.0.0.1:${port}` }, '/?t=wrong'), port, tok)).toBe(false);
    expect(allowed(req({ host: `127.0.0.1:${port}` }, '/api/status'), port, tok)).toBe(false);
  });
});
