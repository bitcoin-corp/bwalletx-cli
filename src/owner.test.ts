/**
 * The owner gate (0.6.0): loosening needs a human at a terminal with the owner PIN; tightening needs nothing;
 * hand edits to the settings files can't loosen anything. Throwaway state in a temp BWALLETX_HOME only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey } from '@bsv/sdk';
import { exampleStrategy, type Loaded } from './strategy';
import { allStopped, readConfig, setLoaded, writeConfig, type AccountConfig } from './store';
import { gateAction } from './gate';
import { DEFAULT_DAILY_CAP_USD } from './limits';
import { effectiveAccount, readOwnerState, settingsPath } from './owner';
import * as og from './ownerGate';
import { encryptKeyFile } from './keyfile';
import { importKey } from './actions';

const PIN = 'correct horse battery';
const NOW = Date.now();
let dir: string;

const acct = (p: Partial<AccountConfig> = {}): AccountConfig => ({
  name: 't', kind: 'key', identityAddress: '1Id', payAddress: '1Pay', ordAddress: '1Ord', dailyCapUsd: DEFAULT_DAILY_CAP_USD, stopped: false, importedAt: NOW - 1e7, ...p,
});

/** A scripted owner at a terminal: answers prompts in order, confirms with `yes`. */
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
const setupPin = () => og.setupOwner(env({ answers: [PIN, PIN] }));
const send = (usd: number) => gateAction('t', { kind: 'send', token: 'BSV', usd, to: '1X' });
const cfgAcct = () => readConfig().accounts.t;
const settings = () => JSON.parse(readFileSync(settingsPath(), 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bwx-owner-'));
  process.env.BWALLETX_HOME = dir;
  delete process.env.BWALLETX_YES;
  delete process.env.BWALLETX_UNDER_MCP;
  delete process.env.BWALLETX_PASSPHRASE;
  writeConfig({ accounts: { t: acct() }, defaultAccount: 't' });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loosening is refused unless the owner is at a terminal with the PIN', () => {
  test('refused without a TTY (piped stdin, or stdout not a terminal)', async () => {
    await setupPin();
    await expect(og.setCap('t', '50', env({ stdinTTY: false, answers: [PIN] }))).rejects.toThrow(/interactive terminal/);
    await expect(og.setCap('t', 'off', env({ stdoutTTY: false, answers: [PIN] }))).rejects.toThrow(/interactive terminal/);
    await expect(og.resumeAll(env({ stdinTTY: false, answers: [PIN] }))).rejects.toThrow(/interactive terminal/);
    expect(cfgAcct().dailyCapUsd).toBe(10);
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBe(10);
  });

  test('BWALLETX_YES does not skip it', async () => {
    await setupPin();
    process.env.BWALLETX_YES = '1';
    // the real environment of a test run has no TTY, like an agent's shell
    await expect(og.setCap('t', '50')).rejects.toThrow(/interactive terminal|BWALLETX_YES/);
    await expect(og.setRateLimit('t', 'off')).rejects.toThrow(/interactive terminal/);
    await expect(og.setApproveAbove('t', 'off')).rejects.toThrow(/interactive terminal/);
    await expect(og.requireOwner('load a strategy live')).rejects.toThrow(/interactive terminal/);
    expect(cfgAcct().dailyCapUsd).toBe(10);
  });

  test('refused under the MCP server (flag or inherited env), even with a TTY and the right PIN', async () => {
    await setupPin();
    await expect(og.setCap('t', '50', env({ underMcp: true, answers: [PIN] }))).rejects.toThrow(/under MCP/);
    process.env.BWALLETX_UNDER_MCP = '1';
    expect(og.defaultOwnerEnv().underMcp).toBe(true);
    await expect(og.setCap('t', '50', { ...env({ answers: [PIN] }), underMcp: og.defaultOwnerEnv().underMcp })).rejects.toThrow(/under MCP/);
    expect(cfgAcct().dailyCapUsd).toBe(10);
  });

  test("refused in an AI agent's shell that says so (CLAUDECODE)", async () => {
    await expect(og.setCap('t', '50', env({ agentShell: 'CLAUDECODE', answers: [PIN] }))).rejects.toThrow(/agent's shell/);
  });

  test('refused with a wrong PIN; nothing changes', async () => {
    await setupPin();
    const before = settings();
    await expect(og.setCap('t', '50', env({ answers: ['wrong pin 123'] }))).rejects.toThrow(/Wrong owner PIN/);
    await expect(og.resumeAll(env({ answers: [''] }))).rejects.toThrow(/Wrong owner PIN/);
    expect(cfgAcct().dailyCapUsd).toBe(10);
    expect(settings()).toEqual(before);
  });

  test('the right PIN raises the cap, and the gate then allows it', async () => {
    await setupPin();
    expect(send(20)).toMatchObject({ ok: false, rule: 'dailyCap' });
    const e = env({ answers: [PIN] });
    expect(await og.setCap('t', '50', e)).toBe('t: daily cap $50');
    expect(e.asked[0]).toMatch(/Owner PIN to raise t's daily cap/);
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBe(50);
    expect(send(20).ok).toBe(true);
  });

  test('the PIN is never taken from env', async () => {
    await setupPin();
    process.env.BWALLETX_OWNER_PIN = PIN;
    process.env.BWALLETX_PIN = PIN;
    await expect(og.setCap('t', '50', env({ answers: [] }))).rejects.toThrow(/Wrong owner PIN/);
    delete process.env.BWALLETX_OWNER_PIN;
    delete process.env.BWALLETX_PIN;
  });

  test('the PIN must differ from the wallet passphrase, be long enough, and be typed twice the same', async () => {
    process.env.BWALLETX_PASSPHRASE = PIN;
    await expect(og.setupOwner(env({ answers: [PIN, PIN] }))).rejects.toThrow(/different from the wallet passphrase/);
    delete process.env.BWALLETX_PASSPHRASE;
    await expect(og.setupOwner(env({ answers: ['short', 'short'] }))).rejects.toThrow(/at least 8/);
    await expect(og.setupOwner(env({ answers: [PIN, PIN + 'x'] }))).rejects.toThrow(/don't match/);
    await setupPin();
    await expect(setupPin()).rejects.toThrow(/already set/);
  });

  test('changing the PIN needs the old one; the old one stops working', async () => {
    await setupPin();
    await og.setCap('t', '40', env({ answers: [PIN] }));
    await og.ownerChange(env({ answers: [PIN, 'another long pin', 'another long pin'] }));
    await expect(og.setCap('t', '60', env({ answers: [PIN] }))).rejects.toThrow(/Wrong owner PIN/);
    await og.setCap('t', '60', env({ answers: ['another long pin'] }));
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBe(60);
  });
});

describe('tightening needs no PIN, from anywhere', () => {
  test('lower cap / rate / approve-above and stop work with no TTY, under MCP, with no PIN', async () => {
    await setupPin();
    const agent = env({ stdinTTY: false, stdoutTTY: false, underMcp: true });
    expect(await og.setCap('t', '5', agent)).toBe('t: daily cap $5');
    expect(await og.setRateLimit('t', '10', agent)).toMatch(/at most 10/);
    expect(await og.setApproveAbove('t', '1', agent)).toMatch(/over \$1/);
    expect(effectiveAccount(cfgAcct())).toMatchObject({ dailyCapUsd: 5, ratePerHour: 10, approveAboveUsd: 1 });
    expect(og.lowerCap('t', 3)).toBe('t: daily cap $3');
    expect(() => og.lowerCap('t', 4)).toThrow(/can only lower/);
    og.stopAllAgents('test');
    expect(allStopped()).toBe(true);
    expect(agent.asked).toEqual([]);
  });

  test('but raising back up again is loosening', async () => {
    await setupPin();
    await og.setCap('t', '5', env({ stdinTTY: false }));
    await expect(og.setCap('t', '8', env({ stdinTTY: false }))).rejects.toThrow(/interactive terminal/);
  });
});

describe('hand edits to the settings files never loosen anything', () => {
  test('editing config.json is capped by the signed ceiling', async () => {
    await og.setCap('t', '50', env({ answers: [PIN, PIN, PIN] })); // first loosening offers setup, then signs
    const c = readConfig();
    c.accounts.t = { ...c.accounts.t, dailyCapUsd: null, ratePerHour: 0, approveAboveUsd: null };
    writeConfig(c);
    expect(effectiveAccount(cfgAcct())).toMatchObject({ dailyCapUsd: 50, ratePerHour: 30, approveAboveUsd: null });
  });

  test('a tampered signature (or a missing settings file) is the most restrictive state: stopped, default caps', async () => {
    await setupPin();
    await og.setCap('t', '500', env({ answers: [PIN] }));
    expect(send(100).ok).toBe(true);
    const s = settings();
    s.accounts.t.dailyCapUsd = null;
    s.accounts.t.ratePerHour = 0;
    writeFileSync(settingsPath(), JSON.stringify(s));
    expect(readOwnerState()).toMatchObject({ state: 'tampered' });
    expect(allStopped()).toBe(true);
    expect(effectiveAccount(cfgAcct())).toMatchObject({ dailyCapUsd: 10, ratePerHour: 30, stopped: true });
    expect(send(1)).toMatchObject({ ok: false, rule: 'stop' });
    rmSync(settingsPath());
    expect(readOwnerState()).toMatchObject({ state: 'tampered', why: /missing/ });
    expect(send(1)).toMatchObject({ ok: false, rule: 'stop' });
    rmSync(join(dir, 'owner.json'));
    writeFileSync(settingsPath(), JSON.stringify(s));
    expect(readOwnerState()).toMatchObject({ state: 'tampered', why: /owner.json is missing/ });
  });

  test('after a tamper, resume with the PIN falls back to the defaults, not the edited values', async () => {
    await setupPin();
    await og.setCap('t', '500', env({ answers: [PIN] }));
    const s = settings();
    s.accounts.t.dailyCapUsd = 9999;
    writeFileSync(settingsPath(), JSON.stringify(s));
    const e = env({ answers: [PIN] });
    await og.resumeAll(e);
    expect(e.said.join('\n')).toMatch(/safe defaults/);
    expect(readOwnerState().state).toBe('ok');
    expect(allStopped()).toBe(false);
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBe(10);
  });

  test('deleting the STOP file does not resume; resume with the PIN keeps the signed limits', async () => {
    await setupPin();
    await og.setCap('t', '50', env({ answers: [PIN] }));
    og.stopAllAgents('MCP');
    rmSync(join(dir, 'STOP'));
    expect(allStopped()).toBe(true);
    // putting stopAll back to false by hand doesn't restore the signature either
    writeFileSync(settingsPath(), JSON.stringify({ ...settings(), stopAll: false }));
    expect(allStopped()).toBe(true);
    await expect(og.resumeAll(env({ stdinTTY: false }))).rejects.toThrow(/interactive terminal/);
    writeFileSync(settingsPath(), JSON.stringify({ ...settings(), stopAll: true }));
    await og.resumeAll(env({ answers: [PIN] }));
    expect(allStopped()).toBe(false);
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBe(50);
  });
});

describe('upgrade from 0.5.x: no PIN yet = default-restrictive mode', () => {
  const live = (): Loaded => ({ strategy: { ...exampleStrategy('BSV'), rules: { tokens: ['BSV'], actions: ['send'], sendTo: ['1X'], maxPerTradeUsd: 100 } }, mode: 'live', loadedAt: NOW - 1000 });

  test('old settings with no MAC are clamped to the defaults and live strategies are refused', () => {
    writeConfig({ accounts: { t: acct({ dailyCapUsd: null, ratePerHour: 0 }) }, defaultAccount: 't' });
    setLoaded('t', live());
    expect(readOwnerState().state).toBe('unset');
    expect(allStopped()).toBe(false);
    expect(effectiveAccount(cfgAcct())).toMatchObject({ dailyCapUsd: 10, ratePerHour: 30 });
    expect(send(1)).toMatchObject({ ok: false, rule: 'owner' });
  });

  test('setting the PIN at a terminal and approving signs the existing settings, live strategy included', async () => {
    writeConfig({ accounts: { t: acct({ dailyCapUsd: 25 }) }, defaultAccount: 't' });
    setLoaded('t', live());
    await og.setupOwner(env({ answers: [PIN, PIN], yes: true }));
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBe(25);
    expect(send(1).ok).toBe(true);
  });

  test('declining signs the safe defaults instead', async () => {
    writeConfig({ accounts: { t: acct({ dailyCapUsd: null }) }, defaultAccount: 't' });
    setLoaded('t', live());
    await og.setupOwner(env({ answers: [PIN, PIN], yes: false }));
    expect(effectiveAccount(cfgAcct()).dailyCapUsd).toBe(10);
    expect(send(1)).toMatchObject({ ok: false, rule: 'owner' });
  });

  test('a live strategy edited by hand after approval is refused', async () => {
    setLoaded('t', live());
    await setupPin();
    expect(send(1).ok).toBe(true);
    const f = join(dir, 'strategies', 't.json');
    const l = JSON.parse(readFileSync(f, 'utf8'));
    l.strategy.rules.maxPerTradeUsd = 1e6;
    writeFileSync(f, JSON.stringify(l));
    expect(send(1)).toMatchObject({ ok: false, rule: 'owner' });
  });
});

describe('approve-above cannot be bypassed', () => {
  test('owner-signed threshold holds even when config.json clears it, and the PIN approves no spends', async () => {
    await setupPin();
    await og.setCap('t', '100', env({ answers: [PIN] }));
    await og.setApproveAbove('t', '2', env({ stdinTTY: false })); // tightening: free
    // now sign it as the ceiling, then clear it by hand in config.json
    await og.ownerSign(env({ answers: [PIN], yes: true }));
    const c = readConfig();
    c.accounts.t.approveAboveUsd = null;
    writeConfig(c);
    expect(send(3)).toMatchObject({ ok: false, rule: 'approval' });
    expect(send(1.5).ok).toBe(true);
    // the session object has no way to approve a spend: only settings
    const s = await og.requireOwner('test', env({ answers: [PIN] }));
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(s)).sort()).toEqual(['base', 'close', 'constructor', 'kind', 'publicKey', 'update']);
    expect(send(3)).toMatchObject({ ok: false, rule: 'approval' });
  });
});

describe('default cap for new accounts', () => {
  test('a newly imported key-file account gets the $10/day default', async () => {
    writeConfig({ accounts: {} });
    const k = { payPk: PrivateKey.fromRandom().toWif(), ordPk: PrivateKey.fromRandom().toWif(), identityPk: PrivateKey.fromRandom().toWif() };
    const f = join(dir, 'new.key.json');
    writeFileSync(f, JSON.stringify(await encryptKeyFile('fresh', PrivateKey.fromWif(k.identityPk).toAddress(), k, 'throwaway pass', 100_000)));
    const a = await importKey(f, 'throwaway pass');
    expect(a.dailyCapUsd).toBe(DEFAULT_DAILY_CAP_USD);
    expect(DEFAULT_DAILY_CAP_USD).toBe(10);
    expect(existsSync(join(dir, 'accounts', 'fresh.key.json'))).toBe(true);
  });
});
