/**
 * Relay role claims for CLI pairing. Before this the CLI opened channels with no claim at all: any client could take
 * the site role, and the relay would stop admitting the CLI once its compatibility window closes (30 Nov 2026).
 * Wallet claim v2 (12 Nov 2026): the QR-bound wallet claim admits the first join only; afterwards the relay binds
 * the phone's role to a session claim only the phone and the CLI can compute, and the CLI re-binds it on connect.
 */
import { PrivateKey } from '@bsv/sdk';
import { describe, expect, it } from 'vitest';
import { claimDigest, newClaim, sessionWalletClaim, walletClaimFor } from './pair/protocol.js';
import { learnsWalletClaimV2, newChannelUrl, pairedSiteUrl, type Pairing } from './paired.js';

const P = PrivateKey.fromHex('11'.repeat(32)); // phone pairing key
const S = PrivateKey.fromHex('22'.repeat(32)); // CLI pairing key
const C = 'AAAAAAAAAAAAAAAAAAAAAA';
const SPUB = S.toPublicKey().toString();
// Shared with bWalletX (src/pair/relayClaims.test.ts) and @bwalletx/connect (test/pair.test.ts).
const SESSION_VECTOR = 'rTgy5TUbOz2xUwLyqYebrIyLaQifFhULNSSHHklw0gQ';
const QR_VECTOR = '3zmps36M9drn-julUEit5gxRUdWh5iMMGek6vf01Mzg';

const pairing = (extra: Partial<Pairing> = {}): Pairing => ({
  format: 'bwalletx.pairing/1',
  name: 'agent',
  c: C,
  r: 'relay.bwallet.space',
  s: S.toHex(),
  k: P.toPublicKey().toString(),
  sent: 0,
  lastSeen: 0,
  account: 'a',
  identityAddress: '1x',
  scopes: [],
  expiresAt: Date.now() + 60_000,
  pairedAt: Date.now(),
  ...extra,
});

describe('claims match bWalletX and @bwalletx/connect byte for byte', () => {
  it('QR-bound claim, session claim and digest', () => {
    expect(walletClaimFor(C, SPUB)).toBe(QR_VECTOR);
    expect(sessionWalletClaim(S, P.toPublicKey().toString(), C)).toBe(SESSION_VECTOR);
    expect(sessionWalletClaim(P, SPUB, C)).toBe(SESSION_VECTOR);
    expect(claimDigest(SESSION_VECTOR)).toBe('70d13b85c6bf389eafdc3d9b1c155826fda8517003bf2f4a8600b4dc0d06e759');
  });

  it('the QR alone does not give the session claim', () => {
    expect(sessionWalletClaim(PrivateKey.fromRandom(), SPUB, C)).not.toBe(SESSION_VECTOR);
    expect(QR_VECTOR).not.toBe(SESSION_VECTOR);
  });
});

describe('CLI site sockets', () => {
  it('a new channel carries our site claim and the digest of the QR-bound wallet claim', () => {
    const sc = newClaim();
    const u = new URL(newChannelUrl('relay.bwallet.space', C, SPUB, 123, sc));
    expect(u.searchParams.get('role')).toBe('site');
    expect(u.searchParams.get('claim')).toBe(sc);
    expect(u.searchParams.get('wc')).toBe(claimDigest(QR_VECTOR));
    expect(u.searchParams.get('e')).toBe('123');
  });

  it('a pairing saved before claims gets a site claim on its next connect, saved, plus the QR-bound wc', () => {
    const saved: Pairing[] = [];
    const p = pairing();
    const u = new URL(pairedSiteUrl(p, 1, (x) => saved.push({ ...x })));
    expect(u.searchParams.get('claim')).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    expect(saved).toHaveLength(1);
    expect(saved[0].sc).toBe(u.searchParams.get('claim'));
    // A re-created channel is bound to the QR claim, so the channel ID alone isn't enough to take the phone's role.
    expect(u.searchParams.get('wc')).toBe(claimDigest(QR_VECTOR));
    // The next connect reuses it.
    const again = new URL(pairedSiteUrl(p, 1, (x) => saved.push(x)));
    expect(again.searchParams.get('claim')).toBe(saved[0].sc);
    expect(saved).toHaveLength(1);
  });

  it('a v2 pairing re-binds the phone with the session claim digest on every connect', () => {
    const sc = newClaim();
    const u = new URL(pairedSiteUrl(pairing({ sc, wv: 2 }), 1, () => {}));
    expect(u.searchParams.get('claim')).toBe(sc);
    expect(u.searchParams.get('wc')).toBe(claimDigest(SESSION_VECTOR));
    expect(u.searchParams.get('nc')).toBeNull();
  });

  it("a v1 pairing becomes v2 when the phone's sealed ready names the session claim we derive", () => {
    const nc = claimDigest(SESSION_VECTOR);
    expect(learnsWalletClaimV2(pairing(), { t: 'ready', wcv: 2, nc })).toBe(true);
    expect(learnsWalletClaimV2(pairing(), { t: 'ready', wcv: 2 })).toBe(false);
    expect(learnsWalletClaimV2(pairing(), { t: 'ready', wcv: 2, nc: 'f'.repeat(64) })).toBe(false);
    expect(learnsWalletClaimV2(pairing(), { t: 'ready' })).toBe(false);
    expect(learnsWalletClaimV2(pairing({ wv: 2 }), { t: 'ready', wcv: 2, nc })).toBe(false);
    expect(learnsWalletClaimV2(pairing(), { t: 'ping' })).toBe(false);
  });
});
