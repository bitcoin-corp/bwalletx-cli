/**
 * The PC miner's local page. Bound to 127.0.0.1 only; every request must carry this run's random token
 * (?t= on the page, x-token on the API), the Host header must be 127.0.0.1:<port> (DNS rebinding) and any Origin
 * header must be this page's own origin.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PublicKey } from '@bsv/sdk';
import QRCode from 'qrcode';
import type { Controller } from './controller.js';
import { checkTopUp, fundRoom, isAddress, readDest, readFunding, recordTopUp, writeDest, type Dest } from './app.js';
import { CAP_SATS, DEFAULT_FUND_USD, RANGE_LABEL, VAULT_PAY, VAULT_TO } from './defaults.js';

export type ServerDeps = {
  ctl: Controller;
  payAddress: string;
  html: string;
  connectJs: string;
  /** Sats waiting at the hot key's pay address (not yet moved into its wallet). */
  payBalance: () => Promise<number>;
  usdPerBsv: () => Promise<number>;
  onStop: () => void;
};

const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const allowed = (req: { headers: IncomingMessage['headers']; url?: string }, port: number, token: string) => {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}`) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}`) return false;
  const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const t = (req.headers['x-token'] as string | undefined) ?? u.searchParams.get('t') ?? '';
  return sameToken(t, token);
};

const body = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 10_000) reject(new Error('Too big'));
    });
    req.on('end', () => {
      try {
        resolve(s ? (JSON.parse(s) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('Bad JSON'));
      }
    });
  });

export function startServer(d: ServerDeps, port = 47402): Promise<{ url: string; port: number; close: () => void }> {
  const token = randomBytes(24).toString('base64url');
  let actualPort = port;
  const send = (res: ServerResponse, code: number, type: string, data: string | Buffer) => {
    res.writeHead(code, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    res.end(data);
  };
  const json = (res: ServerResponse, v: unknown, code = 200) => send(res, code, 'application/json', JSON.stringify(v));

  const server = createServer(async (req, res) => {
    try {
      if (!allowed(req, actualPort, token)) return send(res, 403, 'text/plain', 'Forbidden');
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (req.method === 'GET' && path === '/') return send(res, 200, 'text/html; charset=utf-8', d.html.replace('__TOKEN__', token));
      if (req.method === 'GET' && path === '/connect.js') return send(res, 200, 'text/javascript', d.connectJs);
      if (req.method === 'GET' && path === '/qr.svg')
        return send(res, 200, 'image/svg+xml', await QRCode.toString(`bitcoin:${d.payAddress}`, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } }));
      if (req.method === 'GET' && path === '/api/status') {
        const [s, bal, rate] = await Promise.all([d.ctl.status(), d.payBalance().catch(() => null), d.usdPerBsv().catch(() => null)]);
        const f = readFunding();
        return json(res, { ...s, payAddress: d.payAddress, payBalance: bal, usdPerBsv: rate, fundedSats: f.fundedSats, fundRoom: fundRoom(f), capSats: CAP_SATS, dest: readDest(), vaultTo: VAULT_TO, vaultPay: VAULT_PAY, range: RANGE_LABEL, defaultFundUsd: DEFAULT_FUND_USD });
      }
      if (req.method !== 'POST') return send(res, 404, 'text/plain', 'Not found');
      const b = await body(req);
      if (path === '/api/start') return await d.ctl.start(), json(res, { ok: true });
      if (path === '/api/pause') return await d.ctl.pause(), json(res, { ok: true });
      if (path === '/api/stop') {
        await d.ctl.pause();
        json(res, { ok: true });
        return d.onStop();
      }
      if (path === '/api/dest') {
        const cur = readDest();
        const next: Dest = { names: b.names === 'wallet' ? 'wallet' : 'vault', pay: b.pay === 'wallet' ? 'wallet' : 'vault', walletAddress: cur.walletAddress, walletIdentity: cur.walletIdentity };
        if (typeof b.identityKey === 'string' && /^0[23][0-9a-f]{64}$/i.test(b.identityKey)) {
          next.walletIdentity = b.identityKey;
          next.walletAddress = PublicKey.fromString(b.identityKey).toAddress();
        }
        if ((next.names === 'wallet' || next.pay === 'wallet') && !isAddress(next.walletAddress)) return json(res, { error: 'Connect bWalletX first' }, 400);
        writeDest(next);
        return json(res, { ok: true, dest: next, note: 'Applies from the next Start.' });
      }
      if (path === '/api/fund-quote') {
        const usd = Number(b.usd);
        const rate = await d.usdPerBsv();
        if (!(usd > 0) || !(rate > 0)) return json(res, { error: 'Bad amount or no BSV price' }, 400);
        const sats = Math.round((usd / rate) * 1e8);
        checkTopUp(sats);
        return json(res, { sats, to: d.payAddress, usd, usdPerBsv: rate });
      }
      if (path === '/api/funded') {
        const sats = Number(b.sats);
        const f = recordTopUp(sats, typeof b.txid === 'string' ? b.txid.slice(0, 64) : undefined);
        return json(res, { ok: true, fundedSats: f.fundedSats });
      }
      return send(res, 404, 'text/plain', 'Not found');
    } catch (e) {
      return json(res, { error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  return new Promise((resolve, reject) => {
    const tryListen = (p: number, left: number) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && left > 0) tryListen(p === 0 ? 0 : p + 1, left - 1);
        else reject(e);
      });
      server.listen(p, '127.0.0.1', () => {
        actualPort = (server.address() as { port: number }).port;
        resolve({ url: `http://127.0.0.1:${actualPort}/?t=${token}`, port: actualPort, close: () => server.close() });
      });
    };
    tryListen(port, 10);
  });
}
