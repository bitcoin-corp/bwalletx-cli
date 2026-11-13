/**
 * serve over a REAL @bsv/wallet-toolbox Wallet (SQLite in a temp dir), with mocked services (13 Nov 2026 review
 * harness). Nothing touches the network: postBeef is recorded, the chain tracker says yes.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'bwx-review-'));
process.env.BWALLETX_HOME = dir;
const { writeConfig, readLog } = await import('./store');
const { serve, storageTxStatus } = await import('./brc100');
const { issueToken } = await import('./servePairing');
const require = createRequire(import.meta.url);
const sdk = require('@bsv/sdk');
const toolbox = require('@bsv/wallet-toolbox');
const { PrivateKey, KeyDeriver, P2PKH, Transaction, MerklePath, Beef, Utils } = sdk;
void Transaction;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const posted: string[][] = [];
const unknownCalls = new Set<string>();
function mockServices() {
  const tracker = { isValidRootForHeight: async () => true, currentHeight: async () => 900_000 };
  const impl: Record<string, unknown> = {
    chain: 'main',
    getChainTracker: async () => tracker,
    getHeight: async () => 900_000,
    getBsvExchangeRate: async () => 50,
    getFiatExchangeRate: async () => 1,
    getStatusForTxids: async (txids: string[]) => ({ name: 'mock', status: 'success', results: txids.map((txid) => ({ txid, status: 'unknown', depth: undefined })) }),
    postBeef: async (beef: unknown, txids: string[]) => {
      posted.push([...txids]);
      return [{ name: 'mock', status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) }];
    },
    nLockTimeIsFinal: async () => true,
    getMerklePath: async () => ({ name: 'mock', notes: [] }),
    getRawTx: async (txid: string) => ({ txid, name: 'mock' }),
    getHeaderForHeight: async () => new Array(80).fill(0),
    hashOutputScript: (s: string) => Utils.toHex(sdk.Hash.sha256(Utils.toArray(s, 'hex')).reverse()),
    isUtxo: async () => true,
    getUtxoStatus: async () => ({ name: 'mock', status: 'success', isUtxo: true, details: [] }),
    getServicesCallHistory: () => ({}),
    updateBsvExchangeRate: async () => ({ rate: 50, base: 'USD', timestamp: new Date() }),
  };
  return new Proxy(impl, {
    get(t, p: string) {
      if (p in t) return t[p];
      if (typeof p === 'string' && p !== 'then') unknownCalls.add(p);
      return undefined;
    },
  });
}

async function makeWallet(mode?: 'legacy') {
  const root = PrivateKey.fromRandom();
  const kd = new KeyDeriver(root);
  const storage = new toolbox.WalletStorageManager(kd.identityKey);
  const services = mockServices();
  const knex = toolbox.Setup.createSQLiteKnex(join(dir, `w${Math.random().toString(36).slice(2)}.sqlite`));
  const active = new toolbox.StorageKnex({ chain: 'main', knex, commissionSatoshis: 0, commissionPubKeyHex: undefined, feeModel: { model: 'sat/kb', value: 100 } });
  await active.migrate('review', kd.identityKey);
  await active.makeAvailable();
  await storage.addWalletStorageProvider(active);
  const wallet = new toolbox.Wallet({ chain: 'main', keyDeriver: kd, storage, services, ...(mode && { actionBatchMode: mode }) });
  // Fund: a proven tx paying a BRC-29 wallet payment output, internalized.
  const derivationPrefix = Utils.toBase64(Utils.toArray('prefix01', 'utf8'));
  const derivationSuffix = Utils.toBase64(Utils.toArray('suffix01', 'utf8'));
  const sender = PrivateKey.fromRandom();
  const { publicKey } = await wallet.getPublicKey({ protocolID: [2, '3241645161d8'], keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: sender.toPublicKey().toString(), forSelf: true });
  const lock = new P2PKH().lock(sdk.PublicKey.fromString(publicKey).toAddress());
  const fund = new Transaction();
  fund.addInput({ sourceTXID: 'ab'.repeat(32), sourceOutputIndex: 0, unlockingScript: new sdk.Script(), sequence: 0xffffffff });
  for (let i = 0; i < 6; i++) fund.addOutput({ lockingScript: lock, satoshis: 5_000_000 });
  const txid = fund.id('hex');
  fund.merklePath = new MerklePath(800_000, [[{ offset: 0, hash: txid, txid: true }]]);
  const beef = new Beef();
  beef.mergeTransaction(fund);
  await wallet.internalizeAction({
    tx: beef.toBinaryAtomic(txid),
    outputs: [0, 1, 2, 3, 4, 5].map((outputIndex) => ({ outputIndex, protocol: 'wallet payment', paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: sender.toPublicKey().toString() } })),
    description: 'fund the wallet',
  });
  return { wallet, knex, active };
}

let acct = 0;
/** Per send step (a sendWith-only createAction), in order: 'throw' fails it before the wallet sees it, 'pass' lets it through. */
const ctl = { plan: [] as ('throw' | 'pass')[] };
async function setup(origins = ['shop.example'], caps: Record<string, number> = { maxUsdPerAction: 100, sessionBudgetUsd: 1000 }, mode?: 'legacy') {
  const account = `r${++acct}`;
  writeConfig({ accounts: { [account]: { name: account, kind: 'paired', identityAddress: '1x', payAddress: '', ordAddress: '', dailyCapUsd: null, stopped: false, importedAt: Date.now() } }, defaultAccount: account } as never);
  const { wallet, knex, active } = await makeWallet(mode);
  const api = wallet as unknown as Record<string, (a: unknown, o?: string) => Promise<unknown>>;
  const call = async (m: string, a: any, site: string) => {
    // Test control: the next send step (a sendWith-only createAction) fails as if storage threw.
    if (ctl.plan.length && m === 'createAction' && a?.options?.sendWith?.length && !a.outputs?.length) {
      if (ctl.plan.shift() === 'throw') throw new Error('simulated storage failure on send');
    }
    return api[m](a, site);
  };
  const w = { paired: false, call, owned: async () => new Set<string>(), txStatus: storageTxStatus(wallet), close: async () => undefined };
  const relayed: string[] = [];
  const events: string[] = [];
  const server = await serve(w, { account, origins, port: 0, arc: async (r) => void relayed.push(r.txid), usdPerBsv: async () => 50, onEvent: (l) => events.push(l), ...caps });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (method: string, body: unknown, origin = origins[0]) => {
    const r = await fetch(`${url}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `https://${origin}`, Authorization: `Bearer ${issueToken(origin)}` }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const status = async (txid: string) => ((await knex('transactions').where({ txid }).first()) as { status?: string } | undefined)?.status;
  return { post, relayed, settle, server, wallet, knex, events, status, account, active };
}
const dest = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex();
const pay = (sats: number, options: Record<string, unknown> = {}) => ({ description: 'review payment', outputs: [{ lockingScript: dest, satoshis: sats, outputDescription: 'pay the shop' }], options });

const balance = async (wallet: any) => ((await wallet.listOutputs({ basket: 'default', limit: 1000 })) as { outputs: { satoshis: number }[] }).outputs.reduce((n, x) => n + x.satoshis, 0);
const blob = (bytes: number) => '006a4e' + Buffer.from(Uint32Array.of(bytes).buffer).toString('hex') + 'ab'.repeat(bytes);

describe('serve over the real toolbox', () => {
  it('a noSend build is returned, held (nosend in the wallet) and never relayed', async () => {
    const s = await setup();
    const r = await s.post('createAction', pay(1000, { noSend: true }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sendWithResults).toEqual([]);
    await s.settle();
    expect(s.relayed).toEqual([]);
    expect(posted.flat()).not.toContain(r.body.txid);
    s.server.close();
  });

  it('a normal createAction (delayed by default) is sent and relayed once', async () => {
    const s = await setup();
    const r = await s.post('createAction', pay(1000));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sendWithResults).toEqual([{ txid: r.body.txid, status: 'sending' }]);
    expect(r.body.noSendChange).toBeUndefined();
    await s.settle();
    expect(s.relayed).toEqual([r.body.txid]);
    expect(await s.status(r.body.txid)).not.toBe('nosend');
    s.server.close();
  });

  it('acceptDelayedBroadcast:false is posted at once and relayed', async () => {
    const s = await setup();
    const r = await s.post('createAction', pay(1000, { acceptDelayedBroadcast: false }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sendWithResults).toEqual([{ txid: r.body.txid, status: 'unproven' }]);
    expect(posted.at(-1)).toContain(r.body.txid);
    await s.settle();
    expect(s.relayed).toEqual([r.body.txid]);
    s.server.close();
  });

  it('two-phase: build noSend, then sendWith sends and relays exactly the build', async () => {
    const s = await setup();
    const a = await s.post('createAction', pay(1000, { noSend: true }));
    const c = await s.post('createAction', { description: 'send the batch', options: { sendWith: [a.body.txid] } });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.sendWithResults).toEqual([{ txid: a.body.txid, status: 'sending' }]);
    await s.settle();
    expect(s.relayed).toEqual([a.body.txid]);
    s.server.close();
  });

  it('noSend + sendWith in one createAction sends only the sendWith txids; the new tx stays nosend', async () => {
    const s = await setup();
    const a = await s.post('createAction', pay(1000, { noSend: true }));
    const b = await s.post('createAction', pay(1000, { noSend: true, sendWith: [a.body.txid] }));
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    await s.settle();
    expect(s.relayed).toEqual([a.body.txid]);
    expect(await s.status(b.body.txid)).toBe('nosend');
    s.server.close();
  });

  it('signAction inherits noSend from its createAction; noSend:false on signAction sends; a late noSend holds', async () => {
    const s = await setup();
    const c1 = await s.post('createAction', pay(1000, { noSend: true, signAndProcess: false }));
    expect(c1.status, JSON.stringify(c1.body)).toBe(200);
    const s1 = await s.post('signAction', { reference: c1.body.signableTransaction.reference, spends: {} });
    expect(s1.status, JSON.stringify(s1.body)).toBe(200);
    await s.settle();
    expect(s.relayed).toEqual([]);
    expect(posted.flat()).not.toContain(s1.body.txid);
    const c2 = await s.post('createAction', pay(1000, { noSend: true, signAndProcess: false }));
    const s2 = await s.post('signAction', { reference: c2.body.signableTransaction.reference, spends: {}, options: { noSend: false } });
    expect(s2.status, JSON.stringify(s2.body)).toBe(200);
    await s.settle();
    expect(s.relayed).toEqual([s2.body.txid]);
    const c3 = await s.post('createAction', pay(1000, { signAndProcess: false }));
    const s3 = await s.post('signAction', { reference: c3.body.signableTransaction.reference, spends: {}, options: { noSend: true } });
    expect(s3.status, JSON.stringify(s3.body)).toBe(200);
    await s.settle();
    expect(s.relayed).toEqual([s2.body.txid]);
    s.server.close();
  });

  it("another site can't sendWith or abort a site's held build", async () => {
    const s = await setup(['a.example', 'b.example']);
    const a = await s.post('createAction', pay(1000, { noSend: true }), 'a.example');
    expect(a.status).toBe(200);
    expect((await s.post('createAction', { description: 'B sends A build', options: { sendWith: [a.body.txid] } }, 'b.example')).status).toBe(400);
    expect((await s.post('abortAction', { reference: a.body.txid }, 'b.example')).status).toBe(400);
    await s.settle();
    expect(s.relayed).toEqual([]);
    expect(posted.flat()).not.toContain(a.body.txid);
    s.server.close();
  });

  it('a noSend build made outside serve (another app on the same wallet) is not sent by a site', async () => {
    const s = await setup();
    const other = (await s.wallet.createAction({ description: 'another app build', outputs: [{ lockingScript: dest, satoshis: 4_000_000, outputDescription: 'big payment' }], options: { noSend: true } }, 'other.app')) as { txid: string };
    const c = await s.post('createAction', { description: 'site sends it', options: { sendWith: [other.txid] } });
    expect(c.status).toBe(400);
    await s.settle();
    expect(s.relayed).toEqual([]);
    expect(posted.flat()).not.toContain(other.txid);
    s.server.close();
  });

  it('fees are capped: a 200 KB 0-sat data write with $0 caps is refused and aborted; the balance is untouched', async () => {
    const s = await setup(['shop.example'], { maxUsdPerAction: 0, sessionBudgetUsd: 0 });
    const before = await balance(s.wallet);
    const r = await s.post('createAction', { description: 'big data write', outputs: [{ lockingScript: blob(200_000), satoshis: 0, outputDescription: 'data blob' }] });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/network fee/);
    expect(await balance(s.wallet)).toBe(before);
    await s.settle();
    expect(s.relayed).toEqual([]);
    s.server.close();
  });

  it('the default fee cap (10,000 sats) refuses the 200 KB write even with generous USD caps', async () => {
    const s = await setup();
    const before = await balance(s.wallet);
    const r = await s.post('createAction', { description: 'big data write', outputs: [{ lockingScript: blob(200_000), satoshis: 0, outputDescription: 'data blob' }] });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/10000-sat fee cap/);
    expect(await balance(s.wallet)).toBe(before);
    s.server.close();
  });

  it('services touched were all mocked', () => {
    expect([...unknownCalls]).toEqual([]);
  });
});

for (const mode of [undefined, 'legacy'] as const) {
  describe(`13 Nov 2026 re-review, ${mode ?? 'action-batch'} mode`, () => {
    const parentsOf = async (wallet: any) => [...new Set(((await wallet.listOutputs({ basket: 'default', limit: 100 })) as { outputs: { outpoint: string }[] }).outputs.map((o) => o.outpoint.split('.')[0]))];

    it('knownTxids naming the wallet\'s parents: paid, priced, and the reply BEEF trimmed to them', async () => {
      const s = await setup(undefined, undefined, mode);
      const parents = await parentsOf(s.wallet);
      const r = await s.post('createAction', pay(1000, { knownTxids: parents }));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const beef = Beef.fromBinary(r.body.tx);
      for (const t of parents) if (beef.findTxid(t)) expect(beef.findTxid(t).isTxidOnly).toBe(true);
      expect(beef.findTxid(r.body.txid).isTxidOnly).toBe(false);
      await s.settle();
      expect(s.relayed).toEqual([r.body.txid]);
      s.server.close();
    });

    it('knownTxids on a noSend build, then sendWith', async () => {
      const s = await setup(undefined, undefined, mode);
      const a = await s.post('createAction', pay(1000));
      const b = await s.post('createAction', pay(1000, { noSend: true, knownTxids: [a.body.txid, ...(await parentsOf(s.wallet))] }));
      expect(b.status, JSON.stringify(b.body)).toBe(200);
      const c = await s.post('createAction', { description: 'send the build', options: { sendWith: [b.body.txid] } });
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      await s.settle();
      expect(s.relayed).toEqual([a.body.txid, b.body.txid]);
      s.server.close();
    });

    it('the send step fails: serve aborts the build, the coins come back, the site gets the txid', async () => {
      const s = await setup(undefined, undefined, mode);
      const before = await balance(s.wallet);
      ctl.plan = ['throw', 'throw']; // the send step and its one retry
      const r = await s.post('createAction', pay(100_000));
      expect(r.status).toBe(400);
      expect(r.body.aborted, JSON.stringify(r.body)).toBe(true);
      expect(typeof r.body.txid).toBe('string');
      expect(await balance(s.wallet)).toBe(before);
      await s.settle();
      expect(s.relayed).toEqual([]);
      s.server.close();
    });

    it("a site can't abort another app's noSend build (owner unknown)", async () => {
      const s = await setup(undefined, undefined, mode);
      const other = (await s.wallet.createAction({ description: 'another app build', outputs: [{ lockingScript: dest, satoshis: 1000, outputDescription: 'other app pay' }], options: { noSend: true } }, 'other.app')) as { txid: string };
      const ab = await s.post('abortAction', { reference: other.txid });
      expect(ab.status).toBe(400);
      // Still the other app's to send.
      const sent = (await s.wallet.createAction({ description: 'other app sends', options: { sendWith: [other.txid] } }, 'other.app')) as { sendWithResults: { status: string }[] };
      expect(sent.sendWithResults[0].status).not.toBe('failed');
      s.server.close();
    });

    // The final review's simulation: storage commits (and shares) the send, then the answer is lost.
    const loseAnswerAfterCommit = (active: any) => {
      let armed = true;
      if (mode === 'legacy') {
        const orig = active.processAction.bind(active);
        active.processAction = async (...a: any[]) => {
          const r = await orig(...a);
          if (armed && a[1]?.isSendWith && !a[1]?.isNewTx) {
            armed = false;
            throw new Error('simulated lost response after processAction');
          }
          return r;
        };
      } else {
        const orig = active.updateActionBatch.bind(active);
        active.updateActionBatch = async (id: unknown, u: any, ...rest: unknown[]) => {
          const r = await orig(id, u, ...rest);
          if (armed && u && 'result' in u) {
            armed = false;
            throw new Error('simulated lost response after commit');
          }
          return r;
        };
      }
    };

    it('committed but the answer was lost: the retry returns the saved result, a normal success', async () => {
      const s = await setup(undefined, undefined, mode);
      loseAnswerAfterCommit(s.active);
      const r = await s.post('createAction', pay(1000));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      await s.settle();
      expect(s.relayed).toEqual([r.body.txid]);
      s.server.close();
    });

    it('committed, answer lost, and the retry fails too: never "aborted, nothing paid"; the charge stays', async () => {
      const s = await setup(['shop.example'], { maxUsdPerAction: 1, sessionBudgetUsd: 0.6 }, mode);
      loseAnswerAfterCommit(s.active);
      ctl.plan = ['pass', 'throw']; // the first send commits then loses its answer; the retry fails outright
      const r = await s.post('createAction', pay(1_000_000)); // $0.50
      expect(r.status).toBe(400);
      expect(r.body.aborted, JSON.stringify(r.body)).toBe(false);
      expect(String(r.body.message)).toMatch(new RegExp(`check ${r.body.txid} before paying again`));
      // Storage still has it to send; serve kept the charge and logged it.
      expect(await storageTxStatus(s.wallet)(r.body.txid)).not.toBe('invalid');
      expect(readLog(s.account).filter((e: { action: string }) => e.action === 'send')).toHaveLength(1);
      expect((await s.post('createAction', pay(1_000_000))).status).toBe(400);
      s.server.close();
    });

    it('a signAction flow counts once toward the rate limit', async () => {
      const s = await setup(undefined, undefined, mode);
      const c = await s.post('createAction', pay(1000, { signAndProcess: false }));
      const sg = await s.post('signAction', { reference: c.body.signableTransaction.reference, spends: {} });
      expect(sg.status, JSON.stringify(sg.body)).toBe(200);
      expect(readLog(s.account).map((e: { action: string }) => e.action)).toEqual(['send', 'brc100-signAction']);
      s.server.close();
    });
  });
}
