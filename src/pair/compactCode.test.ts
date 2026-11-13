import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import { base32, compactPairCode } from './protocol';

describe('compact pairing code (the terminal QR)', () => {
  // Shared vector with bWalletX src/pair/protocol.test.ts ("compact pairing code").
  const CODE = 'BWX1:AAAQEAYEAUDAOCAJBIFQYDIOB4:AKV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2W';

  it('matches the wallet vector', () => {
    expect(base32(Uint8Array.from({ length: 16 }, (_, i) => i))).toBe('AAAQEAYEAUDAOCAJBIFQYDIOB4');
    expect(compactPairCode('AAECAwQFBgcICQoLDA0ODw', '02' + 'ab'.repeat(32))).toBe(CODE);
  });

  it('is an alphanumeric QR of 33 modules (the full link is 49)', () => {
    const q = QRCode.create(CODE, { errorCorrectionLevel: 'L' });
    expect(q.modules.size).toBe(33);
    expect(q.segments.every((s: { mode: { id: string } }) => s.mode.id === 'Alphanumeric')).toBe(true);
  });
});
