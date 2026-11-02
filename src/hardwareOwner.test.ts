/**
 * The hardware owner (0.7.0): on a Mac the owner key is a Secure Enclave key that needs Touch ID / the Mac password
 * to sign, anchored in the Keychain. Here the store is an in-memory mock behind the same interface: a P-256 key per
 * "enclave" key, an anchor slot, and a counter of presence approvals. Nothing touches the real Keychain.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes, sign as cSign, type KeyObject } from 'node:crypto';
import { setHardwareStore, type HardwareOwnerStore, type HwAnchor, type HwAvailability, type HwSigner } from './hardwareOwner';
import { commentFromSecurityOutput, decodeAnchor } from './macOwnerStore';
import { allStopped, readConfig, writeConfig, type AccountConfig } from './store';
import { gateAction } from './gate';
import { DEFAULT_DAILY_CAP_USD } from './limits';
import { effectiveAccount, ownerPath, readOwnerState, settingsMessage, settingsPath, verifyOwnerSig } from './owner';
import * as og from './ownerGate';

const PIN = 'correct horse battery';
const NOW = Date.now();
let dir: string;
let hw: MockStore;

const p256 = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const j = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return { priv: privateKey, pub: '04' + Buffer.from(j.x, 'base64url').toString('hex') + Buffer.from(j.y, 'base64url').toString('hex') };
};
const p256Sign = (k: KeyObject, m: Buffer) => cSign('sha256', m, { key: k, dsaEncoding: 'ieee-p1363' });

/** A pretend Secure Enclave + Keychain. `approve` is the human answering the prompt. */
class MockStore implements HardwareOwnerStore {
  readonly kind = 'mock-enclave';
  readonly prompt = 'Touch ID or your Mac password';
  readonly label = 'a mock enclave key';
  anchor: HwAnchor | null = null;
  enclave = new Map<string, KeyObject>();
  approve = true;
  approvals = 0;
  opens: string[] = [];
  avail: HwAvailability = { ok: true };
  readError: Error | null = null;
  /** Simulates a lying helper: says yes, signs with some other key. */
  forgeWith: KeyObject | null = null;

  async available() {
    return this.avail;
  }
  readAnchor() {
    if (this.readError) throw this.readError;
    return this.anchor;
  }
  async generate(): Promise<HwAnchor> {
    const k = p256();
    this.enclave.set(k.pub, k.priv);
    return { publicKey: k.pub, blob: randomBytes(48).toString('base64'), createdAt: Date.now() };
  }
  saveAnchor(a: HwAnchor) {
    if (this.anchor) throw new Error('an owner key is already in the macOS Keychain');
    this.anchor = a;
  }
  removeAnchor() {
    this.anchor = null;
  }
  async open(a: HwAnchor, reason: string): Promise<HwSigner> {
    this.opens.push(reason);
    if (this.forgeWith) {
      const k = this.forgeWith;
      return { sign: async (m) => p256Sign(k, m), close: () => {} };
    }
    if (!this.approve) throw new Error('the owner cancelled');
    const k = this.enclave.get(a.publicKey);
    if (!k) throw new Error('not a Secure Enclave key of this Mac');
    this.approvals++;
    return { sign: async (m) => p256Sign(k, m), close: () => {} };
  }
}

const acct = (p: Partial<AccountConfig> = {}): AccountConfig => ({
  name: 't', kind: 'key', identityAddress: '1Id', payAddress: '1Pay', ordAddress: '1Ord', dailyCapUsd: DEFAULT_DAILY_CAP_USD, stopped: false, importedAt: NOW - 1e7, ...p,
});
const env = (p: Partial<og.OwnerEnv> & { answers?: string[]; yes?: boolean } = {}): og.OwnerEnv & { said: string[]; asked: string[] } => {
  const answers = [...(p.answers ?? [])];
  const said: string[] = [];
  const asked: string[] = [];
  return {
    stdinTTY: true,
    stdoutTTY: true,
    underMcp: false,
    agentShell: null,
    prompt: async (q) => (asked.push(q), answers.shift() ?? ''),
    confirm: async () => p.yes ?? true,
    say: (s) => void said.push(s),
    scrypt: { N: 1024, r: 8, p: 1 },
    ...p,
    said,
    asked,
  };
};
/** What an agent with `script` and CLAUDECODE unset looks like to the gate: a TTY, no markers, its own PIN. */
const agentWithFakeTty = () => env({ answers: [PIN, PIN, PIN, PIN] });
const send = (usd: number) => gateAction('t', { kind: 'send', token: 'BSV', usd, to: '1X' });
const cfgAcct = () => readConfig().accounts.t;
const settings = () => JSON.parse(readFileSync(settingsPath(), 'utf8'));
const setupHw = async () => (await og.setupOwner(env())).close();
const deleteOwnerFiles = () => (rmSync(ownerPath(), { force: true }), rmSync(settingsPath(), { force: true }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bwx-hwowner-'));
  process.env.BWALLETX_HOME = dir;
  delete process.env.BWALLETX_YES;
  delete process.env.BWALLETX_UNDER_MCP;
  delete process.env.BWALLETX_PASSPHRASE;
  writeConfig({ accounts: { t: acct() }, defaultAccount: 't' });
  hw = new MockStore();
  setHardwareStore(hw);
});
afterEach(() => {
  setHardwareStore(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('setup on a Mac makes a Touch ID owner, never a PIN', () => {
  test('one presence approval, no PIN asked; anchor saved; settings signed by the enclave key', async () => {
    const e = env({ answers: [PIN, PIN] });
    (await og.setupOwner(e)).close();
    expect(e.asked).toEqual([]);
    expect(hw.approvals).toBe(1);
    expect(hw.anchor).not.toBeNull();
    expect(JSON.parse(readFileSync(ownerPath(), 'utf8'))).toMatchObject({ format: 'bwalletx.owner-hw/1', publicKey: hw.anchor!.publicKey });
    const st = readOwnerState();
    expect(st).toMatchObject({ state: 'ok', gate: 'hardware' });
    const s = settings();
    expect(verifyOwnerSig(settingsMessage(s), Buffer.from(s.sig, 'hex'), hw.anchor!.publicKey)).toBe(true);
    expect(send(1).ok).toBe(true);
  });

  test('the owner cancelling the prompt leaves nothing behind', async () => {
    hw.approve = false;
    await expect(og.setupOwner(env())).rejects.toThrow(/Not approved/);
    expect(hw.anchor).toBeNull();
    expect(existsSync(ownerPath())).toBe(false);
    expect(readOwnerState().state).toBe('unset');
  });

  test("an agent with a fake TTY can't finish setup: it has no finger", async () => {
    hw.approve = false;
    await expect(og.setCap('t', '500', agentWithFakeTty())).rejects.toThrow(/Not approved/);
    expect(readOwnerState().state).toBe('unset');
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBe(10);
  });

  test('a helper that says yes but signs with another key is refused', async () => {
    hw.forgeWith = p256().priv;
    await expect(og.setupOwner(env())).rejects.toThrow(/did not prove/);
    expect(hw.anchor).toBeNull();
    expect(readOwnerState().state).toBe('unset');
  });

  test('no silent PIN fallback when the Mac merely fails to build the helper', async () => {
    hw.avail = { ok: false, why: 'no swiftc' };
    const e = env({ answers: [PIN, PIN] });
    await expect(og.setupOwner(e)).rejects.toThrow(/doesn't fall back to a PIN/);
    expect(e.asked).toEqual([]);
    expect(existsSync(ownerPath())).toBe(false);
  });

  test('a Mac with definitely no Secure Enclave falls back to the PIN, with the software-only warning', async () => {
    hw.avail = { ok: false, why: 'this Mac has no Secure Enclave', noHardware: true };
    const e = env({ answers: [PIN, PIN] });
    (await og.setupOwner(e)).close();
    expect(e.said.join('\n')).toMatch(/software-only/);
    expect(readOwnerState()).toMatchObject({ state: 'ok', gate: 'software' });
  });
});

describe('the owner files cannot be reset by deleting them', () => {
  test('delete owner*.json → stopped and default-restrictive, not unset', async () => {
    await setupHw();
    await og.setCap('t', '500', env());
    expect(send(100).ok).toBe(true);
    deleteOwnerFiles();
    expect(readOwnerState()).toMatchObject({ state: 'tampered', gate: 'hardware', why: /still in the macOS Keychain/ });
    expect(allStopped()).toBe(true);
    expect(effectiveAccount(cfgAcct())).toMatchObject({ dailyCapUsd: 10, ratePerHour: 30, stopped: true });
    expect(send(1)).toMatchObject({ ok: false, rule: 'stop' });
    // just owner.json gone is the same
    await og.resumeAll(env());
    rmSync(ownerPath());
    expect(readOwnerState().state).toBe('tampered');
    expect(allStopped()).toBe(true);
  });

  test('setup is refused while the Keychain marker exists, with or without the owner files', async () => {
    await setupHw();
    await expect(og.setupOwner(agentWithFakeTty())).rejects.toThrow(/already in the macOS Keychain/);
    deleteOwnerFiles();
    const e = agentWithFakeTty();
    await expect(og.setupOwner(e)).rejects.toThrow(/already in the macOS Keychain/);
    expect(e.asked).toEqual([]); // no PIN is even asked for
    // and a loosening command asks for Touch ID instead of offering setup
    hw.approve = false;
    await expect(og.setCap('t', '500', agentWithFakeTty())).rejects.toThrow(/Not approved/);
    expect(hw.opens.at(-1)).toMatch(/raise t's daily cap/);
    expect(readOwnerState().state).toBe('tampered');
  });

  test('forged PIN owner files are not accepted while the Keychain marker exists', async () => {
    await setupHw();
    deleteOwnerFiles();
    // the agent writes a PIN owner of its own (as 0.6.0 setup would) behind the gate's back
    setHardwareStore(null);
    (await og.setupOwner(agentWithFakeTty())).close();
    await og.setCap('t', 'off', agentWithFakeTty());
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBeNull();
    setHardwareStore(hw);
    expect(readOwnerState()).toMatchObject({ state: 'tampered', why: /not the Touch ID owner/ });
    expect(effectiveAccount(cfgAcct())).toMatchObject({ dailyCapUsd: 10, stopped: true });
    expect(send(1)).toMatchObject({ ok: false, rule: 'stop' });
  });

  test('owner files signed by another P-256 key are refused (only the anchored key counts)', async () => {
    await setupHw();
    const other = p256();
    const s = settings();
    s.accounts.t.dailyCapUsd = null;
    const body = { ...s, publicKey: other.pub };
    writeFileSync(ownerPath(), JSON.stringify({ format: 'bwalletx.owner-hw/1', store: 'mock-enclave', publicKey: other.pub, createdAt: NOW }));
    writeFileSync(settingsPath(), JSON.stringify({ ...body, sig: p256Sign(other.priv, settingsMessage(body)).toString('hex') }));
    expect(readOwnerState()).toMatchObject({ state: 'tampered', why: /does not match the owner key in the macOS Keychain/ });
    expect(send(1)).toMatchObject({ ok: false, rule: 'stop' });
  });

  test('after deleting the files, the owner restores with Touch ID (at the safe defaults)', async () => {
    await setupHw();
    await og.setCap('t', '500', env());
    deleteOwnerFiles();
    const before = hw.approvals;
    await og.resumeAll(env());
    expect(hw.approvals).toBe(before + 1);
    expect(readOwnerState()).toMatchObject({ state: 'ok', gate: 'hardware' });
    expect(allStopped()).toBe(false);
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBe(10);
  });

  test('the Keychain item removed outside `owner reset` → stopped; setup then needs Touch ID again', async () => {
    await setupHw();
    hw.anchor = null; // `security delete-generic-password` from a shell
    expect(readOwnerState()).toMatchObject({ state: 'tampered', gate: 'hardware', why: /removed from the macOS Keychain/ });
    expect(send(1)).toMatchObject({ ok: false, rule: 'stop' });
    hw.approve = false;
    await expect(og.setupOwner(agentWithFakeTty())).rejects.toThrow(/Not approved/);
    await expect(og.setCap('t', '500', agentWithFakeTty())).rejects.toThrow(/Not approved/);
    expect(readOwnerState().state).toBe('tampered');
    hw.approve = true;
    await setupHw();
    expect(readOwnerState()).toMatchObject({ state: 'ok', gate: 'hardware' });
  });

  test('an unreadable Keychain fails closed: stopped, and nothing is loosened', async () => {
    await setupHw();
    hw.readError = new Error('the macOS Keychain could not be read (security: exit 51)');
    expect(readOwnerState()).toMatchObject({ state: 'tampered', why: /could not be read/ });
    expect(allStopped()).toBe(true);
    await expect(og.setCap('t', '500', env())).rejects.toThrow(/can't tell whether a Touch ID owner exists/);
    await expect(og.setupOwner(env())).rejects.toThrow(/can't tell/);
  });
});

describe('loosening needs a hardware approval; tightening needs nothing', () => {
  test('every loosening command calls the hardware approval, and is refused without it', async () => {
    await setupHw();
    hw.approve = false;
    const before = settings();
    await expect(og.setCap('t', '50', env())).rejects.toThrow(/Not approved/);
    await expect(og.setRateLimit('t', 'off', env())).rejects.toThrow(/Not approved/);
    await expect(og.setApproveAbove('t', 'off', env())).rejects.toThrow(/Not approved/);
    await expect(og.resumeAll(env())).rejects.toThrow(/Not approved/);
    await expect(og.ownerSign(env())).rejects.toThrow(/Not approved/);
    await expect(og.requireOwner('serve this wallet to x.example', env())).rejects.toThrow(/Not approved/);
    expect(hw.opens).toHaveLength(1 + 6);
    expect(settings()).toEqual(before);
    expect(cfgAcct().dailyCapUsd).toBe(10);

    hw.approve = true;
    const e = env({ answers: [PIN] });
    expect(await og.setCap('t', '50', e)).toMatch(/\$50/);
    expect(e.asked).toEqual([]); // Touch ID replaces the PIN
    expect(hw.approvals).toBe(2);
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBe(50);
  });

  test('still refused before any prompt under MCP, without a TTY, or in a shell that says it is an agent', async () => {
    await setupHw();
    const n = hw.opens.length;
    await expect(og.setCap('t', '50', env({ underMcp: true }))).rejects.toThrow(/under MCP/);
    await expect(og.setCap('t', '50', env({ stdinTTY: false }))).rejects.toThrow(/interactive terminal/);
    await expect(og.setCap('t', '50', env({ agentShell: 'CLAUDECODE' }))).rejects.toThrow(/agent's shell/);
    expect(hw.opens.length).toBe(n);
  });

  test('tightening never calls the hardware store: lower cap / rate / approve-above, stop, MCP lower_cap', async () => {
    await setupHw();
    await og.setCap('t', '50', env());
    const n = hw.opens.length;
    const agent = env({ stdinTTY: false, underMcp: true });
    await og.setCap('t', '20', agent);
    await og.setRateLimit('t', '5', agent);
    await og.setApproveAbove('t', '2', agent);
    og.lowerCap('t', 15);
    og.stopAllAgents('MCP');
    expect(hw.opens.length).toBe(n);
    expect(allStopped()).toBe(true);
    expect(cfgAcct()).toMatchObject({ dailyCapUsd: 15, ratePerHour: 5, approveAboveUsd: 2 });
  });

  test('stop, then resume with Touch ID: the owner reviews the values from before the stop', async () => {
    await setupHw();
    await og.setCap('t', '50', env());
    og.stopAllAgents('MCP');
    rmSync(join(dir, 'STOP'));
    expect(allStopped()).toBe(true);
    const yes = env({ yes: true });
    await og.resumeAll(yes);
    expect(yes.said.join('\n')).toMatch(/Limits from before the stop[\s\S]*t: cap \$50\/day/);
    expect(allStopped()).toBe(false);
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBe(50);
    // declining resumes at the safe defaults instead
    og.stopAllAgents('MCP');
    await og.resumeAll(env({ yes: false }));
    expect(allStopped()).toBe(false);
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBe(10);
  });
});

describe('owner reset and upgrade', () => {
  test('reset needs Touch ID; then the owner is gone and setup works again', async () => {
    await setupHw();
    hw.approve = false;
    await expect(og.ownerReset(env())).rejects.toThrow(/Not approved/);
    expect(hw.anchor).not.toBeNull();
    expect(readOwnerState().state).toBe('ok');
    expect(await og.ownerReset(env({ yes: false }))).toBe('Nothing changed.');
    hw.approve = true;
    expect(await og.ownerReset(env())).toMatch(/Owner reset/);
    expect(hw.anchor).toBeNull();
    expect(readOwnerState().state).toBe('unset');
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBe(10);
    await setupHw();
    expect(readOwnerState()).toMatchObject({ state: 'ok', gate: 'hardware' });
  });

  test('reset is refused with no Touch ID owner, and refused for an agent shell before any prompt', async () => {
    await expect(og.ownerReset(env())).rejects.toThrow(/nothing to reset/);
    await setupHw();
    await expect(og.ownerReset(env({ stdoutTTY: false }))).rejects.toThrow(/interactive terminal/);
    expect(hw.anchor).not.toBeNull();
  });

  test('upgrade moves a 0.6.0 PIN owner to Touch ID and keeps the signed limits; the PIN then does nothing', async () => {
    setHardwareStore(null);
    (await og.setupOwner(env({ answers: [PIN, PIN] }))).close();
    await og.setCap('t', '500', env({ answers: [PIN] }));
    setHardwareStore(hw);
    expect(og.ownerStatus()).toMatchObject({ gate: 'software', warning: /owner upgrade/ });
    hw.approve = false;
    await expect(og.ownerUpgrade(env({ answers: [PIN] }))).rejects.toThrow(/Not approved/);
    expect(readOwnerState()).toMatchObject({ state: 'ok', gate: 'software' });
    hw.approve = true;
    await expect(og.ownerUpgrade(env({ answers: ['wrong pin 123'] }))).rejects.toThrow(/Wrong owner PIN/);
    expect(await og.ownerUpgrade(env({ answers: [PIN] }))).toMatch(/now uses Touch ID/);
    expect(readOwnerState()).toMatchObject({ state: 'ok', gate: 'hardware' });
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBe(500);
    await expect(og.ownerChange(env({ answers: [PIN, 'another pin 456', 'another pin 456'] }))).rejects.toThrow(/no PIN to change/);
    hw.approve = false;
    await expect(og.setCap('t', 'off', env({ answers: [PIN] }))).rejects.toThrow(/Not approved/);
  });
});

describe('owner status', () => {
  test('software fallback (no hardware store, e.g. Linux/CI): PIN behaviour kept, with a clear warning', async () => {
    setHardwareStore(null);
    expect(og.ownerStatus()).toMatchObject({ state: 'unset', gate: 'software', warning: /software-only/ });
    const e = env({ answers: [PIN, PIN] });
    (await og.setupOwner(e)).close();
    expect(e.said.join('\n')).toMatch(/WARNING: .*software-only/);
    const s = og.ownerStatus();
    expect(s).toMatchObject({ state: 'ok', gate: 'software', pin: 'set', warning: /software-only/ });
    expect(s.warning).not.toMatch(/owner upgrade/); // nothing better to upgrade to here
    await og.setCap('t', '50', env({ answers: [PIN] }));
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBe(50);
  });

  test('hardware owner: no warning, and status needs no prompt', async () => {
    await setupHw();
    const n = hw.opens.length;
    const s = og.ownerStatus();
    expect(s).toMatchObject({ state: 'ok', gate: 'hardware', pin: 'none (Touch ID owner)' });
    expect('warning' in s).toBe(false);
    expect(JSON.stringify(s)).not.toContain(hw.anchor!.blob);
    expect(hw.opens.length).toBe(n);
  });
});

describe('macOS store: Keychain anchor parsing (no Keychain access)', () => {
  const pub = '04' + 'ab'.repeat(64);
  const out = (comment: string) =>
    `keychain: "/Users/x/Library/Keychains/login.keychain-db"\nclass: "genp"\nattributes:\n    "acct"<blob>="owner"\n    "icmt"<blob>="${comment}"\n    "svce"<blob>="bwalletx owner key"\n`;

  test('reads a well-formed anchor', () => {
    const c = commentFromSecurityOutput(out(`bwalletx-owner-anchor/1:${pub}:QUJD+/9=:1700000000000`));
    expect(decodeAnchor(c!)).toEqual({ publicKey: pub, blob: 'QUJD+/9=', createdAt: 1700000000000 });
  });

  test('anything else is not an anchor (the caller then fails closed)', () => {
    expect(commentFromSecurityOutput('attributes:\n    "icmt"<blob>=<NULL>\n')).toBeNull();
    expect(decodeAnchor(`bwalletx-owner-anchor/1:${pub.slice(2)}:QUJD:1`)).toBeNull();
    expect(decodeAnchor(`bwalletx-owner-anchor/2:${pub}:QUJD:1`)).toBeNull();
    expect(decodeAnchor(`bwalletx-owner-anchor/1:${pub}:not base64!:1`)).toBeNull();
    expect(decodeAnchor(`bwalletx-owner-anchor/1:${pub}:QUJD:soon`)).toBeNull();
  });
});
