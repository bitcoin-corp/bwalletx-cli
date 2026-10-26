/**
 * BRC-217 test-mint helpers (scripts/brc217-test-mint.mjs, scripts/brc217-check.mjs).
 *
 * Mirrors bitcoin-corp/bwallet PR #194: issuerSign.ts withBrc217 (signing key = the identity key's BRC-42 child
 * [2,'bwallet issuer'] / '1' / counterparty 'anyone', through the wallet's createSignature) and issuer.ts
 * verifyIssueTx (MAP identity_key must derive the author address). Pure byte work plus one wallet call.
 */
import { Hash, KeyDeriver, P2PKH, PrivateKey, PublicKey, Signature, Utils, type WalletInterface } from '@bsv/sdk';
import {
  assemble,
  authorSection,
  finish,
  mapSection,
  messageHash,
  push,
  signRangeWithKey,
  toRecoverable,
  verifyBrc217,
  type Brc217Verdict,
} from './brc217.js';

export const ISSUER_PROTOCOL: [2, string] = [2, 'bwallet issuer'];
export const ISSUER_KEY_ID = '1';
export const isIdentityKey = (k: unknown): k is string => typeof k === 'string' && /^0[23][0-9a-f]{64}$/i.test(k);

/** issuer.ts issuerSigningKey: the BRC-42 child anyone can derive from the identity key. */
export const issuerSigningKey = (identityKey: string): PublicKey =>
  new KeyDeriver(new PrivateKey(1)).derivePublicKey(ISSUER_PROTOCOL, ISSUER_KEY_ID, identityKey, false);

/** `OP_FALSE OP_IF "ord" OP_1 <type> OP_0 <body> OP_ENDIF` (the 1Sat envelope, as in the BRC-217 vectors). */
export function ordEnvelope(contentType: string, body: number[]): number[] {
  return [0x00, 0x63, ...push(Utils.toArray('ord', 'utf8')), 0x51, ...push(Utils.toArray(contentType, 'utf8')), 0x00, ...push(body), 0x68];
}

export type TestMintParts = { lock: number[]; envelope: number[]; pairs: [string, string][] };

/** The PR #194 layout's parts: lock to `address`, MAP app/type/name then identity_key (relayout appends it last). */
export function testMintParts(o: { address: string; contentType: string; body: number[]; name: string; identityKey: string }): TestMintParts {
  return {
    lock: new P2PKH().lock(o.address).toBinary(),
    envelope: ordEnvelope(o.contentType, o.body),
    pairs: [
      ['app', 'bWallet'],
      ['type', 'ord'],
      ['name', o.name],
      ['identity_key', o.identityKey.toLowerCase()],
    ],
  };
}

/** Sign the parts through a BRC-100 wallet exactly as issuerSign.ts withBrc217 does; returns the full script hex. */
export async function signWithWallet(wallet: WalletInterface, parts: TestMintParts): Promise<{ scriptHex: string; author: string }> {
  const keyArgs = { protocolID: ISSUER_PROTOCOL, keyID: ISSUER_KEY_ID, counterparty: 'anyone' as const };
  const { publicKey } = await wallet.getPublicKey({ ...keyArgs, forSelf: true });
  const pub = PublicKey.fromString(publicKey);
  const address = pub.toAddress();
  const u = assemble(parts.lock, parts.envelope, mapSection(parts.pairs));
  const hash = messageHash(u.signedRange);
  const { signature } = await wallet.createSignature({ ...keyArgs, hashToDirectlySign: hash });
  const sig = toRecoverable(Signature.fromDER(Array.from(signature)), pub, hash);
  return { scriptHex: Utils.toHex(finish(u, address, sig)), author: address };
}

/** Same with a raw key (offline dry run with a throwaway key). */
export function signWithKey(identity: PrivateKey, parts: TestMintParts): { scriptHex: string; author: string } {
  const child = new KeyDeriver(identity).derivePrivateKey(ISSUER_PROTOCOL, ISSUER_KEY_ID, 'anyone');
  const u = assemble(parts.lock, parts.envelope, mapSection(parts.pairs));
  const address = child.toPublicKey().toAddress();
  return { scriptHex: Utils.toHex(finish(u, address, signRangeWithKey(u.signedRange, child))), author: address };
}

export type MintVerdict = (Brc217Verdict & { ok: true; identityKey: string }) | { ok: false; reason: string };

/** verifyIssueTx's BRC-217 branch: valid signature AND author address == issuer child of MAP identity_key. */
export function verifyMintScript(scriptHex: string): MintVerdict {
  const b = verifyBrc217(scriptHex);
  if (!b.ok) return b;
  const key = b.map.identity_key;
  if (!isIdentityKey(key)) return { ok: false, reason: 'bad identity key' };
  if (issuerSigningKey(key).toAddress() !== b.address) return { ok: false, reason: 'signature is not from the stated identity' };
  return { ...b, identityKey: key.toLowerCase() };
}

/** BRC-217 test vector A (tokens/0217.md), reproduced before anything is built. Throws on any mismatch. */
export function selfCheckVectorA(): string {
  const V = {
    lock: '76a9141e465cb42dde36eeeac5c4a68745b269a844d66688ac',
    envelope: '0063036f7264510a746578742f706c61696e000d68656c6c6f206f7264696e616c68',
    authorAddr: '1Che5twEjMQZf4hejsrZ8gkp6SGGTMhXpB',
    sig: '20213c2d32b58eb3a2c2813cb909dbd5c66b30877ef8862880304ee8bb3eb7aab76274204b7c0b508ff02aacd26eb1fdfd3e258afc5aa4e41c347be4e73728077e',
    sha: '846278345f60241bda23d9ce7d4a0d294ff7137b0c41cffe4e63b150f6a6883c',
    hash: '6770f94345cd6ef1166d86156bcdb3d3c709b813603abbe889fa2315f2f875dd',
  };
  const hex = (h: string) => Utils.toArray(h, 'hex');
  const author = PrivateKey.fromString(
    Utils.toHex(Hash.sha256(Utils.toArray('authenticated 1sat inscription test vector: author identity key', 'utf8'))),
    16,
  );
  // Our envelope builder must reproduce the vector's envelope too.
  const env = Utils.toHex(ordEnvelope('text/plain', Utils.toArray('hello ordinal', 'utf8')));
  if (env !== V.envelope) throw new Error(`vector A: envelope mismatch ${env}`);
  const u = assemble(hex(V.lock), hex(V.envelope), mapSection([['app', 'app'], ['type', 'ord'], ['name', 'One']]));
  if (Utils.toHex(messageHash(u.signedRange)) !== V.hash) throw new Error('vector A: message hash mismatch');
  const sig = signRangeWithKey(u.signedRange, author);
  if (Utils.toHex(sig) !== V.sig) throw new Error('vector A: signature mismatch');
  const full = [...u.signedRange, ...authorSection(V.authorAddr, sig, true)];
  if (full.length !== 280 || Utils.toHex(Hash.sha256(full)) !== V.sha) throw new Error('vector A: script sha256 mismatch');
  const v = verifyBrc217(Utils.toHex(full));
  if (!v.ok || v.address !== V.authorAddr) throw new Error('vector A: verifier rejected the vector');
  return V.sha;
}
