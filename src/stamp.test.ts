import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setAllStopped, writeConfig, type AccountConfig } from './store';
import { STAMP_TAG, registerStamp, stampScript, stampWith, stampedHash, verifyStamp } from './stamp';

const NOW = Date.now();
const acct = (p: Partial<AccountConfig> = {}): AccountConfig => ({
  name: 'acme', identityAddress: '1Id', payAddress: '1Pay', ordAddress: '1Ord', dailyCapUsd: null, stopped: false, importedAt: NOW - 1e7, ...p,
});
const TXID = 'cd'.repeat(32);

let dir = '';
const file = (body = 'SH01 receipt, cert 011') => {
  const p = join(dir, 'receipt.pdf');
  writeFileSync(p, body);
  return { p, sha: createHash('sha256').update(body).digest('hex') };
};
const fakeWallet = () => {
  const createAction = vi.fn(async (_args: { outputs: { lockingScript: string; satoshis: number }[] }) => ({ txid: TXID }));
  return { w: { wallet: { createAction } as never, sendWaiting: vi.fn(async () => undefined) }, createAction };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bwx-stamp-'));
  process.env.BWALLETX_HOME = dir;
  writeConfig({ accounts: { acme: acct() }, defaultAccount: 'acme' });
  setAllStopped(false);
});

describe('bwalletx stamp: a file hash on chain, nothing else', () => {
  test('the script carries the tag and the 32-byte hash, and reads back', () => {
    const { sha } = file();
    const hex = stampScript(sha).toHex();
    expect(hex.startsWith('006a')).toBe(true);
    expect(stampedHash(hex)).toBe(sha);
    expect(hex).not.toContain(Buffer.from('receipt').toString('hex')); // the file name never goes on chain
  });

  test('other scripts are not stamps', () => {
    expect(stampedHash('76a914' + '00'.repeat(20) + '88ac')).toBeNull();
    expect(stampedHash('nothex')).toBeNull();
    expect(() => stampScript('xyz')).toThrow();
  });

  test('stampWith signs one 0-sat OP_RETURN, returns the JSON fields and appends the register', async () => {
    const { p, sha } = file();
    const { w, createAction } = fakeWallet();
    const register = join(dir, 'SEAL-REGISTER.md');
    const r = await stampWith('acme', w, p, { rate: 50, register, now: () => new Date('2026-11-02T06:00:00Z') });
    expect(r).toEqual({ file: 'receipt.pdf', sha256: sha, txid: TXID, account: 'acme', timestamp: '2026-11-02T06:00:00.000Z' });
    const outputs = createAction.mock.calls[0][0].outputs;
    expect(outputs).toHaveLength(1);
    expect(outputs[0].satoshis).toBe(0);
    expect(stampedHash(outputs[0].lockingScript)).toBe(sha);
    const reg = readFileSync(register, 'utf8');
    expect(reg).toContain('| Time (UTC) | File | SHA-256 | Txid | Account |');
    expect(reg).toContain(`| 2026-11-02T06:00:00.000Z | receipt.pdf | ${sha} | ${TXID} | acme |`);
  });

  test('goes through the spending gate: a stopped wallet never signs', async () => {
    const { p } = file();
    const { w, createAction } = fakeWallet();
    setAllStopped(true);
    await expect(stampWith('acme', w, p, { rate: 50 })).rejects.toThrow(/Refused/);
    expect(createAction).not.toHaveBeenCalled();
  });

  test('a register with existing rows only gets a new row', () => {
    const register = join(dir, 'SEAL-REGISTER.md');
    writeFileSync(register, '# Seal register\n\n| Time (UTC) | File | SHA-256 | Txid | Account |\n|---|---|---|---|---|\n| old |\n');
    registerStamp(register, { file: 'a|b.pdf', sha256: 'ee'.repeat(32), txid: TXID, account: 'acme', timestamp: 't' });
    const lines = readFileSync(register, 'utf8').trim().split('\n');
    expect(lines.at(-2)).toBe('| old |');
    expect(lines.at(-1)).toContain('a\\|b.pdf');
  });
});

describe('bwalletx verify: rechecks the hash against the chain', () => {
  const tx = (scriptHex: string, extra: Record<string, unknown> = {}) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({ vout: [{ scriptPubKey: { hex: '76a914' + '00'.repeat(20) + '88ac' } }, { scriptPubKey: { hex: scriptHex } }], ...extra }),
  });

  test('match, with block time', async () => {
    const { p, sha } = file();
    const r = await verifyStamp(p, TXID, tx(stampScript(sha).toHex(), { confirmations: 3, blocktime: 1793590000 }));
    expect(r.match).toBe(true);
    expect(r.confirmations).toBe(3);
    expect(r.blockTime).toBe(new Date(1793590000 * 1000).toISOString());
  });

  test('a different file does not match', async () => {
    const { p } = file('edited receipt');
    const r = await verifyStamp(p, TXID, tx(stampScript('ab'.repeat(32)).toHex()));
    expect(r.match).toBe(false);
    expect(r.stamped).toBe('ab'.repeat(32));
  });

  test('a tx without a stamp, or a bad txid', async () => {
    const { p } = file();
    expect((await verifyStamp(p, TXID, tx('6a0568656c6c6f'))).stamped).toBeNull();
    await expect(verifyStamp(p, 'nope')).rejects.toThrow();
    expect(STAMP_TAG).toBe('bwx.stamp/1');
  });
});
