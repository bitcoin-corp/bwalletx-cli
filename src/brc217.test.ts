import { describe, expect, test } from 'vitest';
import { Hash, PrivateKey, Utils } from '@bsv/sdk';
import {
  assemble,
  authorSection,
  finish,
  mapSection,
  messageHash,
  relayout,
  signRangeWithKey,
  verifyBrc217,
  verifySignature,
} from './brc217.js';

/** Every vector in BRC-217 (tokens/0217.md, "Test Vectors"), byte for byte. */
const hex = (h: string) => Utils.toArray(h, 'hex');
const toHex = (b: number[]) => Utils.toHex(b);
const label = (role: string) =>
  PrivateKey.fromString(
    Utils.toHex(Hash.sha256(Utils.toArray(`authenticated 1sat inscription test vector: ${role}`, 'utf8'))),
    16,
  );

const V = {
  authorPriv: 'ca0065cf294c6b177f691a0cee75de69cd1d954e7014f9234cc754fc1104d275',
  authorPub: '036607e10de88ac1ec8875fdf3c001b656005a9896d6e707c74caaa1557d4770bf',
  authorAddr: '1Che5twEjMQZf4hejsrZ8gkp6SGGTMhXpB',
  ownerPriv: '7336d09f2b45400d5e7f527ad73de14a74c995451f7ff5fe654cadd9077b6435',
  ownerPub: '03c6ce6bf120bf6ca32558c97fdce2da10a34c4f0e5f213f903f4c0928cc9d4a7c',
  otherAddr: '1FZVqS6fZ6ELNQDcuHRCF1CGi1DHBaD9yQ',
  lock: '76a9141e465cb42dde36eeeac5c4a68745b269a844d66688ac',
  envelope: '0063036f7264510a746578742f706c61696e000d68656c6c6f206f7264696e616c68',
  map: '223150755161374b36324d694b43747373534c4b79316b683536575755374d745552350353455403617070036170700474797065036f7264046e616d65034f6e65',
  a: {
    range:
      '76a9141e465cb42dde36eeeac5c4a68745b269a844d66688ac0063036f7264510a746578742f706c61696e000d68656c6c6f206f7264696e616c686a223150755161374b36324d694b43747373534c4b79316b683536575755374d745552350353455403617070036170700474797065036f7264046e616d65034f6e65',
    hash: '6770f94345cd6ef1166d86156bcdb3d3c709b813603abbe889fa2315f2f875dd',
    sig: '20213c2d32b58eb3a2c2813cb909dbd5c66b30877ef8862880304ee8bb3eb7aab76274204b7c0b508ff02aacd26eb1fdfd3e258afc5aa4e41c347be4e73728077e',
    author:
      '017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676612231436865357477456a4d515a663468656a73725a38676b7036534747544d685870420d424954434f494e5f45434453414120213c2d32b58eb3a2c2813cb909dbd5c66b30877ef8862880304ee8bb3eb7aab76274204b7c0b508ff02aacd26eb1fdfd3e258afc5aa4e41c347be4e73728077e022d31',
    full: '76a9141e465cb42dde36eeeac5c4a68745b269a844d66688ac0063036f7264510a746578742f706c61696e000d68656c6c6f206f7264696e616c686a223150755161374b36324d694b43747373534c4b79316b683536575755374d745552350353455403617070036170700474797065036f7264046e616d65034f6e65017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676612231436865357477456a4d515a663468656a73725a38676b7036534747544d685870420d424954434f494e5f45434453414120213c2d32b58eb3a2c2813cb909dbd5c66b30877ef8862880304ee8bb3eb7aab76274204b7c0b508ff02aacd26eb1fdfd3e258afc5aa4e41c347be4e73728077e022d31',
    sha: '846278345f60241bda23d9ce7d4a0d294ff7137b0c41cffe4e63b150f6a6883c',
  },
  b: {
    range:
      '76a9141e465cb42dde36eeeac5c4a68745b269a844d66688ac0063036f7264510a746578742f706c61696e000d68656c6c6f206f7264696e616c686a',
    hash: '98cf3bf18ab3c60b95908eb1bc52812bc0c6c9f82facaae38126b298e7137fa1',
    sig: '203fbd405503e1b8c0459cb76603e3a18221987454c93007a0e6927d9474c828f2545b9d08bbd0f9e626e6cc0d6f99af75a342b46f8b17265998e9ce8325fc49ed',
    full: '76a9141e465cb42dde36eeeac5c4a68745b269a844d66688ac0063036f7264510a746578742f706c61696e000d68656c6c6f206f7264696e616c686a22313550636948473232534e4c514a584d6f53556157566937575371633768436676612231436865357477456a4d515a663468656a73725a38676b7036534747544d685870420d424954434f494e5f454344534141203fbd405503e1b8c0459cb76603e3a18221987454c93007a0e6927d9474c828f2545b9d08bbd0f9e626e6cc0d6f99af75a342b46f8b17265998e9ce8325fc49ed022d31',
    sha: '62b27c3f0d561070afd76b5d1780d5e42cf5aa4594c681944e331f251766b53a',
  },
  fail: {
    pipeSig:
      '1f52964f6545c9498141c445b10fb6d1e6c864a664e2600a4992b3682ebe235a69299830431dcb490defb0d07dc6464f5659897c7f295c6a8636a62115145bdee7',
    wrongKeySig:
      '20587cfbf6894f03072c5d5bd0f1428b0e45fd9454d5e33c032edb4d7f0d5df05035db4b0010dfa822ba683a749e1b7c1e1bdc42f371c40a9a435380c915a905f4',
    reversedAuthor:
      '017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676610d424954434f494e5f45434453412231436865357477456a4d515a663468656a73725a38676b7036534747544d685870424120213c2d32b58eb3a2c2813cb909dbd5c66b30877ef8862880304ee8bb3eb7aab76274204b7c0b508ff02aacd26eb1fdfd3e258afc5aa4e41c347be4e73728077e022d31',
    base64Text: 'ICE8LTK1jrOiwoE8uQnb1cZrMId++IYogDBO6Ls+t6q3YnQgS3wLUI/wKqzSbrH9/T4livxapOQcNHvk5zcoB34=',
    base64Author:
      '017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676612231436865357477456a4d515a663468656a73725a38676b7036534747544d685870420d424954434f494e5f45434453414c58494345384c544b316a724f69776f453875516e6231635a724d49642b2b49596f6744424f364c732b74367133596e51675333774c55492f774b717a53627248392f54346c69767861704f51634e48766b357a636f4233343d022d31',
  },
  spendable:
    '76a9141e465cb42dde36eeeac5c4a68745b269a844d66688ac0063036f7264510a746578742f706c61696e000d68656c6c6f206f7264696e616c686a',
  unspendable:
    '76a9141e465cb42dde36eeeac5c4a68745b269a844d66688ac0063036f7264510a746578742f706c61696e000d68656c6c6f206f7264696e616c68006a',
};

const author = label('author identity key');
const owner = label('owner key');
const other = label('another identity key');

describe('BRC-217 keys', () => {
  test('keys and addresses', () => {
    expect(author.toHex()).toBe(V.authorPriv);
    expect(author.toPublicKey().toString()).toBe(V.authorPub);
    expect(author.toPublicKey().toAddress()).toBe(V.authorAddr);
    expect(owner.toHex()).toBe(V.ownerPriv);
    expect(owner.toPublicKey().toString()).toBe(V.ownerPub);
    expect(other.toPublicKey().toAddress()).toBe(V.otherAddr);
  });
  test('building blocks', () => {
    expect(Utils.toHex(owner.toPublicKey().toHash() as number[])).toBe(V.lock.slice(6, 46));
    expect(hex(V.lock).length).toBe(25);
    expect(hex(V.envelope).length).toBe(34);
    expect(
      toHex(
        mapSection([
          ['app', 'app'],
          ['type', 'ord'],
          ['name', 'One'],
        ]),
      ),
    ).toBe(V.map);
    expect(hex(V.map).length).toBe(65);
  });
});

describe('BRC-217 pass vectors', () => {
  test('case A: metadata + author section', () => {
    const u = assemble(hex(V.lock), hex(V.envelope), hex(V.map));
    expect(toHex(u.signedRange)).toBe(V.a.range);
    expect(u.signedRange.length).toBe(125);
    expect(toHex(messageHash(u.signedRange))).toBe(V.a.hash);
    const sig = signRangeWithKey(u.signedRange, author);
    expect(toHex(sig)).toBe(V.a.sig);
    expect(toHex(authorSection(V.authorAddr, sig, true))).toBe(V.a.author);
    const full = finish(u, V.authorAddr, sig);
    expect(toHex(full)).toBe(V.a.full);
    expect(full.length).toBe(280);
    expect(Utils.toHex(Hash.sha256(full))).toBe(V.a.sha);
    const v = verifyBrc217(V.a.full);
    expect(v.ok && v.address).toBe(V.authorAddr);
    expect(v.ok && v.map).toEqual({ app: 'app', type: 'ord', name: 'One' });
  });
  test('case B: no metadata, no pipe', () => {
    const u = assemble(hex(V.lock), hex(V.envelope), null);
    expect(toHex(u.signedRange)).toBe(V.b.range);
    expect(u.signedRange.length).toBe(60);
    expect(toHex(messageHash(u.signedRange))).toBe(V.b.hash);
    const sig = signRangeWithKey(u.signedRange, author);
    expect(toHex(sig)).toBe(V.b.sig);
    const full = finish(u, V.authorAddr, sig);
    expect(toHex(full)).toBe(V.b.full);
    expect(full.length).toBe(213);
    expect(Utils.toHex(Hash.sha256(full))).toBe(V.b.sha);
    const v = verifyBrc217(V.b.full);
    expect(v.ok && v.address).toBe(V.authorAddr);
  });
});

describe('BRC-217 fail vectors', () => {
  const caseA = (authorHex: string) => V.a.range + authorHex;
  test('pipe inside the signed range', () => {
    expect(toHex(signRangeWithKey([...hex(V.a.range), 0x01, 0x7c], author))).toBe(V.fail.pipeSig);
    const s = caseA(toHex(authorSection(V.authorAddr, hex(V.fail.pipeSig), true)));
    expect(verifyBrc217(s)).toEqual({ ok: false, reason: 'invalid signature' });
  });
  test('wrong key', () => {
    expect(toHex(signRangeWithKey(hex(V.a.range), other))).toBe(V.fail.wrongKeySig);
    expect(verifySignature(hex(V.a.range), hex(V.fail.wrongKeySig), V.otherAddr)).toBe(true);
    const s = caseA(toHex(authorSection(V.authorAddr, hex(V.fail.wrongKeySig), true)));
    expect(verifyBrc217(s).ok).toBe(false);
  });
  test('tampered content keeps the case A signature', () => {
    const tampered = V.a.full.replace('6f7264696e616c68', '6f7264696e613168');
    expect(tampered).toContain('6f7264696e6131');
    expect(verifyBrc217(tampered)).toEqual({ ok: false, reason: 'invalid signature' });
  });
  test('reversed (generic AIP) field order', () => {
    expect(verifyBrc217(caseA(V.fail.reversedAuthor)).ok).toBe(false);
  });
  test('base64 signature', () => {
    expect(btoa(String.fromCharCode(...hex(V.a.sig)))).toBe(V.fail.base64Text);
    expect(V.fail.base64Author).toContain(Utils.toHex(Utils.toArray(V.fail.base64Text, 'utf8')));
    expect(verifyBrc217(caseA(V.fail.base64Author))).toEqual({ ok: false, reason: 'signature is not 65 raw bytes' });
  });
  test('the two OP_RETURN forms', () => {
    expect(V.a.full.startsWith(V.spendable)).toBe(true);
    expect(V.spendable.endsWith('686a')).toBe(true);
    expect(V.unspendable).toBe(V.spendable.slice(0, -2) + '006a');
    // An author section behind OP_FALSE OP_RETURN is rejected even though its signature is over its own bytes (R15).
    const range = [...hex(V.unspendable), ...hex(V.map)];
    const s = toHex([...range, ...authorSection(V.authorAddr, signRangeWithKey(range, author), true)]);
    expect(verifyBrc217(s)).toEqual({ ok: false, reason: 'OP_FALSE OP_RETURN: not a transferable inscription' });
  });
  test('high-s and bad headers fail closed', () => {
    const sig = hex(V.a.sig);
    expect(verifySignature(hex(V.a.range), [0x1a, ...sig.slice(1)], V.authorAddr)).toBe(false);
    expect(verifySignature(hex(V.a.range), [0x23, ...sig.slice(1)], V.authorAddr)).toBe(false);
    expect(
      verifySignature(hex(V.a.range), [sig[0], ...sig.slice(1, 33), ...new Array(32).fill(0xff)], V.authorAddr),
    ).toBe(false);
  });
});

describe('relayout (the old @1sat envelope-first script → BRC-217 signed range)', () => {
  const old = (map: string) => V.envelope + V.lock + (map ? '6a' + map : '');
  test('moves the lock first and keeps every byte', () => {
    const u = relayout(old(V.map))!;
    expect(toHex(u.signedRange)).toBe(V.a.range);
    expect(toHex(finish(u, V.authorAddr, signRangeWithKey(u.signedRange, author)))).toBe(V.a.full);
  });
  test('no MAP: case B', () => {
    const u = relayout(old(''))!;
    expect(toHex(finish(u, V.authorAddr, signRangeWithKey(u.signedRange, author)))).toBe(V.b.full);
  });
  test('extra MAP pairs land at the end of the MAP section and verify', () => {
    const u = relayout(old(V.map), [['identity_key', V.authorPub]])!;
    const v = verifyBrc217(toHex(finish(u, V.authorAddr, signRangeWithKey(u.signedRange, author))));
    expect(v.ok && v.map.identity_key).toBe(V.authorPub);
  });
  test('refuses what it should not touch', () => {
    expect(relayout(V.a.full)).toBeNull(); // already lock-first
    expect(relayout(old(V.map) + '017c' + '0141')).toBeNull(); // a second Bitcom section
    expect(relayout(V.lock)).toBeNull(); // no envelope
  });
});
