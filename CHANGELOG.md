# Changelog

## 0.6.1 (unreleased)

A money fix for `serve`. If an app uses noSend through `bwalletx serve`, or sites can reach your serve, upgrade.

- **`serve` no longer broadcasts a transaction built with `noSend`.** In local and shared mode serve handed every
  createAction/signAction result to ARC, including a "build only, don't send" one. An app doing a two-phase send
  (build with `noSend`, check, then `sendWith` or `abortAction`) got a broadcast it didn't ask for; if it then
  aborted, the wallet marked the action failed while the payment was on the network, so it could pay twice and
  lose the record. serve now relays only the txids the wallet itself sent or queued (its `sendWithResults`, minus
  any marked failed), never a noSend build itself. A later `createAction { options: { sendWith } }` relays exactly
  those txids, parents first. signAction follows the noSend option of its createAction when it doesn't set one.
  Paired mode never relayed and is unchanged.
- **A site can only send its own builds.** `sendWith`, `noSendChange`, `signAction` and `abortAction` are refused
  when they name a build another site made, or one serve didn't make in this session: another app's noSend build
  on the same wallet (the bWalletX app in shared mode, `bwalletx store buy` between build and claim) could
  otherwise be sent by any paired site for nothing under the caps. A build from before a serve restart can't be
  sent with `sendWith`: abort it and build again.
- **Network fees count.** In local and shared mode every build is made noSend first and priced from the signed
  tx (inputs minus outputs). The fee counts toward the per-payment cap, the session budget and the daily cap, and
  a new per-payment fee cap, `serve --max-fee-sats` (default 10,000 sats, ~100 KB of data), refuses anything
  dearer. A refused build is aborted and never leaves the machine. Then serve sends it (unless the site asked for
  noSend). A fee-only action (a 0-sat data write) is now logged as a spend, so it counts for the rate limit.
  Before, a site could spend 20,000+ sats in fees on one 200 KB data write with every USD cap at $0.
- **`getVersion` from serve now answers `bwalletx-serve-<version>`** (this release: `bwalletx-serve-0.6.1`),
  signed in or not. In paired mode it adds the phone's PIN level, `bwalletx-serve-0.6.1; pin=N;`. Older serves
  answered `bwalletx-1.0.0` before pairing and the wallet's own `wallet-brc100-1.0.0` after. A client that relies
  on noSend should refuse anything that isn't `bwalletx-serve-` 0.6.1 or later.
- **A failed send leaves nothing locked.** If sending fails after every check passed, serve aborts the build
  (the wallet only allows that while the tx is still unsent and unknown to the network): nothing is paid and the
  coins come back. If the wallet refuses the abort, the payment may be out: it stays counted and logged. Either
  way the error names the txid (`txid`, `aborted` in the reply), so a site can check before paying again.
- **A site can only abort its own builds** from this serve session. An unknown action may be another app's held
  build, so it is refused. After a serve restart the owner frees a leftover with the new
  `bwalletx brc100 abort <txid>`.
- **`knownTxids` works again through serve.** serve builds with the full BEEF (it needs the parents to price the
  fee, and the toolbox's batch planner failed on noSend + knownTxids), then trims the reply to what the site
  declared.
- **A signAction flow counts once** toward the hourly rate limit (its fee still counts toward the daily cap).
- The account log marks a noSend build "(noSend: built, not sent)" and shows each payment's fee.
- **Paired `getVersion` answers at once** from a cached PIN level (refreshed in the background every 5 minutes;
  the first call waits at most 1 s), reads the legacy `+pN` suffix too, and never passes 30 bytes.
- **The bNamesX PC miner** no longer crashes at start (serve's version is read lazily, with a built-in
  fallback), and the compiled miner mines again: its worker path pointed outside the bundle, so every worker failed
  and the benchmark showed 0.0 MH/s (now ~7.6 MH/s on an M-series Mac).

### Known gaps (ARC nudge only)

The wallet still broadcasts in these cases; only serve's extra hand-off to ARC is skipped: a build whose BEEF
was dropped from serve's memory (over 64 MB held, oldest first); a send that failed and was retried later by the
wallet's own monitor; the parent of a tx that spends a noSend build's change without naming it in `sendWith`
(the relay sends the child alone, as Extended Format); and any ARC post that fails (errors are ignored).

## 0.6.0 (unreleased)

A safety release. If you let an AI agent use bwalletx, upgrade.

### What changes for you

- **`buy_product` no longer calls a pending payment "Bought".** The bWalletX Store now marks a purchase paid only
  once the network has the payment, and answers 202 until then. `buy_product` reports that as `pending: true`,
  "Pending, not bought yet", after asking again for about 30 s. A 409 `payment_pending` at quote time means a payment
  is already on its way, and nothing is paid.
- **Your wallet sends Store payments itself.** As the bWalletX app now does: the Store records the payment first,
  then your account's wallet broadcasts it (with its parent transactions), then the claim. Before, the payment stayed
  unsent in your wallet while only the Store broadcast it, so its change could not be spent. A payment is released
  only when nothing was broadcast.

- **New: an owner PIN.** Anything that loosens a safety setting now needs you, at your own terminal, typing a
  separate owner PIN at a hidden prompt: raising or clearing a daily cap, rate limit or approval threshold,
  `resume`, `strategy load --live`, `key import` / `key new`, `login` / `pair`, `brc100 migrate` and starting
  `serve`. Piped input is refused, `BWALLETX_YES` no longer skips these, and the MCP server refuses them outright.
  The PIN is never read from an environment variable or an argument, and it can't be your wallet passphrase.
- **Tightening is still instant and free.** `stop`, lowering a cap, rate limit or approval threshold need no PIN,
  from anywhere. AI agents can use the new MCP tool `lower_cap` as well as `stop_all`.
- **Your limits are signed.** Caps, rate limits, approval thresholds, stop flags and the live strategy you approved
  are signed with a key that comes from your PIN. Editing the settings files by hand can no longer loosen anything:
  if they've been tampered with, everything is treated as stopped until you resume with the PIN. Deleting the STOP
  file no longer resumes anything either.
- **MCP mint only reads one folder.** MCP `mint` and `mint_manifest` only accept files inside
  `~/.bwalletx/mint-inbox` (or a folder you pass with `bwalletx mcp --mint-dir <dir>`). Files outside it (after
  following links), dotfiles and hidden folders are refused, and anything over 1 MB needs a dry run first or
  `confirm: true`. Before, a malicious prompt could have asked to publish any file on your machine.
- **MCP spending limit covers buys.** The $5-per-call MCP limit (`BWALLETX_MCP_MAX_USD`) now applies to `buy` and
  `buy_listing` as well as `send`, `buy_product` and `brc100_withdraw`.
- **`serve` never accepts `*`.** The `--allow-any-origin` option is gone: name each site with `--origin`.
- **A live `buy` never signs on a paper answer.** If the strategy file switched to paper while a live buy was
  picking a listing, the gate skipped the live checks (daily cap, approval threshold) and the buy still signed.
  It now refuses.
- Example names in the docs and code comments are now neutral.

### Upgrading from 0.5.x: set your owner PIN

Nothing is deleted. But until you set a PIN, bwalletx runs in a safe default mode: every account is held to
**$10 a day and 30 spending actions an hour**, and **live strategies are refused** (paper still works).

To set it, open your own terminal (not an AI agent's) and run:

```sh
bwalletx owner setup
```

Choose a PIN of at least 8 characters (a short passphrase is best) that is different from your wallet passphrase.
bwalletx then lists your accounts' current caps, rate limits, approval thresholds and live strategies. Answer `y`
to keep them exactly as they are, or `N` to start from the safe defaults. Check everything with
`bwalletx owner status`. Change the PIN later with `bwalletx owner change`.

If you forget the PIN, delete `~/.bwalletx/owner.json` and `~/.bwalletx/owner-settings.json` and run
`bwalletx owner setup` again: you're back to the safe defaults until you approve your settings again.

### What the PIN can't do

It stops an agent from simply running `bwalletx cap <account> off` or editing the JSON. It can't stop an agent
that has a shell, knows your PIN and fakes a terminal. And a key-file account is only as safe as its passphrase,
which sits in your MCP client's config. For real money, use a paired account (keys stay on your phone) with an
approval threshold (`bwalletx approve-above`), so bigger spends are approved on the phone, and keep key-file
accounts small.

### For maintainers

- `prepublishOnly` refuses unless the git tree is clean and HEAD is tagged `v<version>`; it then rebuilds `dist/`
  from scratch, runs the tests and scans the package for company names, private paths and key-like strings.
- The package ships only `dist/`, `README.md`, `LICENSE` and `package.json`.

## 0.5.x

- 0.5.0 (published): new accounts had no default cap, MCP had no per-call limit, `brc100_withdraw "all"` needed no
  confirmation and `serve` trusted the Origin header (including `*`). Fixed on main after 0.5.0 (a $10/day default
  cap, $5 per MCP call, `confirmAll`, an origin allowlist with pairing) and shipped in 0.6.0.
