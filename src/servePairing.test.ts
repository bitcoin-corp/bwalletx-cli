import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const dir = mkdtempSync(join(tmpdir(), 'bwx-pair-'));
process.env.BWALLETX_HOME = dir;

const { serve } = await import('./brc100.js');
const { revokePairing, listPairings } = await import('./servePairing.js');

const SITE = 'https://www.tokenblaster.lol';
let server: Server;
let port: number;
let approve = true;
const calls: string[] = [];

const post = (path: string, headers: Record<string, string> = {}, body = '{}') =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { host: `localhost:${port}`, 'content-type': 'application/json', ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on('error', reject);
    r.end(body);
  });

beforeAll(async () => {
  const backend = { paired: false, call: async (m: string) => (calls.push(m), { publicKey: '02'.padEnd(66, 'a') }), close: async () => undefined };
  server = await serve(backend as never, { account: 'test', origins: [SITE], port: 0, confirmPairing: async () => approve });
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('serve pairing', () => {
  it('a forged Origin without a token gets 401 and never reaches the wallet', async () => {
    const r = await post('/getPublicKey', { origin: SITE });
    expect(r.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('getVersion and isAuthenticated answer unpaired but leak nothing', async () => {
    expect(JSON.parse((await post('/getVersion', { origin: SITE })).body)).toEqual({ version: 'bwalletx-1.0.0' });
    expect(JSON.parse((await post('/isAuthenticated', { origin: SITE })).body)).toEqual({ authenticated: false });
    expect(calls).toEqual([]);
  });

  it('a refused pairing issues no token', async () => {
    approve = false;
    const r = JSON.parse((await post('/pair', { origin: SITE })).body);
    expect(r.approved).toBe(false);
    expect(r.token).toBeUndefined();
    expect(r.code).toMatch(/^\d{4} \d{4}$/);
    approve = true;
  });

  let token = '';
  it('an approved pairing issues a token that works, stored hashed with 0600', async () => {
    const r = JSON.parse((await post('/pair', { origin: SITE })).body);
    expect(r.approved).toBe(true);
    token = r.token;
    expect((statSync(join(dir, 'serve-pairings.json')).mode & 0o777).toString(8)).toBe('600');
    expect(JSON.stringify(listPairings())).not.toContain(token);
    const ok = await post('/getPublicKey', { origin: SITE, authorization: `Bearer ${token}` });
    expect(ok.status).toBe(200);
    expect(calls).toEqual(['getPublicKey']);
  });

  it("a token is bound to its origin: another allowed-looking origin can't reuse it", async () => {
    const r = await post('/getPublicKey', { origin: 'https://evil.example', authorization: `Bearer ${token}` });
    expect(r.status).toBe(403); // not on the allowlist at all
  });

  it('a revoked token gets 401', async () => {
    expect(revokePairing('www.tokenblaster.lol')).toBe(true);
    const r = await post('/getPublicKey', { origin: SITE, authorization: `Bearer ${token}` });
    expect(r.status).toBe(401);
  });

  it('a bad Host header (DNS rebinding) gets 403', async () => {
    const r = await post('/getVersion', { origin: SITE, host: `evil.example:${port}` });
    expect(r.status).toBe(403);
  });
});
