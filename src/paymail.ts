/**
 * `bwalletx paymail register <alias>`: give an agent account a name@bwalletx.com paymail.
 *
 * The bWallet paymail server (pay.bwallet.space) takes a 'register' request signed by the account's identity key
 * (BRC-43 protocol [2,'bwallet paymail'], keyID '1', counterparty 'anyone') over its canonical string, exactly as the
 * wallet app does (bWalletX src/mobile/names/paymail.ts). It also takes a standing 'ord' proof tying the account's
 * ordinal address to the key. Nothing secret leaves this machine; the server learns only public keys. Names of 5+
 * characters are free (paid tiers are for 1-4 characters); the server says so if a fee is due.
 */
import { randomBytes } from 'node:crypto';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';

export const PAYMAIL_API = 'https://pay.bwallet.space/api/paymail';
export const PAYMAIL_DOMAIN = 'bwalletx.com';
export const SIGN_PROTOCOL: [2, string] = [2, 'bwallet paymail'];
export const ALIAS_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;

/** The server's canonical string: sorted fields, joined with '|'. */
export const signedMessage = (action: string, fields: Record<string, string>) =>
  ['bwallet-paymail', 'v1', action, ...Object.keys(fields).sort().map((k) => `${k}=${fields[k] ?? ''}`)].join('|');

type Signer = Pick<ProtoWallet, 'getPublicKey' | 'createSignature'>;

export async function signRequest(w: Signer, action: string, fields: Record<string, string>, now = Date.now()) {
  const { publicKey: identityKey } = await w.getPublicKey({ identityKey: true });
  const all = { ...fields, identityKey, timestamp: String(now) };
  const { signature } = await w.createSignature({
    data: Utils.toArray(signedMessage(action, all), 'utf8'),
    protocolID: SIGN_PROTOCOL,
    keyID: '1',
    counterparty: 'anyone',
  });
  return { identityKey, timestamp: now, fields, signature: Utils.toHex(signature) };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** Register `alias`@bwalletx.com for the identity key, with the account's ordinal address. Returns the paymail. */
export async function registerPaymail(
  identityWif: string,
  alias: string,
  ordAddress: string,
  o: { fetch?: FetchLike; now?: number; nonce?: string } = {},
): Promise<string> {
  const a = alias.trim().toLowerCase();
  if (!ALIAS_RE.test(a)) throw new Error('Use a-z, 0-9, - or _ (up to 32 characters)');
  const w = new ProtoWallet(PrivateKey.fromWif(identityWif));
  const now = o.now ?? Date.now();
  // 'register' carries a random nonce (the server refuses one it has seen); 'ord' is a standing proof, no nonce.
  const signed = await signRequest(w, 'register', { alias: a, ordAddress, nonce: o.nonce ?? randomBytes(16).toString('hex') }, now);
  const ord = await signRequest(w, 'ord', { ordAddress }, now);
  const f = o.fetch ?? (fetch as unknown as FetchLike);
  const r = await f(`${PAYMAIL_API}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...signed, ordProof: { timestamp: String(ord.timestamp), signature: ord.signature } }),
  });
  const j = (await r.json().catch(() => ({}))) as { paymail?: string; error?: string };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return String(j.paymail ?? `${a}@${PAYMAIL_DOMAIN}`);
}
