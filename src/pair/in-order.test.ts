import { describe, expect, it } from 'vitest';
import { PrivateKey } from '@bsv/sdk';
import { Sealer, deriveSession, newChannel, type HelloFrame } from './protocol.js';
import { inOrder } from './in-order.js';

describe('inOrder', () => {
  it('a ready sent right after hello is handled once the key exists', async () => {
    const c = newChannel();
    const S = PrivateKey.fromRandom();
    const P = PrivateKey.fromRandom();
    const phone = new Sealer((await deriveSession(P, S.toPublicKey().toString(), c)).key, 'wallet');
    const hello = JSON.stringify({ t: 'hello', k: P.toPublicKey().toString(), info: { name: 't', rdns: 'space.bwallet.mobile' } });
    const ready = JSON.stringify(await phone.seal({ t: 'ready' }));

    const run = async (queued: boolean) => {
      let sealer: Sealer | null = null;
      let gotReady = false;
      const handler = async (raw: unknown) => {
        const f = JSON.parse(String(raw));
        if ((f as HelloFrame).t === 'hello' && !sealer) {
          sealer = new Sealer((await deriveSession(S, (f as HelloFrame).k, c)).key, 'site');
          return;
        }
        if (sealer && (await sealer.open(f))?.t === 'ready') gotReady = true;
      };
      const on = queued ? inOrder(handler) : (raw: unknown) => void handler(raw);
      on(hello);
      on(ready);
      await new Promise((r) => setTimeout(r, 100));
      return gotReady;
    };
    expect(await run(false)).toBe(false); // the race, reproduced
    expect(await run(true)).toBe(true);
  });
});
