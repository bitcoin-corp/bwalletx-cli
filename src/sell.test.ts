import { afterEach, describe, expect, test, vi } from 'vitest';
import { OrdLockV2 } from '@1sat/templates';
import { BSV21_BASKET, OPNS_BASKET, ORDINALS_BASKET, buildBsv21CustomInstructions } from '@1sat/actions';
import { P2PKH, PrivateKey, Transaction, type CreateActionArgs, type WalletOutput } from '@bsv/sdk';
import {
  buildListingScript,
  buyListing,
  cancelKeyID,
  decodeAnyListing,
  dryRunWallet,
  DRY_RUN_STOP,
  fromRaw,
  listForSale,
  myListings,
  parseOutpoint,
  setSellDeps,
  toRaw,
  unlist,
  type SellDeps,
  type TokenRecord,
} from './sell';
import { MARKET_FEE_ADDRESS, MARKET_FEE_RATE } from './buy';

const TXID = 'cd'.repeat(32);
const TOKEN = `${'ab'.repeat(32)}_0`;
const key = PrivateKey.fromRandom();
const addr = () => PrivateKey.fromRandom().toAddress();

describe('pure helpers', () => {
  test('parseOutpoint takes _ . and : forms', () => {
    for (const s of [`${TXID}_3`, `${TXID}.3`, `${TXID}:3`]) expect(parseOutpoint(s)).toMatchObject({ txid: TXID, vout: 3, us: `${TXID}_3`, dot: `${TXID}.3` });
    expect(() => parseOutpoint('nope')).toThrow(/Not an outpoint/);
  });

  test('BSV-21 listing script round-trips (transfer inscription around OrdLock v2)', () => {
    const s = buildListingScript(TOKEN, 5000n, addr(), addr(), 12_345);
    expect(decodeAnyListing(s)).toMatchObject({ priceSats: 12_345, v2: true, token: { id: TOKEN, amount: 5000n } });
    expect(() => buildListingScript(TOKEN, 1n, addr(), addr(), 0)).toThrow(/whole number/);
    expect(() => buildListingScript(TOKEN, 0n, addr(), addr(), 10)).toThrow(/positive/);
  });

  test('an ordinal listing decodes with no token', () => {
    expect(decodeAnyListing(OrdLockV2.lock(addr(), addr(), 777))).toMatchObject({ priceSats: 777, token: null });
    expect(decodeAnyListing(new P2PKH().lock(addr()))).toBeNull();
  });

  test('amounts', () => {
    expect(toRaw('1.5', 2)).toBe(150n);
    expect(toRaw('1.555', 2)).toBeNull();
    expect(toRaw('0', 2)).toBeNull();
    expect(fromRaw(150n, 2)).toBe('1.5');
    expect(cancelKeyID(`${'ab'.repeat(32)}.0`)).toBe(`ordlock-${TOKEN}`);
  });

  test('dryRunWallet records createAction, refuses writes, passes reads', async () => {
    const real = { createAction: vi.fn(), signAction: vi.fn(), getPublicKey: vi.fn(async () => ({ publicKey: 'pk' })) };
    const d = dryRunWallet(real as never);
    await expect(d.wallet.createAction({ description: 'x', outputs: [] })).rejects.toThrow(DRY_RUN_STOP);
    await expect(d.wallet.signAction({ reference: 'r', spends: {} })).rejects.toThrow(DRY_RUN_STOP);
    expect(await d.wallet.getPublicKey({ identityKey: true })).toEqual({ publicKey: 'pk' });
    expect(d.captured).toHaveLength(1);
    expect(real.createAction).not.toHaveBeenCalled();
    expect(real.signAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- flows against a fake wallet and mocked network

type Baskets = Partial<Record<string, WalletOutput[]>>;
const out = (outpoint: string, tags: string[] = [], customInstructions?: string): WalletOutput => ({ outpoint, satoshis: 1, spendable: true, tags, ...(customInstructions && { customInstructions }) }) as WalletOutput;

function fakeWallet(baskets: Baskets) {
  return {
    listOutputs: vi.fn(async (a: { basket: string }) => ({ totalOutputs: (baskets[a.basket] ?? []).length, outputs: baskets[a.basket] ?? [] })),
    getPublicKey: vi.fn(async () => ({ publicKey: key.toPublicKey().toString() })),
    createAction: vi.fn(async () => ({ txid: 'f'.repeat(64) })),
    signAction: vi.fn(),
  };
}

/** A stand-in action: builds a createAction like the real builders do and returns what the wallet gives back. */
const builder = (shape: (input: Record<string, unknown>) => CreateActionArgs) =>
  vi.fn(async (ctx: { wallet: { createAction: (a: CreateActionArgs) => Promise<{ txid?: string }> } }, input: Record<string, unknown>) => {
    try {
      const r = await ctx.wallet.createAction(shape(input));
      return { txid: r.txid };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });

function setup(baskets: Baskets, over: Partial<SellDeps> = {}) {
  const wallet = fakeWallet(baskets);
  let records: TokenRecord[] = [];
  const calls = {
    gate: vi.fn((): { ok: true; paper: boolean } | { ok: false; reason: string } => ({ ok: true, paper: false })),
    log: vi.fn(),
    settle: vi.fn(),
    release: vi.fn(),
    sendWaiting: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const simple = builder(() => ({ description: 'stub', inputs: [{ outpoint: `${TXID}.0`, inputDescription: 'in', unlockingScriptLength: 108 }], outputs: [{ lockingScript: '00', satoshis: 1, outputDescription: 'out' }] }));
  const actions = {
    sellOrdinal: { execute: simple },
    sellOpns: { execute: simple },
    sendBsv21: {
      execute: builder((i) => ({
        description: 'Send tokens',
        outputs: (i.recipients as { destination: { lockingScript: string } }[]).map((r) => ({ lockingScript: r.destination.lockingScript, satoshis: 1, outputDescription: 'listing' })),
      })),
    },
    cancelOrdinalListing: { execute: simple },
    cancelTokenListing: { execute: simple },
    cancelOpnsListing: { execute: simple },
    cancelRecorded: { execute: simple },
    buyOrdinal: { execute: simple },
    buyBsv21: { execute: simple },
  };
  const gate = over.gate ?? calls.gate;
  setSellDeps({
    // The reservation answers as the gate does; a settle is the log entry.
    reserve: async (n, a) => {
      const g = gate(n, a);
      if (!g.ok) return g;
      return {
        ...g,
        settle: (e) => {
          calls.settle(e);
          calls.log(n, e);
        },
        release: calls.release,
      };
    },
    open: async () => ({ name: 'agent', ctx: { wallet: wallet as never, chain: 'main', isBaseWallet: true }, sendWaiting: calls.sendWaiting, close: calls.close }),
    unspent: async () => true,
    rate: async () => 50,
    overlayFee: async () => ({ address: addr(), sats: 1000 }),
    tokenFloorUsd: async () => null,
    gate: calls.gate,
    stopped: () => false,
    log: calls.log,
    records: { load: () => records, save: (_n, r) => void (records = r) },
    actions: actions as never,
    ...over,
  });
  return { wallet, calls, actions, records: () => records };
}

afterEach(() => setSellDeps(null));

const tokenOut = (outpoint: string, amt = '5000') => out(outpoint, [`bsv21:${TOKEN}`, 'id:tok1'], buildBsv21CustomInstructions({ token: { id: TOKEN, amt, sym: 'TEST', dec: 2 } }));

describe('list', () => {
  test('dry run (BSV-21): builds the OrdLock v2 listing through sendBsv21, signs nothing, gates nothing', async () => {
    const t = setup({ [BSV21_BASKET]: [tokenOut(`${TXID}.1`)] });
    const r = await listForSale({ outpoint: `${TXID}_1`, priceSats: 25_000, amount: '10', dryRun: true });
    expect(r).toMatchObject({ ok: true, dryRun: true });
    expect(r.text).toMatch(/10 TEST for 25,000 sats/);
    expect(t.wallet.createAction).not.toHaveBeenCalled();
    expect(t.calls.gate).not.toHaveBeenCalled();
    expect(t.records()).toEqual([]);
    expect(t.actions.sendBsv21.execute).toHaveBeenCalledOnce();
    const sent = t.actions.sendBsv21.execute.mock.calls[0]![1] as { tokenId: string; recipients: { amount: string; destination: { lockingScript: string } }[] };
    expect(sent.tokenId).toBe(TOKEN);
    expect(sent.recipients[0]!.amount).toBe('1000');
    const { LockingScript } = await import('@bsv/sdk');
    expect(decodeAnyListing(LockingScript.fromHex(sent.recipients[0]!.destination.lockingScript))).toMatchObject({ priceSats: 25_000, token: { id: TOKEN, amount: 1000n } });
    expect(t.calls.close).toHaveBeenCalled();
  });

  test('live (BSV-21) with --yes: gated as list, broadcasts, records the cancel key, logs', async () => {
    const t = setup({ [BSV21_BASKET]: [tokenOut(`${TXID}.1`)] });
    const r = await listForSale({ outpoint: `${TXID}_1`, priceSats: 25_000 });
    expect(r.ok).toBe(true);
    expect(t.calls.gate).toHaveBeenCalledWith('agent', expect.objectContaining({ kind: 'list', token: TOKEN, usd: 0 }));
    expect(t.wallet.createAction).toHaveBeenCalledOnce();
    expect(t.records()).toEqual([expect.objectContaining({ tokenId: TOKEN, amount: '5000', priceSats: 25_000, keyID: cancelKeyID(TOKEN) })]);
    expect(t.calls.log).toHaveBeenCalledWith('agent', expect.objectContaining({ action: 'list' }));
  });

  test('declined confirmation sends nothing', async () => {
    const t = setup({ [ORDINALS_BASKET]: [out(`${TXID}.0`, ['id:o1'])] });
    const r = await listForSale({ outpoint: `${TXID}_0`, priceSats: 1000, confirm: async () => false });
    expect(r).toMatchObject({ ok: false, text: expect.stringMatching(/Not confirmed/) });
    expect(t.actions.sellOrdinal.execute).not.toHaveBeenCalled();
  });

  test('ordinals use sellOrdinal with the basket id; OpNS names use sellOpns', async () => {
    const t = setup({ [ORDINALS_BASKET]: [out(`${TXID}.0`, ['id:o1'])], [OPNS_BASKET]: [out(`${TXID}.2`, ['id:n1', 'name:bob'])] });
    await listForSale({ outpoint: `${TXID}_0`, priceSats: 1000, dryRun: true });
    expect(t.actions.sellOrdinal.execute.mock.calls[0]![1]).toEqual({ id: 'o1', price: 1000 });
    await listForSale({ outpoint: `${TXID}_2`, priceSats: 2000, dryRun: true });
    expect(t.actions.sellOpns.execute.mock.lastCall![1]).toEqual({ id: 'n1', price: 2000 });
  });

  test('refusals: paper mode, not owned, already listed, too many tokens', async () => {
    setup({ [ORDINALS_BASKET]: [out(`${TXID}.0`, ['id:o1'])] }, { gate: () => ({ ok: true, paper: true }) });
    expect((await listForSale({ outpoint: `${TXID}_0`, priceSats: 1 })).text).toMatch(/Paper mode/);
    setup({});
    expect((await listForSale({ outpoint: `${TXID}_0`, priceSats: 1 })).text).toMatch(/not in agent's wallet/);
    setup({ [ORDINALS_BASKET]: [out(`${TXID}.0`, ['id:o1', 'ordlock:v2'])] });
    expect((await listForSale({ outpoint: `${TXID}_0`, priceSats: 1 })).text).toMatch(/already listed/);
    setup({ [BSV21_BASKET]: [tokenOut(`${TXID}.1`)] });
    await expect(listForSale({ outpoint: `${TXID}_1`, priceSats: 1, amount: '51', dryRun: true })).rejects.toThrow(/holds 50 TEST/);
  });
});

describe('list below value: the shortfall counts against the cap (review fix)', () => {
  // $50/BSV in the rig: 1 sat ≈ $0.0000005.
  const opnsOut = (name: string | null) => out(`${TXID}.2`, ['id:n1', ...(name ? [`name:${name}`] : [])]);

  test('an OpNS name listed for 1 sat is reserved at its tier, not as a $0 list', async () => {
    const t = setup({ [OPNS_BASKET]: [opnsOut('abc')] }); // 3 characters: $100
    const r = await listForSale({ outpoint: `${TXID}_2`, priceSats: 1 });
    expect(r.ok).toBe(true);
    expect(t.calls.gate).toHaveBeenCalledWith('agent', expect.objectContaining({ kind: 'list', token: 'opns', usd: expect.closeTo(100, 4) }));
    expect(t.calls.settle).toHaveBeenCalledWith(expect.objectContaining({ action: 'list', usd: expect.closeTo(100, 4) }));
  });

  test('at or above its tier: $0; a name output with no readable name is valued at the top tier', async () => {
    const t = setup({ [OPNS_BASKET]: [opnsOut('abc')] });
    await listForSale({ outpoint: `${TXID}_2`, priceSats: 200_000_000 }); // 2 BSV = $100
    expect(t.calls.gate).toHaveBeenLastCalledWith('agent', expect.objectContaining({ usd: 0 }));
    const u = setup({ [OPNS_BASKET]: [opnsOut(null)] });
    await listForSale({ outpoint: `${TXID}_2`, priceSats: 1 });
    expect(u.calls.gate).toHaveBeenLastCalledWith('agent', expect.objectContaining({ usd: expect.closeTo(500, 4) }));
  });

  test('no BSV price: the whole tier counts (fail closed)', async () => {
    const t = setup({ [OPNS_BASKET]: [opnsOut('alice')] }, { rate: async () => Promise.reject(new Error('down')) });
    await listForSale({ outpoint: `${TXID}_2`, priceSats: 100_000_000 });
    expect(t.calls.gate).toHaveBeenLastCalledWith('agent', expect.objectContaining({ usd: 10 }));
  });

  test('against the real gate: a $100 name for 1 sat is refused over a $15 cap and nothing is signed', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { reserveSpend } = await import('./gate');
    const { readReservations, writeConfig } = await import('./store');
    process.env.BWALLETX_HOME = mkdtempSync(join(tmpdir(), 'bwx-list-'));
    writeConfig({ accounts: { agent: { name: 'agent', identityAddress: '1Id', payAddress: '1Pay', ordAddress: '1Ord', dailyCapUsd: 15, stopped: false, importedAt: 1 } }, defaultAccount: 'agent' });
    const t = setup({ [OPNS_BASKET]: [opnsOut('abc')] }, { reserve: (n, a) => reserveSpend(n, a) });
    const r = await listForSale({ outpoint: `${TXID}_2`, priceSats: 1 });
    expect(r).toMatchObject({ ok: false, text: expect.stringMatching(/Over today's cap/) });
    expect(t.actions.sellOpns.execute).not.toHaveBeenCalled();
    expect(readReservations('agent')).toEqual([]);
  });

  test('BSV-21 below the market floor counts the shortfall; an unreadable floor refuses', async () => {
    // 5000 raw at 2 decimals = 50 TEST; floor $0.01/token = $0.50.
    const t = setup({ [BSV21_BASKET]: [tokenOut(`${TXID}.1`)] }, { tokenFloorUsd: async () => 0.01 });
    await listForSale({ outpoint: `${TXID}_1`, priceSats: 1 });
    expect(t.calls.gate).toHaveBeenLastCalledWith('agent', expect.objectContaining({ kind: 'list', token: TOKEN, usd: expect.closeTo(0.5, 4) }));
    const u = setup({ [BSV21_BASKET]: [tokenOut(`${TXID}.1`)] }, { tokenFloorUsd: async () => Promise.reject(new Error('GorillaPool down')) });
    expect((await listForSale({ outpoint: `${TXID}_1`, priceSats: 1 })).text).toMatch(/Refused: couldn't read the market floor/);
    expect(u.actions.sendBsv21.execute).not.toHaveBeenCalled();
  });

  test('ordinals have no known value: still a $0 list (documented gap)', async () => {
    const t = setup({ [ORDINALS_BASKET]: [out(`${TXID}.0`, ['id:o1'])] });
    await listForSale({ outpoint: `${TXID}_0`, priceSats: 1 });
    expect(t.calls.gate).toHaveBeenLastCalledWith('agent', expect.objectContaining({ kind: 'list', token: 'ordinal', usd: 0 }));
  });
});

describe('an error answer after the wallet signed stays counted (review fix)', () => {
  const ordinalListing = () => {
    const tx = new Transaction();
    tx.addOutput({ lockingScript: OrdLockV2.lock(addr(), addr(), 100_000), satoshis: 1 });
    return tx;
  };
  /** Reaches the wallet (createAction signs and processes), then answers with an error and no txid. */
  const lateError = vi.fn(async (ctx: { wallet: { createAction: (a: CreateActionArgs) => Promise<unknown> } }) => {
    await ctx.wallet.createAction({ description: 'buy', outputs: [] });
    return { error: 'processAction failed after broadcast' };
  });
  /** Answers with an error before touching the wallet. */
  const earlyError = vi.fn(async () => ({ error: 'no funding' }));

  test('buy-listing: counted when the wallet was asked to sign; released when it never was', async () => {
    const t = setup({}, { fetchTx: async () => ordinalListing() });
    t.actions.buyOrdinal.execute = lateError as never;
    await expect(buyListing({ outpoint: `${TXID}_0` })).rejects.toThrow(/Purchase failed/);
    expect(t.calls.settle).toHaveBeenCalledWith(expect.objectContaining({ action: 'failed', usd: expect.any(Number) }));
    expect(t.calls.release).not.toHaveBeenCalled();
    const u = setup({}, { fetchTx: async () => ordinalListing() });
    u.actions.buyOrdinal.execute = earlyError as never;
    await expect(buyListing({ outpoint: `${TXID}_0` })).rejects.toThrow(/Purchase failed/);
    expect(u.calls.release).toHaveBeenCalledOnce();
    expect(u.calls.settle).not.toHaveBeenCalled();
  });

  test('list: same rule', async () => {
    const t = setup({ [OPNS_BASKET]: [out(`${TXID}.2`, ['id:n1', 'name:abc'])] });
    t.actions.sellOpns.execute = lateError as never;
    await expect(listForSale({ outpoint: `${TXID}_2`, priceSats: 1 })).rejects.toThrow(/Listing failed/);
    expect(t.calls.settle).toHaveBeenCalledWith(expect.objectContaining({ action: 'failed', usd: expect.closeTo(100, 4) }));
    expect(t.calls.release).not.toHaveBeenCalled();
    const u = setup({ [OPNS_BASKET]: [out(`${TXID}.2`, ['id:n1', 'name:abc'])] });
    u.actions.sellOpns.execute = earlyError as never;
    await expect(listForSale({ outpoint: `${TXID}_2`, priceSats: 1 })).rejects.toThrow(/Listing failed/);
    expect(u.calls.release).toHaveBeenCalledOnce();
  });
});

describe('unlist', () => {
  test('dry run on a wallet listing builds the cancel only', async () => {
    const t = setup({ [ORDINALS_BASKET]: [out(`${TXID}.0`, ['id:o1', 'ordlock:v2'])] });
    const r = await unlist({ outpoint: `${TXID}_0`, dryRun: true });
    expect(r).toMatchObject({ ok: true, dryRun: true });
    expect(t.actions.cancelOrdinalListing.execute.mock.calls[0]![1]).toEqual({ id: 'o1' });
    expect(t.wallet.createAction).not.toHaveBeenCalled();
  });

  test('a recorded BSV-21 listing is cancelled with its key and forgotten', async () => {
    const listingTx = new Transaction();
    listingTx.addOutput({ lockingScript: buildListingScript(TOKEN, 10n, addr(), addr(), 500), satoshis: 1 });
    const rec: TokenRecord = { outpoint: `${TXID}_0`, tokenId: TOKEN, amount: '10', priceSats: 500, keyID: cancelKeyID(TOKEN), createdAt: 1 };
    const save = vi.fn();
    const t = setup({}, { fetchTx: async () => listingTx, records: { load: () => [rec], save } });
    const r = await unlist({ outpoint: `${TXID}.0` });
    expect(r.ok).toBe(true);
    expect(t.actions.cancelRecorded.execute.mock.calls[0]![1]).toMatchObject({ record: rec, listingTx });
    expect(save).toHaveBeenCalledWith('agent', []);
  });

  test('not ours', async () => {
    setup({});
    expect((await unlist({ outpoint: `${TXID}_0` })).text).toMatch(/not one of agent's listings/);
  });
});

describe('buy-listing <outpoint>', () => {
  const ordinalListing = () => {
    const tx = new Transaction();
    tx.addOutput({ lockingScript: OrdLockV2.lock(addr(), addr(), 100_000), satoshis: 1 });
    return tx;
  };

  test('dry run (ordinal): buyOrdinal with the 1% market fee, nothing signed', async () => {
    const t = setup({}, { fetchTx: async () => ordinalListing() });
    const r = await buyListing({ outpoint: `${TXID}_0`, dryRun: true });
    expect(r).toMatchObject({ ok: true, dryRun: true, sats: 101_000 });
    expect(r.text).toMatch(/100,000 sats to seller \+ 1000 market fee/);
    expect(t.actions.buyOrdinal.execute.mock.calls[0]![1]).toEqual({ outpoint: `${TXID}_0`, marketplaceAddress: MARKET_FEE_ADDRESS, marketplaceRate: MARKET_FEE_RATE });
    expect(t.wallet.createAction).not.toHaveBeenCalled();
    expect(t.calls.gate).not.toHaveBeenCalled();
  });

  test('live (BSV-21): gated as a buy with the full cost, buyBsv21 with the listed amount', async () => {
    const tx = new Transaction();
    tx.addOutput({ lockingScript: buildListingScript(TOKEN, 42n, addr(), addr(), 10_000), satoshis: 1 });
    const t = setup({}, { fetchTx: async () => tx });
    const r = await buyListing({ outpoint: `${TXID}_0`, confirm: async () => true });
    expect(r.ok).toBe(true);
    expect(t.actions.buyBsv21.execute.mock.calls[0]![1]).toMatchObject({ tokenId: TOKEN, amount: '42', marketplaceAddress: MARKET_FEE_ADDRESS });
    const usd = ((10_000 + 100 + 1000) / 1e8) * 50;
    expect(t.calls.gate).toHaveBeenCalledWith('agent', expect.objectContaining({ kind: 'buy', token: TOKEN, usd }));
    expect(t.calls.log).toHaveBeenCalledWith('agent', expect.objectContaining({ action: 'buy', usd }));
  });

  test('refusals: spent, not a listing, over --max-usd, kill switch, gate', async () => {
    setup({}, { fetchTx: async () => ordinalListing(), unspent: async () => false });
    expect((await buyListing({ outpoint: `${TXID}_0` })).text).toMatch(/already bought or cancelled/);
    const p2pkh = new Transaction();
    p2pkh.addOutput({ lockingScript: new P2PKH().lock(addr()), satoshis: 5 });
    setup({}, { fetchTx: async () => p2pkh });
    expect((await buyListing({ outpoint: `${TXID}_0` })).text).toMatch(/not a 1Sat OrdLock listing/);
    setup({}, { fetchTx: async () => ordinalListing() });
    expect((await buyListing({ outpoint: `${TXID}_0`, maxUsd: 0.01 })).text).toMatch(/over --max-usd/);
    setup({}, { fetchTx: async () => ordinalListing(), stopped: () => true });
    expect((await buyListing({ outpoint: `${TXID}_0` })).text).toMatch(/stopped/);
    const t = setup({}, { fetchTx: async () => ordinalListing(), gate: () => ({ ok: false, reason: 'Over today' }) });
    expect((await buyListing({ outpoint: `${TXID}_0` })).text).toMatch(/Refused: Over today/);
    expect(t.actions.buyOrdinal.execute).not.toHaveBeenCalled();
  });

  test('two buys at once: only the one that fits under the cap signs', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { reserveSpend } = await import('./gate');
    const { readLog, readReservations, writeConfig } = await import('./store');
    process.env.BWALLETX_HOME = mkdtempSync(join(tmpdir(), 'bwx-sell-'));
    // One ordinal listing costs 101,000 sats + fee at $50/BSV ≈ $0.05; the cap fits one.
    writeConfig({ accounts: { agent: { name: 'agent', identityAddress: '1Id', payAddress: '1Pay', ordAddress: '1Ord', dailyCapUsd: 0.06, stopped: false, importedAt: 1 } }, defaultAccount: 'agent' });
    const t = setup({}, { fetchTx: async () => ordinalListing(), reserve: (n, a) => reserveSpend(n, a) });
    const out = await Promise.all([buyListing({ outpoint: `${TXID}_0` }), buyListing({ outpoint: `${TXID}_0` })]);
    expect(out.filter((o) => o.ok)).toHaveLength(1);
    expect(out.find((o) => !o.ok)?.text).toMatch(/Over today's cap/);
    expect(t.actions.buyOrdinal.execute).toHaveBeenCalledTimes(1);
    expect(readReservations('agent')).toEqual([]);
    expect(readLog('agent').filter((e) => e.usd > 0)).toHaveLength(1);
  });
});

describe('listings', () => {
  test('wallet OrdLock outputs + recorded BSV-21 listings, with live status', async () => {
    const rec: TokenRecord = { outpoint: `${'ee'.repeat(32)}_0`, tokenId: TOKEN, amount: '10', priceSats: 500, keyID: 'k', sym: 'TEST', createdAt: 1 };
    setup(
      { [ORDINALS_BASKET]: [out(`${TXID}.0`, ['id:o1', 'ordlock:v2', 'price:777']), out(`${TXID}.1`, ['id:o2'])], [OPNS_BASKET]: [out(`${TXID}.2`, ['ordlock:v2', 'price:5000', 'name:bob'])] },
      { records: { load: () => [rec], save: vi.fn() }, unspent: async (o) => !o.startsWith('ee') },
    );
    const r = await myListings();
    expect(r.listings).toEqual([
      expect.objectContaining({ outpoint: `${TXID}_0`, kind: 'ordinal', priceSats: 777, status: 'live' }),
      expect.objectContaining({ outpoint: `${TXID}_2`, kind: 'opns', priceSats: 5000, name: 'bob', status: 'live' }),
      expect.objectContaining({ outpoint: rec.outpoint, kind: 'token', priceSats: 500, status: 'gone' }),
    ]);
  });
});
