/**
 * MCP safety (0.6.0): per-call USD limit on every spending tool, confirmAll for "withdraw everything",
 * tightening-only tools, loosening refused under MCP, and `mint` confined to the mint folder.
 * The real MCP server in memory; nothing is signed or broadcast (every call here is refused before a wallet opens).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const dir = mkdtempSync(join(tmpdir(), 'bwx-mcp-safety-'));
process.env.BWALLETX_HOME = dir;
delete process.env.BWALLETX_MCP_MAX_USD;
const { writeConfig, readConfig, allStopped } = await import('./store');
const { createMcpServer } = await import('./mcp');
const mint = await import('./mint');
const og = await import('./ownerGate');
const { effectiveAccount } = await import('./owner');

const outside = mkdtempSync(join(tmpdir(), 'bwx-mcp-outside-'));
let client: Client;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { ...(JSON.parse(r.content[0].text) as Record<string, unknown>), isError: !!r.isError };
};

beforeAll(async () => {
  writeConfig({
    accounts: {
      t: { name: 't', kind: 'key', identityAddress: '1Id', payAddress: '1Pay', ordAddress: '1Ord', dailyCapUsd: 10, stopped: false, importedAt: Date.now() - 1e7 },
      phone: { name: 'phone', kind: 'paired', identityAddress: '1Ph', payAddress: '', ordAddress: '', dailyCapUsd: 10, stopped: false, importedAt: Date.now() - 1e7 },
    },
    defaultAccount: 't',
  });
  const server = createMcpServer('test');
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(b), client.connect(a)]);
  // files for the mint checks
  const inbox = mint.defaultMintDir();
  writeFileSync(join(inbox, 'art.png'), Buffer.alloc(1000, 1));
  writeFileSync(join(inbox, '.secret.png'), 'x');
  mkdirSync(join(inbox, '.git'), { recursive: true });
  writeFileSync(join(inbox, '.git', 'x.png'), 'x');
  writeFileSync(join(outside, 'private.png'), 'not for the chain');
  symlinkSync(join(outside, 'private.png'), join(inbox, 'link.png'));
  mkdirSync(join(outside, 'sub'));
  writeFileSync(join(outside, 'sub', 'y.png'), 'y');
  symlinkSync(join(outside, 'sub'), join(inbox, 'linkdir'));
  writeFileSync(join(inbox, 'manifest.json'), JSON.stringify([{ title: 'ok', file: 'art.png' }, { title: 'leak', file: join(outside, 'private.png') }]));
});
afterAll(async () => {
  await client?.close();
  delete process.env.BWALLETX_UNDER_MCP;
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('MCP per-call limit ($5 default) and confirmAll', () => {
  test('send over $5 is refused', async () => {
    expect(await call('send', { usd: 6, to: '1X' })).toMatchObject({ ok: false, text: expect.stringMatching(/per-call limit/) });
  });
  test('brc100_withdraw: over $5 refused; "all" needs confirmAll', async () => {
    expect(await call('brc100_withdraw', { usd: 6, address: '1X' })).toMatchObject({ ok: false, text: expect.stringMatching(/per-call limit/) });
    expect(await call('brc100_withdraw', { usd: 'all', address: '1X' })).toMatchObject({ ok: false, text: expect.stringMatching(/confirmAll/) });
    expect(await call('brc100_withdraw', { usd: 'all', address: '1X', confirmAll: false })).toMatchObject({ ok: false, text: expect.stringMatching(/confirmAll/) });
  });
  test('buy, buy_listing and buy_product are limited too (new in 0.6.0 for buy and buy_listing)', async () => {
    expect(await call('buy', { tokenId: 'a'.repeat(64) + '_0', maxUsd: 6 })).toMatchObject({ ok: false, text: expect.stringMatching(/per-call limit/) });
    expect(await call('buy_listing', { outpoint: 'a'.repeat(64) + '_0', maxUsd: 6 })).toMatchObject({ ok: false, text: expect.stringMatching(/per-call limit/) });
    expect(await call('buy_product', { product: 'edition', maxUsd: 99 })).toMatchObject({ ok: false, text: expect.stringMatching(/per-call limit/) });
  });
});

describe('MCP can tighten, never loosen', () => {
  test('lower_cap lowers; raising is refused', async () => {
    expect(await call('lower_cap', { usdPerDay: 4, account: 't' })).toMatchObject({ ok: true });
    expect(effectiveAccount(readConfig().accounts.t).dailyCapUsd).toBe(4);
    expect(await call('lower_cap', { usdPerDay: 50, account: 't' })).toMatchObject({ isError: true, error: expect.stringMatching(/can only lower/) });
  });
  test('the loosening commands are refused inside the MCP process even with a TTY and a PIN', async () => {
    const e = { ...og.defaultOwnerEnv(), stdinTTY: true, stdoutTTY: true, agentShell: null, prompt: async () => 'correct horse battery', scrypt: { N: 1024, r: 8, p: 1 } };
    expect(e.underMcp).toBe(true);
    await expect(og.setCap('t', 'off', e)).rejects.toThrow(/under MCP/);
    await expect(og.resumeAll(e)).rejects.toThrow(/under MCP/);
    await expect(og.setupOwner(e)).rejects.toThrow(/under MCP/);
  });
  test('no tool loosens: the tool list has no cap/resume/live/import/serve tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const bad of ['cap', 'set_cap', 'resume', 'ratelimit', 'approve_above', 'key_import', 'serve', 'login', 'pair']) expect(names).not.toContain(bad);
    expect(names).toContain('stop_all');
  });
});

describe('MCP mint is confined to the mint folder', () => {
  const refused = async (files: string[], re: RegExp) =>
    expect(await call('mint', { files, titleFromFilename: true, account: 'phone', dryRun: true })).toMatchObject({ isError: true, error: expect.stringMatching(re) });

  test('path traversal and absolute paths outside the folder are refused', async () => {
    await refused(['../config.json'], /outside the mint folder|Missing/);
    await refused([join(outside, 'private.png')], /outside the mint folder/);
    await refused(['../accounts/x.key.json'], /outside the mint folder|Missing/);
  });
  test('a symlink that escapes (file or folder) is refused after resolving it', async () => {
    await refused(['link.png'], /outside the mint folder/);
    await refused(['linkdir/y.png'], /outside the mint folder/);
  });
  test('dotfiles and hidden folders are refused', async () => {
    await refused(['.secret.png'], /dotfile/);
    await refused(['.git/x.png'], /dotfile|hidden/);
  });
  test('a manifest inside the folder that points outside is refused', async () => {
    expect(await call('mint_manifest', { manifest: 'manifest.json', account: 'phone', dryRun: true })).toMatchObject({ isError: true, error: expect.stringMatching(/outside the mint folder/) });
  });
  test('a file inside the folder passes the path check', () => {
    expect(mint.resolveMintFile('art.png', mint.prepareMintDir())).toMatch(/mint-inbox\/art\.png$/);
  });
  test('~/.ssh, ~/.claude* and too-broad folders are refused as mint folders', () => {
    const ssh = join(outside, '.ssh');
    mkdirSync(ssh);
    const claude = join(outside, '.claude-x');
    mkdirSync(claude);
    expect(() => mint.prepareMintDir(ssh)).toThrow(/private folder/);
    expect(() => mint.prepareMintDir(claude)).toThrow(/private folder/);
    expect(() => mint.prepareMintDir('/')).toThrow(/too broad/);
    expect(() => mint.prepareMintDir(dir)).toThrow(/private folder|too broad/); // the bwalletx home (keys)
  });
  test('over the size limit needs a dryRun first or confirm: true', () => {
    const big = join(mint.defaultMintDir(), 'big.png');
    writeFileSync(big, Buffer.alloc(mint.MCP_MINT_CONFIRM_BYTES + 1, 7));
    const items = mint.confineItems([{ file: 'big.png', title: 'big' }], mint.prepareMintDir());
    const seen = new Map<string, number>();
    expect(mint.mintSizeGate(items, {}, seen)).toMatch(/dryRun: true first/);
    expect(mint.mintSizeGate(items, { confirm: true }, seen)).toBeNull();
    expect(mint.mintSizeGate(items, { dryRun: true }, seen)).toBeNull();
    expect(mint.mintSizeGate(items, {}, seen)).toBeNull(); // dry-run seen
    expect(mint.mintSizeGate(items, {}, seen, Date.now() + 16 * 60_000)).toMatch(/dryRun/); // expired
    const small = mint.confineItems([{ file: 'art.png', title: 'a' }], mint.prepareMintDir());
    expect(mint.mintSizeGate(small, {}, new Map())).toBeNull();
  });
});

describe('MCP stop_all', () => {
  test('stops everything with no PIN (sticky stop after a PIN is set: owner.test.ts)', async () => {
    expect(allStopped()).toBe(false);
    expect(await call('stop_all')).toMatchObject({ stopped: true });
    expect(allStopped()).toBe(true);
  });
});
