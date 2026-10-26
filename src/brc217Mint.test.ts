import { describe, expect, test } from 'vitest';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { selfCheckVectorA, signWithKey, signWithWallet, testMintParts, verifyMintScript } from './brc217Mint.js';

const png = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3];

describe('BRC-217 test mint', () => {
  test('vector A self-check', () => expect(selfCheckVectorA()).toMatch(/^8462/));
  test('wallet path (createSignature) and raw-key path give the same verifying script', async () => {
    const id = PrivateKey.fromRandom();
    const parts = testMintParts({ address: PrivateKey.fromRandom().toAddress(), contentType: 'image/png', body: png, name: 'BRC-217 test', identityKey: id.toPublicKey().toString() });
    const a = await signWithWallet(new ProtoWallet(id), parts);
    const b = signWithKey(id, parts);
    expect(a.scriptHex).toBe(b.scriptHex);
    const v = verifyMintScript(a.scriptHex);
    expect(v.ok && v.map).toEqual({ app: 'bWallet', type: 'ord', name: 'BRC-217 test', identity_key: id.toPublicKey().toString() });
  });
  test('a wrong identity_key is refused', () => {
    const id = PrivateKey.fromRandom();
    const parts = testMintParts({ address: id.toAddress(), contentType: 'image/png', body: png, name: 'x', identityKey: PrivateKey.fromRandom().toPublicKey().toString() });
    expect(verifyMintScript(signWithKey(id, parts).scriptHex)).toEqual({ ok: false, reason: 'signature is not from the stated identity' });
  });
});
