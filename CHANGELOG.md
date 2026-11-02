# Changelog

## 0.7.0 (unreleased)

Closes the known gap in the 0.6.0 owner PIN: an agent with a shell could fake a terminal (`script`), unset
`CLAUDECODE`, set its own PIN, or delete the owner files and set one again.

- **On a Mac, the owner is Touch ID.** `bwalletx owner setup` makes the owner key inside the Secure Enclave, with
  an access control that needs Touch ID or your Mac password for every signature. Loosening asks for it (one
  prompt per command); tightening still needs nothing. No native npm module: a small Swift helper is compiled
  with Apple's `swiftc` when needed (Xcode Command Line Tools), and the Keychain is used through `/usr/bin/security`.
- **Deleting the owner files no longer resets anything.** An entry in the login Keychain records the owner key.
  While it exists, setup is refused and owner files that don't match it read as stopped. `bwalletx owner reset`
  (Touch ID) removes it. If the Keychain can't be read, everything is treated as stopped.
- **`bwalletx owner upgrade`** moves a 0.6.0 PIN owner to Touch ID and keeps the signed limits.
- **Elsewhere (Linux, CI)** the PIN stays, and `bwalletx owner status` warns that the gate is software-only.
- `owner status` (and `--json`) now reports `gate: "hardware" | "software"` and a `warning` for software-only.
- After a `stop`, resuming a Touch ID owner shows the limits from before the stop and asks whether to keep them
  (No = the safe defaults).

## 0.6.0 (unreleased)

A safety release. If you let an AI agent use bwalletx, upgrade.

### What changes for you

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
