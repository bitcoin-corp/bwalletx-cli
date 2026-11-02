import { describe, expect, test } from 'vitest';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import { PAYMAIL_API, SIGN_PROTOCOL, registerPaymail, signedMessage } from './paymail';

const key = PrivateKey.fromRandom(); // throwaway: never a real account
const ord = PrivateKey.fromRandom().toAddress();

describe('bwalletx paymail register', () => {
  test('the canonical string matches the wallet app: sorted fields, | separated', () => {
    expect(signedMessage('register', { timestamp: '1', alias: 'stamps', identityKey: '02ab' })).toBe(
      'bwallet-paymail|v1|register|alias=stamps|identityKey=02ab|timestamp=1',
    );
  });

  test('posts a register request signed by the identity key, plus the ordinal-address proof', async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    const paymail = await registerPaymail(key.toWif(), 'Stamps', ord, {
      now: 1793590000000,
      nonce: 'n1',
      fetch: async (url, init) => {
        sent = { url, body: JSON.parse(init.body) };
        return { ok: true, status: 200, json: async () => ({ paymail: 'stamps@bwalletx.com' }) };
      },
    });
    expect(paymail).toBe('stamps@bwalletx.com');
    const s = sent!;
    expect(s.url).toBe(`${PAYMAIL_API}/register`);
    const body = s.body as { identityKey: string; timestamp: number; fields: Record<string, string>; signature: string; ordProof: { timestamp: string; signature: string } };
    expect(body.identityKey).toBe(key.toPublicKey().toString());
    expect(body.fields).toEqual({ alias: 'stamps', ordAddress: ord, nonce: 'n1' });
    // The server rebuilds the same string and verifies with the anyone-counterparty key derived for [2,'bwallet paymail'] '1'.
    const verifier = new ProtoWallet('anyone');
    const msg = signedMessage('register', { ...body.fields, identityKey: body.identityKey, timestamp: String(body.timestamp) });
    const { valid } = await verifier.verifySignature({
      data: Utils.toArray(msg, 'utf8'),
      signature: Utils.toArray(body.signature, 'hex'),
      protocolID: SIGN_PROTOCOL,
      keyID: '1',
      counterparty: body.identityKey,
    });
    expect(valid).toBe(true);
    expect(body.ordProof.timestamp).toBe('1793590000000');
  });

  test('refuses a bad alias and surfaces the server error', async () => {
    await expect(registerPaymail(key.toWif(), 'no spaces', ord)).rejects.toThrow(/a-z/);
    await expect(
      registerPaymail(key.toWif(), 'abc', ord, { fetch: async () => ({ ok: false, status: 402, json: async () => ({ error: 'name-fee-required' }) }) }),
    ).rejects.toThrow('name-fee-required');
  });
});
