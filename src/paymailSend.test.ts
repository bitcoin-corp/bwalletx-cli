/**
 * Paying a paymail: the outputs a P2P payment-destination host returns must add up to exactly the amount asked for,
 * be standard P2PKH and be few. Anything else is refused before signing; nothing reaches a broadcaster.
 * Offline: a fake paymail host and a fake indexer stand in for the network. Throwaway keys only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { checkPaymentOutputs, MAX_PAYMAIL_OUTPUTS, PaymentOutputMismatch, resolveDestination } from './wallet.js';

const HOST = 'pay.example.test';
const TO = `bob@${HOST}`;
const PASS = 'test-passphrase-1';
const p2pkh = () => new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex();

type Out = { script: unknown; satoshis: unknown };
type Calls = { destRequests: unknown[]; posts: string[]; coinLookups: number };

/**
 * A fake network: WhatsOnChain price/UTXOs/raw txs for `payAddress`, and a paymail host whose P2P destination
 * returns `outputs`. Every other POST (ARC, WhatsOnChain broadcast, the P2P receive endpoint) is recorded.
 */
function fakeNetwork(outputs: Out[] | ((asked: number) => Out[]), opts: { payAddress?: string; basic?: string } = {}): Calls {
  const calls: Calls = { destRequests: [], posts: [], coinLookups: 0 };
  const parent = new Transaction();
  if (opts.payAddress) parent.addOutput({ lockingScript: new P2PKH().lock(opts.payAddress), satoshis: 50_000_000 });
  const pid = parent.id('hex');
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as Request).url);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/exchangerate')) return json({ rate: 50 });
    if (url === `https://${HOST}/.well-known/bsvalias`) {
      const capabilities: Record<string, string> = opts.basic
        ? { paymentDestination: `https://${HOST}/basic/{alias}@{domain.tld}` }
        : { '2a40af698840': `https://${HOST}/p2p/{alias}@{domain.tld}`, '5f1323cddf31': `https://${HOST}/receive/{alias}@{domain.tld}` };
      return json({ bsvalias: '1.0', capabilities });
    }
    if (url === `https://${HOST}/p2p/bob@${HOST}`) {
      const body = JSON.parse(String(init?.body)) as { satoshis: number };
      calls.destRequests.push(body);
      return json({ outputs: typeof outputs === 'function' ? outputs(body.satoshis) : outputs, reference: 'ref-1' });
    }
    if (url === `https://${HOST}/basic/bob@${HOST}`) return json({ output: opts.basic });
    if (url.endsWith('/unspent')) return calls.coinLookups++, json([{ tx_hash: pid, tx_pos: 0, value: 50_000_000, height: 1 }]);
    if (url.endsWith(`/tx/${pid}/hex`)) return new Response(parent.toHex());
    if (method === 'POST') {
      calls.posts.push(url);
      return new Response(url.includes('/receive/') ? '{}' : 'nope', { status: url.includes('/receive/') ? 200 : 500 });
    }
    return new Response('not found', { status: 404 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('checkPaymentOutputs', () => {
  test('exact match passes (one or several P2PKH outputs)', () => {
    const a = p2pkh();
    expect(checkPaymentOutputs(TO, [{ script: a.toUpperCase(), satoshis: 1000 }], 1000)).toEqual([{ script: a, satoshis: 1000 }]);
    expect(checkPaymentOutputs(TO, [{ script: p2pkh(), satoshis: 600 }, { script: p2pkh(), satoshis: 400 }], 1000)).toHaveLength(2);
  });

  test('more than requested is refused and says requested vs returned', () => {
    const run = () => checkPaymentOutputs(TO, [{ script: p2pkh(), satoshis: 1000 }, { script: p2pkh(), satoshis: 49_000_000 }], 1000);
    expect(run).toThrow(PaymentOutputMismatch);
    expect(run).toThrow(/more than the amount requested.*Requested 1000 sats; the paymail host returned 49001000 sats in 2 outputs\. Nothing was sent\./);
  });

  test('less than requested is refused', () => {
    expect(() => checkPaymentOutputs(TO, [{ script: p2pkh(), satoshis: 999 }], 1000)).toThrow(/less than the amount requested.*Requested 1000 sats; the paymail host returned 999 sats/);
  });

  test('non-P2PKH scripts are refused', () => {
    for (const script of ['006a0568656c6c6f', '51', 'a914' + '00'.repeat(20) + '87', p2pkh() + '00', 'not hex', 42, undefined]) {
      expect(() => checkPaymentOutputs(TO, [{ script, satoshis: 1000 }], 1000)).toThrow(/not a standard P2PKH script/);
    }
  });

  test('zero, negative, fractional or non-number amounts are refused', () => {
    for (const satoshis of [0, -5, 1.5, '1000', null, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => checkPaymentOutputs(TO, [{ script: p2pkh(), satoshis }, { script: p2pkh(), satoshis: 1000 }], 1000)).toThrow(/invalid amount/);
    }
  });

  test('too many outputs are refused, even when they add up', () => {
    const n = MAX_PAYMAIL_OUTPUTS + 1;
    const outs = Array.from({ length: n }, () => ({ script: p2pkh(), satoshis: 10 }));
    expect(() => checkPaymentOutputs(TO, outs, 10 * n)).toThrow(new RegExp(`more than ${MAX_PAYMAIL_OUTPUTS} outputs`));
    expect(checkPaymentOutputs(TO, outs.slice(0, MAX_PAYMAIL_OUTPUTS), 10 * MAX_PAYMAIL_OUTPUTS)).toHaveLength(MAX_PAYMAIL_OUTPUTS);
  });

  test('no outputs or a malformed answer is refused', () => {
    for (const outputs of [[], undefined, null, 'x', {}, [null]]) expect(() => checkPaymentOutputs(TO, outputs, 1000)).toThrow(PaymentOutputMismatch);
  });
});

describe('resolveDestination with a fake paymail host', () => {
  test('P2P: exact match is returned with the reference', async () => {
    const script = p2pkh();
    const calls = fakeNetwork([{ script, satoshis: 1234 }]);
    const d = await resolveDestination(TO, 1234, 'me');
    expect(calls.destRequests).toEqual([{ satoshis: 1234 }]);
    expect(d.outputs).toEqual([{ script, satoshis: 1234 }]);
    expect(d.p2p).toEqual({ url: `https://${HOST}/receive/bob@${HOST}`, reference: 'ref-1' });
  });

  test('P2P: more, less, non-P2PKH and too many outputs are refused', async () => {
    fakeNetwork([{ script: p2pkh(), satoshis: 5000 }]);
    await expect(resolveDestination(TO, 1234, 'me')).rejects.toThrow(/Requested 1234 sats; the paymail host returned 5000 sats/);
    fakeNetwork([{ script: p2pkh(), satoshis: 1000 }]);
    await expect(resolveDestination(TO, 1234, 'me')).rejects.toThrow(/less than the amount requested/);
    fakeNetwork([{ script: '006a', satoshis: 1234 }]);
    await expect(resolveDestination(TO, 1234, 'me')).rejects.toThrow(/not a standard P2PKH script/);
    fakeNetwork(Array.from({ length: 11 }, () => ({ script: p2pkh(), satoshis: 1 })));
    await expect(resolveDestination(TO, 11, 'me')).rejects.toThrow(/more than 10 outputs/);
  });

  test('basic paymentDestination: a non-P2PKH script is refused, a P2PKH one is paid the requested amount', async () => {
    fakeNetwork([], { basic: '51' });
    await expect(resolveDestination(TO, 1234, 'me')).rejects.toThrow(/not a standard P2PKH script/);
    const script = p2pkh();
    fakeNetwork([], { basic: script });
    expect((await resolveDestination(TO, 1234, 'me')).outputs).toEqual([{ script, satoshis: 1234 }]);
  });
});

describe('send() to a paymail (key-file account, live)', () => {
  let dir = '';
  let payAddress = '';
  const NAME = 'pm-test';
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bwx-paymail-'));
    process.env.BWALLETX_HOME = dir;
    const { newKey } = await import('./actions.js');
    const acct = await newKey(NAME, join(dir, 'pm-test.agentkey.json'), PASS);
    payAddress = acct.payAddress;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // $0.50 at $50/BSV = 1,000,000 sats.
  const ASKED = 1_000_000;

  test('exact match: signs, hands the tx to the payee host, pays exactly the requested amount', async () => {
    const script = p2pkh();
    const calls = fakeNetwork([{ script, satoshis: ASKED }], { payAddress });
    const { send } = await import('./actions.js');
    const r = await send(0.5, TO, NAME, { passphrase: PASS });
    expect(r.ok).toBe(true);
    expect(r.sats).toBe(ASKED);
    expect(calls.destRequests).toEqual([{ satoshis: ASKED }]);
    expect(calls.posts[0]).toBe(`https://${HOST}/receive/bob@${HOST}`);
  });

  test.each([
    ['more than requested', (n: number) => [{ script: p2pkh(), satoshis: n }, { script: p2pkh(), satoshis: 40_000_000 }], /Requested 1000000 sats; the paymail host returned 41000000 sats/],
    ['less than requested', (n: number) => [{ script: p2pkh(), satoshis: n - 1 }], /less than the amount requested/],
    ['a non-P2PKH script', (n: number) => [{ script: '006a04deadbeef', satoshis: n }], /not a standard P2PKH script/],
    ['too many outputs', (n: number) => Array.from({ length: 20 }, () => ({ script: p2pkh(), satoshis: n / 20 })), /more than 10 outputs/],
  ])('%s: refused, nothing signed or broadcast, nothing counted against the cap', async (_label, outs, why) => {
    const calls = fakeNetwork(outs, { payAddress });
    const { send, log } = await import('./actions.js');
    const r = await send(0.5, TO, NAME, { passphrase: PASS });
    expect(r.ok).toBe(false);
    expect(r.txid).toBeUndefined();
    expect(r.text).toMatch(why);
    expect(r.text).toMatch(/Nothing was sent/);
    expect(calls.coinLookups).toBe(0); // refused before a transaction was even started, so nothing was signed
    expect(calls.posts).toEqual([]); // no ARC, no WhatsOnChain broadcast, no P2P receive
    const last = (await log(NAME, 1))[0]!;
    expect(last.action).toBe('failed');
    expect(last.usd).toBe(0);
  });
});
