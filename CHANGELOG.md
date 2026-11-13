# Changelog

## 0.6.0 (unreleased)

A safety release. If you let an AI agent use bwalletx, upgrade.

### What changes for you

- **Spends reserve their dollars before signing.** Store buys and `buy-listing` now reserve the amount against the
  daily cap before anything is signed, so two requests at once can't both pass it. A spend that may have gone out
  stays counted even if the process stops half way; one that didn't is released.
- **OpNS name transfers go through the gate.** `opns sweep`, `opns send` and `opns unlist` treat each name as a send
  valued at its listing tier: the kill switch, daily cap, approval threshold, rate limit and strategy rules apply.
  Moving many names may need the cap raised for the run (owner PIN). A name whose name tag can't be read is valued
  at the top tier ($500), never the cheapest.
- **Listing below value counts against the cap.** `list` / MCP `list_for_sale` used to be a $0 action, so an agent
  could list a $500 name for 1 sat and have someone else buy it. Now the shortfall (an OpNS name below its tier,
  BSV-21 tokens below what buying as many would cost on the order book) is reserved against the daily cap and
  approval threshold like a send. The book is walked from the cheapest listing up for the number of tokens listed,
  so one dust listing can't drag the value down. Listings made by this wallet or any account in this CLI's config
  are left out. Ordinals, and tokens no one else lists, have no known value, so listing one needs the owner PIN at a
  terminal (refused under MCP).
- **An error after broadcast stays counted.** A buy, listing or name send whose builder answers with an error is
  released only if the wallet was never asked to sign or send; otherwise it is counted as `failed`.
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
