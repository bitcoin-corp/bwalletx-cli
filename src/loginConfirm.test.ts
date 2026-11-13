/**
 * `bwalletx login` asks whether the phone shows the same code, and pairs only on a yes.
 * In-process relay + a fake phone (hello, ready, info). Fresh random keys only; nothing broadcast.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { PrivateKey } from '@bsv/sdk';
import { Sealer, deriveSession, isSealed, parsePairUrl, relaySocketUrl, type PairMessage } from './pair/protocol';

const dir = mkdtempSync(join(tmpdir(), 'bwx-login-confirm-'));
process.env.BWALLETX_HOME = dir;
const { login } = await import('./paired');

/** Minimal relay: one site + one wallet socket per channel, frames forwarded verbatim (queued if the peer is away). */
function startRelay() {
  const chans = new Map<string, { site?: WebSocket; wallet?: WebSocket; q: { site: string[]; wallet: string[] } }>();
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, sock, head) => {
    const u = new URL(req.url ?? '', 'http://relay');
    const id = u.pathname.split('/').pop()!;
    const role = u.searchParams.get('role') as 'site' | 'wallet';
    const ch = chans.get(id) ?? { q: { site: [], wallet: [] } };
    chans.set(id, ch);
    wss.handleUpgrade(req, sock, head, (ws) => {
      ch[role] = ws;
      const other = role === 'site' ? 'wallet' : 'site';
      for (const f of ch.q[role].splice(0)) ws.send(f);
      ws.on('message', (raw) => {
        const peer = ch[other];
        if (peer?.readyState === WebSocket.OPEN) peer.send(String(raw));
        else ch.q[other].push(String(raw));
      });
      ws.on('close', () => ch[role] === ws && delete ch[role]);
    });
  });
  return new Promise<{ server: Server; host: string }>((r) =>
    server.listen(0, '127.0.0.1', () => r({ server, host: `127.0.0.1:${(server.address() as AddressInfo).port}` })),
  );
}

/** What bWalletX does on scan and Pair: hello, ready, then answers the CLI's info request. */
function fakePhone(link: string) {
  const l = parsePairUrl(link);
  const P = PrivateKey.fromRandom();
  const state: { code?: string; closes: string[] } = { closes: [] };
  const ws = new WebSocket(relaySocketUrl(l.r!, l.c, 'wallet'));
  ws.on('open', async () => {
    const s = await deriveSession(P, l.k, l.c);
    state.code = s.code;
    const sealer = new Sealer(s.key, 'wallet');
    ws.send(JSON.stringify({ t: 'hello', k: P.toPublicKey().toString(), info: { name: 'test', rdns: 'space.bwallet.mobile' } }));
    ws.send(JSON.stringify(await sealer.seal({ t: 'ready' })));
    ws.on('message', async (raw) => {
      const f = JSON.parse(String(raw));
      if (!isSealed(f)) return;
      const m = (await sealer.open(f)) as PairMessage | null;
      if (m?.t === 'close') state.closes.push(m.reason);
      if (m?.t !== 'req' || m.action !== 'info') return;
      const result = { account: 'Agent', identityAddress: P.toAddress(), scopes: ['read'], expiresAt: Date.now() + 86_400_000 };
      ws.send(JSON.stringify(await sealer.seal({ t: 'res', id: m.id, result })));
    });
  });
  return state;
}

let relay: Awaited<ReturnType<typeof startRelay>>;
beforeAll(async () => {
  relay = await startRelay();
});
afterAll(() => {
  relay.server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Run login; the phone scans the link as soon as it is printed. */
function run(name: string, confirmCode: (code: string) => Promise<boolean>) {
  let phone: ReturnType<typeof fakePhone> | undefined;
  const out = (s: string) => {
    const m = /^Or open this link on the phone:\n(\S+)/.exec(s);
    if (m) phone = fakePhone(m[1]);
  };
  return { p: login(name, { relay: relay.host, confirmCode }, out), phone: () => phone! };
}
const saved = (name: string) => existsSync(join(dir, 'paired', `${name}.json`));

describe('login confirms the code', () => {
  it('a yes pairs, asked with the code the phone shows', async () => {
    const asked: string[] = [];
    const { p, phone } = run('yes', async (c) => (asked.push(c), true));
    const pairing = await p;
    expect(pairing.account).toBe('Agent');
    expect(asked).toEqual([phone().code]);
    expect(saved('yes')).toBe(true);
  });

  it("the phone's Pair alone doesn't pair: nothing is saved until the yes", async () => {
    let yes!: (ok: boolean) => void;
    const { p } = run('wait', () => new Promise<boolean>((r) => (yes = r)));
    await new Promise((r) => setTimeout(r, 300));
    expect(saved('wait')).toBe(false);
    yes(true);
    await p;
    expect(saved('wait')).toBe(true);
  });

  it('a no saves nothing and tells the phone to unpair', async () => {
    const { p, phone } = run('no', async () => false);
    await expect(p).rejects.toThrow("The codes didn't match");
    await new Promise((r) => setTimeout(r, 100));
    expect(phone().closes).toEqual(['codes did not match']);
    expect(saved('no')).toBe(false);
  });
});
