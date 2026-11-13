import { beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateAction, reserveSpend, watchBroadcast } from './gate';
import { addReservation, readLog, readReservations, setAllStopped, writeConfig, type AccountConfig } from './store';

const acct = (p: Partial<AccountConfig> = {}): AccountConfig => ({
  name: 't', identityAddress: '1Id', payAddress: '1Pay', ordAddress: '1Ord', dailyCapUsd: 5, stopped: false, importedAt: Date.now() - 1e7, ...p,
});
const send = (usd: number) => ({ kind: 'send' as const, token: 'BSV', usd, to: '1Dest' });

describe('reserveSpend: gate and reserve in one step, before signing', () => {
  beforeEach(() => {
    process.env.BWALLETX_HOME = mkdtempSync(join(tmpdir(), 'bwx-res-'));
    writeConfig({ accounts: { t: acct() }, defaultAccount: 't' });
  });

  test('parallel spends cannot all pass the daily cap', async () => {
    const all = await Promise.all(Array.from({ length: 5 }, () => reserveSpend('t', send(2))));
    expect(all.filter((r) => r.ok)).toHaveLength(2);
    expect(all.filter((r) => !r.ok).map((r) => !r.ok && r.reason)).toEqual(Array(3).fill(expect.stringMatching(/Over today's cap/)));
    expect(readReservations('t')).toHaveLength(2);
  });

  test('release frees the dollars; settle logs the outcome and drops the reservation', async () => {
    const a = await reserveSpend('t', send(4));
    expect(a.ok).toBe(true);
    expect((await reserveSpend('t', send(2))).ok).toBe(false);
    if (a.ok) a.release();
    const b = await reserveSpend('t', send(4));
    expect(b.ok).toBe(true);
    if (b.ok) b.settle({ at: Date.now(), action: 'send', detail: 'sent', usd: 4, txid: 'aa' });
    expect(readReservations('t')).toEqual([]);
    expect(readLog('t').filter((e) => e.usd > 0)).toEqual([expect.objectContaining({ action: 'send', usd: 4 })]);
    expect((await reserveSpend('t', send(2))).ok).toBe(false);
  });

  test("another live process's reservation counts in every gate", () => {
    addReservation('t', { id: 'x', pid: process.ppid, at: Date.now(), action: 'reserved', detail: 'other process', usd: 4 });
    expect(gateAction('t', send(2))).toMatchObject({ ok: false, rule: 'dailyCap' });
  });

  test('a reservation left by a crashed process stays counted, as a failed entry', async () => {
    addReservation('t', { id: 'dead', pid: 999_999, at: Date.now(), action: 'reserved', detail: 'Reserved send BSV', usd: 4 });
    expect((await reserveSpend('t', send(2))).ok).toBe(false);
    expect(readReservations('t')).toEqual([]);
    expect(readLog('t')).toContainEqual(expect.objectContaining({ action: 'failed', usd: 4 }));
  });

  test('kill switch: nothing is reserved', async () => {
    setAllStopped(true);
    expect(await reserveSpend('t', send(1))).toMatchObject({ ok: false, reason: 'All agents are stopped' });
    setAllStopped(false);
    expect(readReservations('t')).toEqual([]);
  });

  test('reservations count toward the rate limit', () => {
    writeConfig({ accounts: { t: acct({ dailyCapUsd: null, ratePerHour: 1 }) }, defaultAccount: 't' });
    addReservation('t', { id: 'r', pid: process.pid, at: Date.now(), action: 'reserved', detail: 'in flight', usd: 0.5 });
    expect(gateAction('t', send(0.5))).toMatchObject({ ok: false, rule: 'rateLimit' });
  });
});

describe('OpNS name transfers go through the same gate', () => {
  beforeEach(() => {
    process.env.BWALLETX_HOME = mkdtempSync(join(tmpdir(), 'bwx-opns-'));
    writeConfig({ accounts: { t: acct({ dailyCapUsd: 15 }) }, defaultAccount: 't' });
  });

  test('stopped, over the cap, or reserved and counted at the name tier', async () => {
    const { nameMove } = await import('./opns/headless');
    setAllStopped(true);
    expect(await nameMove('t', 'alice', '1Owner')).toEqual({ refused: 'Refused: All agents are stopped' });
    setAllStopped(false);
    const a = await nameMove('t', 'alice', '1Owner'); // 5+ characters: $10
    expect('refused' in a).toBe(false);
    expect(await nameMove('t', 'bobby', '1Owner')).toEqual({ refused: expect.stringMatching(/Over today's cap/) });
    if ('refused' in a) return;
    a.sending();
    a.sent('opns-send', 'alice → 1Owner', 'cc'.repeat(32));
    a.end();
    expect(readReservations('t')).toEqual([]);
    expect(readLog('t')).toContainEqual(expect.objectContaining({ action: 'opns-send', usd: 10 }));
    expect(await nameMove('t', 'bobby', '1Owner')).toEqual({ refused: expect.stringMatching(/Over today's cap/) });
  });

  test('released when nothing was sent; counted when a send may have gone out', async () => {
    writeConfig({ accounts: { t: acct({ dailyCapUsd: 25 }) }, defaultAccount: 't' });
    const { nameMove } = await import('./opns/headless');
    const a = await nameMove('t', 'alice', '1Owner');
    if ('refused' in a) throw new Error(a.refused);
    a.end();
    expect(readReservations('t')).toEqual([]);
    const b = await nameMove('t', 'bobby', '1Owner');
    if ('refused' in b) throw new Error(b.refused);
    b.sending();
    b.end();
    expect(readLog('t')).toContainEqual(expect.objectContaining({ action: 'failed', usd: 10 }));
  });
});

describe('an error after broadcast stays counted (review fix)', () => {
  beforeEach(() => {
    process.env.BWALLETX_HOME = mkdtempSync(join(tmpdir(), 'bwx-bc-'));
    writeConfig({ accounts: { t: acct({ dailyCapUsd: 25 }) }, defaultAccount: 't' });
  });

  test('nameMove: a send that failed after it may have gone out is counted; one that never reached the signer is released', async () => {
    const { nameMove } = await import('./opns/headless');
    const b = await nameMove('t', 'bobby', '1Owner');
    if ('refused' in b) throw new Error(b.refused);
    b.sending();
    b.failed(false);
    b.end();
    expect(readReservations('t')).toEqual([]);
    expect(readLog('t').filter((e) => e.usd > 0)).toEqual([]);
    const a = await nameMove('t', 'alice', '1Owner');
    if ('refused' in a) throw new Error(a.refused);
    a.sending();
    a.failed(true);
    a.end();
    expect(readReservations('t')).toEqual([]);
    expect(readLog('t')).toContainEqual(expect.objectContaining({ action: 'failed', usd: 10 }));
  });

  test('nameMove values an unreadable name at the price it is given (the sweep passes the top tier)', async () => {
    const { nameMove } = await import('./opns/headless');
    const { TOP_TIER_USD } = await import('./opns/batch');
    // The $10 tier its outpoint would have got fits today's cap; the top tier does not.
    expect(await nameMove('t', `${'d'.repeat(64)}.0`, '1Owner', TOP_TIER_USD)).toEqual({ refused: expect.stringMatching(/Over today's cap/) });
  });

  test('watchBroadcast: only a deferred createAction that threw or left a signable tx is "not sent"', async () => {
    const fail = async () => {
      throw new Error('nope');
    };
    const w1 = watchBroadcast({ createAction: fail });
    await expect(w1.wallet.createAction({ options: { signAndProcess: false } })).rejects.toThrow('nope');
    expect(w1.mayHaveBroadcast()).toBe(false);

    const w2 = watchBroadcast({ createAction: async () => ({ signableTransaction: { reference: 'r' } }), signAction: fail });
    await w2.wallet.createAction({ options: { signAndProcess: false } });
    expect(w2.mayHaveBroadcast()).toBe(false);
    await expect(w2.wallet.signAction()).rejects.toThrow('nope');
    expect(w2.mayHaveBroadcast()).toBe(true);

    const w3 = watchBroadcast({ createAction: fail });
    await expect(w3.wallet.createAction({})).rejects.toThrow('nope'); // signs and processes by default
    expect(w3.mayHaveBroadcast()).toBe(true);

    const w4 = watchBroadcast({ createAction: async () => ({ txid: 'aa' }), listOutputs: async () => 1 });
    expect(await w4.wallet.listOutputs()).toBe(1);
    expect(w4.mayHaveBroadcast()).toBe(false);
    await w4.wallet.createAction({ options: { signAndProcess: false } });
    expect(w4.mayHaveBroadcast()).toBe(true);
  });
});
