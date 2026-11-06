/**
 * Start / pause / stop for the PC miner. Live mode runs the unchanged `bwalletx opns mint` code (opnsMint) on this
 * machine's hot account; pause and stop use the account's own kill flag, which the batch runner checks between
 * steps, so the current name is saved and the next Start resumes exactly there.
 * Dry mode runs the same batch runner (runHeadless) with a simulated chain: nothing is signed or broadcast.
 */
import { buildQueue, mergeState, newState, parseNameList, runHeadless, summarise, type RunResult, type State } from '../opns/batch.js';
import { ACCOUNT, CAP_SATS, VAULT_PAY, VAULT_TO } from './defaults.js';
import { clampBudget, listPath, readDest } from './app.js';
import { readFileSync } from 'node:fs';

export type Phase = 'idle' | 'running' | 'pausing' | 'paused' | 'finished' | 'budget' | 'funds' | 'error';

export type Status = {
  phase: Phase;
  dry: boolean;
  current: string | null;
  detail: string | null;
  rateHs: number;
  error: string | null;
  summary: ReturnType<typeof summarise> | null;
  recent: { name: string; at: number; txid?: string }[];
  to: string;
  payTo: string;
  capSats: number;
};

export const destinations = () => {
  const d = readDest();
  const to = d.names === 'wallet' && d.walletAddress ? d.walletAddress : VAULT_TO;
  const payTo = d.pay === 'wallet' && d.walletAddress ? d.walletAddress : VAULT_PAY;
  return { to, payTo };
};

export class Controller {
  phase: Phase = 'idle';
  current: string | null = null;
  detail: string | null = null;
  rateHs = 0;
  error: string | null = null;
  private state: State | null = null;
  private dryAbort: AbortController | null = null;

  constructor(readonly dry: boolean) {}

  private loadSaved = async (): Promise<State | null> => {
    if (this.dry) return this.state;
    const { loadState } = await import('../opns/headless.js');
    return loadState(ACCOUNT);
  };

  async status(): Promise<Status> {
    const s = this.dry ? this.state : await this.loadSaved();
    const recent = (s?.items ?? [])
      .filter((i) => (i.status === 'done' || i.status === 'mine') && i.doneAt)
      .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
      .slice(0, 20)
      .map((i) => ({ name: i.name, at: i.doneAt!, txid: i.txids[i.txids.length - 1] }));
    return {
      phase: this.phase,
      dry: this.dry,
      current: this.current,
      detail: this.detail,
      rateHs: this.rateHs,
      error: this.error,
      summary: s ? summarise(s) : null,
      recent,
      ...destinations(),
      capSats: CAP_SATS,
    };
  }

  private setStopFlag = async (on: boolean) => {
    if (this.dry) return;
    const { updateAccount } = await import('../store.js');
    updateAccount(ACCOUNT, { stopped: on });
  };

  /** Start or resume. Returns at once; the run goes on in the background. */
  async start() {
    if (this.phase === 'running' || this.phase === 'pausing') return;
    this.phase = 'running';
    this.error = null;
    await this.setStopFlag(false);
    const run = this.dry ? this.runDry() : this.runLive();
    run
      .then((r) => {
        this.current = null;
        this.phase = r.stopped === 'killed' || r.stopped === 'cancelled' ? 'paused' : r.stopped === 'error' ? 'error' : (r.stopped as Phase);
        if (r.error) this.error = r.error;
      })
      .catch((e: unknown) => {
        this.current = null;
        this.phase = 'error';
        this.error = e instanceof Error ? e.message : String(e);
      });
  }

  /** Pause = stop after the current step; everything is saved. */
  async pause() {
    if (this.phase !== 'running') return;
    this.phase = 'pausing';
    await this.setStopFlag(true);
    this.dryAbort?.abort();
  }

  private progress = (s: State, p?: { phase: string; name: string; domain?: string; rate?: number }) => {
    this.state = s;
    const cur = s.items.find((i) => i.status === 'mining');
    this.current = p?.name ?? cur?.name ?? null;
    this.detail = p ? `${p.phase}${p.domain ? ` ${p.domain}` : ''}` : null;
    if (p && typeof p.rate === 'number' && p.rate > 0) this.rateHs = p.rate;
  };

  private async runLive(): Promise<RunResult> {
    const { opnsMint } = await import('../opns/headless.js');
    const { to, payTo } = destinations();
    // Every name is a vault name: locked straight to `to`, never listed by the hot account.
    return opnsMint({ account: ACCOUNT, files: [], vault: listPath(), to, payTo, budgetSats: clampBudget(CAP_SATS), quiet: true, prune: true, onProgress: this.progress });
  }

  /** Same runner, simulated chain: each character takes ~150 ms and costs the live per-character estimate. */
  private async runDry(): Promise<RunResult> {
    const { to, payTo } = destinations();
    const names = parseNameList(readFileSync(listPath(), 'utf8')).names;
    const queue = buildQueue([], names);
    this.state = this.state
      ? mergeState(this.state, queue, { to, payTo, budgetSats: clampBudget(CAP_SATS) })
      : newState(ACCOUNT, queue, { to, payTo, budgetSats: clampBudget(CAP_SATS) });
    const ours = new Set<string>();
    this.dryAbort = new AbortController();
    const signal = this.dryAbort.signal;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    return runHeadless(
      {
        fetch: async (url) => (url.includes('/origin/') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ outpoint: `${'0'.repeat(64)}.1`, domain: '' }))),
        mine: async (name, lockTo, sig, onProgress) => {
          const steps: { txid: string; newDomain: string }[] = [];
          let from = 0;
          for (let k = name.length - 1; k > 0; k--) if (ours.has(name.slice(0, k))) (from = k), (k = 0);
          for (let k = from + 1; k <= name.length; k++) {
            if (sig.aborted) throw new (await import('../opns/opnsRegister.js')).MiningCancelled();
            const d = name.slice(0, k);
            onProgress({ phase: 'mining', domain: d, charIndex: k - from - 1, charsTotal: name.length - from, tried: 2 ** 22, rate: 9e6 } as never);
            await sleep(150);
            ours.add(d);
            steps.push({ txid: `dry-run-${d}`, newDomain: d });
          }
          void lockTo(name);
          return steps;
        },
        list: async () => 'dry-run-list',
        isListed: async () => false,
        rate: async () => 17,
        charsNeeded: async (n) => {
          for (let k = n.length - 1; k > 0; k--) if (ours.has(n.slice(0, k))) return n.length - k;
          return n.length;
        },
        isOurs: (n) => ours.has(n) && this.state!.items.some((i) => i.name === n && i.status === 'done'),
        stopped: () => this.phase === 'pausing',
        perCharSats: (await import('../opns/headless.js')).PER_CHAR_SATS,
        listFeeSats: 200,
        save: (s) => (this.state = s),
        onUpdate: (s, p) => this.progress(s, p as never),
      },
      this.state,
      signal,
    );
  }
}
