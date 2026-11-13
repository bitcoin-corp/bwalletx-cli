# bwalletx: the bWalletX CLI and MCP server

Run bWalletX **agent accounts** from the command line or from any MCP client (Claude Desktop, Claude Code,
Cursor). v1 is **standalone mode**: the CLI holds one agent account's exported key file, encrypted with a
passphrase. Paired mode (scoped tokens from the app) comes later; `bwalletx login` says so.

Only agent accounts can be exported, never the main wallet. The agent account's balance is the budget.

## Install

```sh
npm i -g bwalletx      # Node 20+
bwalletx owner setup   # once, in your own terminal: set the owner PIN (see "Owner PIN" below)
```

## Pair with your phone (recommended)

Keys stay on your phone. In bWalletX (5.1.40+), open your **agent account**, then run:

```sh
bwalletx login --account phone
```

Scan the QR in the terminal from bWalletX (Settings › Paired websites › Scan to connect), check both screens show the same
4-digit code, choose what the CLI may do (see balances; buy and load strategies; send BSV) and for how long (1, 7 or 30 days),
then tap **Pair**. Every command for that account becomes an end-to-end encrypted request: bWalletX checks it against the
account's Stop switch, daily cap and loaded strategy, then signs it. Keep bWalletX open on that account while the CLI works.
Disconnect any time in the app (Settings › Paired websites) or with `bwalletx logout --account phone`.

For unattended servers where no phone is around, import a key file instead (below).

## Install (from source)

```bash
git clone <this repo> bwalletx-cli && cd bwalletx-cli
pnpm install
pnpm build
pnpm link --global      # puts `bwalletx` on your PATH (or run `node dist/cli.js`)
```

Node 20+ required.

## Import an agent account

In bWalletX: Settings › Agents › account › Export key file. Then:

```bash
bwalletx key import ./trader.key.json     # asks for the passphrase (or set BWALLETX_PASSPHRASE)
bwalletx accounts
```

The file is checked by decrypting it once, then stored still encrypted at
`~/.bwalletx/accounts/<name>.key.json` (mode 600). Keys are only decrypted in memory, when a live
transaction is signed. Set `BWALLETX_HOME` to keep state somewhere other than `~/.bwalletx`.

### Key file format (`bwalletx.agentkey/1`)

```json
{"format":"bwalletx.agentkey/1","name":"trader","identityAddress":"1…",
 "enc":{"kdf":"pbkdf2-sha256","iter":310000,"salt":"<b64 16 bytes>","iv":"<b64 12 bytes>",
        "alg":"aes-256-gcm","data":"<b64 ciphertext || 16-byte GCM tag>"}}
```

`data` decrypts to `{"payPk":WIF,"ordPk":WIF,"identityPk":WIF}`. PBKDF2-SHA256 over the UTF-8 passphrase →
AES-256-GCM, tag appended to the ciphertext exactly as WebCrypto returns it. `src/keyfile.ts`
(`encryptKeyFile` / `decryptKeyFile`) uses only `crypto.subtle`, so the app can use the same code.

## Commands

```bash
bwalletx balance --account trader                 # BSV + BSV-21 tokens, valued in USD
bwalletx price <tokenId>                          # floor price, USD per token
bwalletx send 5 alice@bwalletx.com --account trader     # $5 of BSV to a paymail or address
bwalletx buy <tokenId> --max-usd 2 --account trader
bwalletx list <outpoint> --price 50000 -a trader  # list an ordinal / OpNS name / BSV-21 output on the 1Sat order book
bwalletx unlist <outpoint> -a trader              # cancel it; the item comes back to the wallet
bwalletx listings -a trader                       # your open listings, price and live status
bwalletx buy-listing <outpoint> -a trader         # buy one listing (ordinal or BSV-21) by outpoint
bwalletx strategy load ./accumulator.json --account trader          # paper ($100 pretend book)
bwalletx strategy load ./accumulator.json --account trader --live   # real money (owner PIN)
bwalletx strategy show | unload
bwalletx agent run trader --interval 300          # rule-driven loop; Ctrl-C to stop
bwalletx log --account trader                     # ~/.bwalletx/log/trader.jsonl
bwalletx stop                                     # kill switch: refuse all spending (no PIN)
bwalletx resume                                   # owner PIN
bwalletx cap trader 5                             # lower the daily cap (no PIN); raising or "off" needs the owner PIN
bwalletx owner status                             # PIN set? settings verified? the limits the gate enforces
bwalletx mcp                                      # stdio MCP server
bwalletx stamp ./receipt.pdf -a records --register ./REGISTER.md   # file's SHA-256 on chain, prints the txid
bwalletx verify ./receipt.pdf <txid>              # does that tx carry this file's SHA-256? (exit 1 if not)
bwalletx paymail register myagent -a trader       # claim myagent@bwalletx.com for an agent account (signed by its key)
```

### Stamps (`stamp` / `verify`)

`stamp` puts only the file's SHA-256 on chain, never the file or its name, in one 0-sat output:
`OP_FALSE OP_RETURN "bwx.stamp/1" <32-byte sha256>`. It runs from an **agent key-file account**, so there's no phone tap.
Fund it first with `bwalletx brc100 fund`. It goes through the same gate as every spend: kill switch, daily cap,
rate limit, strategy rules. A strategy that allow-lists `sendTo` must include `"stamp"`. Paired accounts are refused,
because their keys stay on the phone. `--register` appends `| time | file | sha256 | txid | account |` to a Markdown
register, creating it if missing. `--json` prints `{ file, sha256, txid, account, timestamp }`. `verify` rechecks a
file against the transaction on WhatsOnChain and reports confirmations and block time.

Add `--json` for machine-readable output. `send` asks for confirmation on a terminal; `-y` skips it.

Token ids are BSV-21 ids (`txid_vout`). `send` moves BSV, so when a strategy is loaded its `rules.tokens`
must include `"BSV"`, `actions` must include `"send"`, and the recipient must be in `sendTo`.

## BRC-100 wallet for sites (`serve`)

A standalone agent account can act as a full BRC-100 wallet, so any BRC-100 site or script can use it:
launchpads, games, anything that asks for `createAction`, `signAction`, `createSignature`, `listOutputs`.

```bash
bwalletx brc100 fund      -a trader                      # move the pay address's BSV into the BRC-100 wallet
bwalletx serve            -a trader --origin www.example.com localhost:3000   # owner PIN
bwalletx brc100 balance   -a trader
bwalletx brc100 withdraw all 1YourAddress… -a trader     # take it back out
```

By default the BRC-100 wallet is the CLI's own (pay-key root, `~/.bwalletx/brc100/<account>.sqlite`); fund it with
`brc100 fund`, which also collects from the receive addresses the app shows. `--shared` opens the account's own
bWalletX wallet instead (identity-key root, 1Sat Storage `https://wallet.1sat.app` as the active store). Use it only
if the app uses that remote as the account's active storage: bWallet normally keeps the phone's local store active
and only backs up every 5 minutes, so the two would drift. `brc100 migrate` moves the CLI wallet's balance into it.

`serve` listens on `http://localhost:3321`, where BRC-100 sites already look for a desktop wallet, so they
find it the same way they find BSV Desktop. Built on `@bsv/wallet-toolbox`; keys are decrypted into memory only.

- **Allowlist**: only the hosts given with `--origin` get an answer; everyone else gets 403. Wildcards (`*`,
  `*.example.com`) are refused: there is no way to let every page on the machine use the wallet.
- **Owner PIN**: starting `serve` needs the owner PIN at a terminal, like every other loosening.
- **Pairing**: the Origin header proves nothing (any program on the machine can send one), so each allowed
  site pairs once. The site sends `POST /pair`; serve prints the origin and an 8-digit comparison code in its
  terminal and asks `y/N`. The response streams `{"code":"1234 5678"` at once (the site shows it so the owner can
  compare) and finishes with `,"approved":true,"token":"…"}` or `,"approved":false}`. Every other call must
  carry `Authorization: Bearer <token>`; without a valid token for that origin it gets 401. Only `getVersion` and
  `isAuthenticated` answer unpaired (a fixed version string and `authenticated: false`), so sites can detect the
  wallet. Tokens are random per origin and stored only as SHA-256 hashes in `~/.bwalletx/serve-pairings.json`
  (0600). `bwalletx serve --list-pairings` lists them; `bwalletx serve --revoke <origin>` revokes one at once.
  Serve without a terminal (no TTY) refuses every pairing request.
- **Host check**: serve binds to 127.0.0.1 and answers 403 unless the `Host` header is `localhost:<port>` or
  `127.0.0.1:<port>`, which stops DNS-rebinding pages.
- **The gate**: every `createAction` is checked like a `send` for the BSV it takes out of the account
  (its outputs minus what the site's own inputs bring in), so the kill switch, daily cap, rate limit and a
  loaded strategy all apply. Refusals reach the site as a readable wallet error.
- **Log**: every spend and signature lands in the activity log with the site and txid.
- **Limits**: one payment from a site may move at most `--max-usd` (default $1) and the session at most
  `--budget-usd` (default $5).
- **Tokens**: the caps value satoshis only, and a BSV-21 token output is 1 sat however much the token is
  worth. So a `createAction` with a BSV-20/21 inscribed output, or one that names the wallet's own outputs
  as inputs, is refused unless serve runs with `--allow-token-transfers`. With that flag the caps still count the
  sats, but not what the tokens or ordinals are worth (see "Not covered by the USD cap" below).
- Paired accounts can't serve: their keys stay on the phone.

## Default limits

- New accounts (import or pairing) start with a **$10/day cap**. Lower it with `bwalletx cap <account> <usd>`;
  raising it or `off` needs the owner PIN.
- MCP `send`, `buy`, `buy_listing`, `buy_product` and `brc100_withdraw` move at most **$5 per call**
  (`BWALLETX_MCP_MAX_USD` in the MCP server env changes it). `brc100_withdraw` with `usd: "all"` also needs
  `confirmAll: true`, and the per-call limit still applies. `buy_listing` without `maxUsd` uses the limit.
- Until an owner PIN is set, every account is clamped to **$10/day, 30 spending actions/hour, strategies on paper**,
  whatever config.json says.

## Owner PIN

Raising or clearing a cap, a rate limit or the approval threshold, `resume`, `strategy load --live`, `key import` /
`key new`, `login` / `pair`, `brc100 migrate` and starting `serve` all **loosen** safety settings. Since 0.6.0
each of them needs:

1. a person at an **interactive terminal** (stdin and stdout are a TTY; piped input is refused and `BWALLETX_YES`
   is ignored for these),
2. **not** the MCP server (`bwalletx mcp` marks itself, and its child processes, and refuses them), and
3. the **owner PIN**, typed at a hidden prompt. It is separate from the wallet passphrase (bwalletx refuses a PIN
   that opens one of your key files or equals `BWALLETX_PASSPHRASE`) and is never read from an environment
   variable or an argument. Only a slow scrypt hash of it is stored (`~/.bwalletx/owner.json`).

**Tightening needs no PIN, from anywhere**, including MCP: `stop`, lowering a cap, a rate limit or the approval
threshold (`lower_cap` over MCP).

The limits themselves are **signed**: `~/.bwalletx/owner-settings.json` holds the caps, rate limits, approval
thresholds, stop flags and which live strategy file you approved, signed with a key derived from your PIN. The
gate checks the signature on every spend (no PIN needed for that) and enforces the **tighter** of the signed value
and config.json. So:

- editing config.json, or a strategy file, by hand cannot loosen anything (an edited live strategy is refused);
- if owner-settings.json is edited, deleted or can't be verified, every account is treated as **stopped**, with
  default caps, until you run `bwalletx resume` (PIN), which then signs the safe defaults; review them with
  `bwalletx owner status` and approve config.json with `bwalletx owner sign`;
- `stop` removes the signature, so deleting the STOP file does not resume anything.

Commands: `bwalletx owner setup` (once), `owner change` (old PIN, then new), `owner sign` (review and sign
config.json), `owner status` (no PIN).

**Upgrading from 0.5.x**: nothing is lost, but until you set a PIN the defaults above apply ($10/day, 30/hour,
live strategies refused). In your own terminal run `bwalletx owner setup`, choose a PIN, check the settings it
lists and answer `y` to keep them (live strategies included), or `N` for the safe defaults.

**What this does not do.** It stops an agent that runs `bwalletx cap <acct> off` or edits the JSON files. It can't
stop an agent that has a shell **and** knows your PIN **and** fakes a terminal; or one that deletes all the owner
files (that only gets it back to the defaults above, and `owner status` then shows no PIN); or one that copies an
older signed settings file back (never looser than something you signed). A key-file account's keys are only as
safe as `BWALLETX_PASSPHRASE`, which sits in your MCP client's config: an agent that can read that file can take
the key itself and skip bwalletx entirely. So for real money:

- use a **paired** account (keys on the phone) and set **approve-above**: bigger spends are approved on the phone,
  and no bwalletx code path, the owner PIN included, can approve a spend;
- keep key-file accounts small (the balance is the budget);
- don't give an AI agent a shell on the machine that holds a key-file account with real money.

## The gate

Every spending action, from the CLI, `agent run` or MCP, passes the same checks in this order:

1. **Kill switch** (`bwalletx stop`, file `~/.bwalletx/STOP`, or owner settings that don't verify) or the account is stopped
2. **Daily cap** for the account (the tighter of the signed and configured value)
3. **Live strategy approved**: a live strategy file must be the one signed with the owner PIN
4. **Approve-above**: single spends over the threshold are refused until the owner approves them
5. **Rate limit**: at most 30 spending actions per hour per account (paper and failed attempts count)
6. **Strategy rules** (`bwalletx.strategy/1`; same `parseStrategy` / `checkRules` / `paperFill` as the app)
7. **Paper mode** fills on the paper book and never signs

Every refusal is logged with the rule that refused it.

Items that leave the account are valued in dollars where bwalletx knows a value: an OpNS name at its listing tier
(the top tier, $500, when its name can't be read), and a listing below value counts the shortfall (OpNS tier, or
the BSV-21 market floor). A spend whose builder fails is released only if the wallet was never asked to sign or send.

### Not covered by the USD cap

- `serve --allow-token-transfers`: sites may move BSV-21 tokens and ordinals; only their sats count.
- `opns mint --to <address>`: vault and gift names are locked straight to that address as they are mined; only the
  mint fees count (against `--budget`), not the names' value.
- `list` for an ordinal: it has no known value, so it is a $0 list however low the price.

## Strategies

Same format as the app; see `docs/STRATEGY-FORMAT.md` in the bWalletX repo. Example:

```json
{
  "format": "bwalletx.strategy/1",
  "name": "Slow accumulator",
  "version": "1.0",
  "goals": "Build a position slowly while the price is low.",
  "rules": {
    "tokens": ["<bsv21 id txid_vout>"],
    "actions": ["buy"],
    "buyBelowUsd": 0.001,
    "maxPerTradeUsd": 2,
    "maxPerDayUsd": 10,
    "maxTotalUsd": 200,
    "stop": { "holdTokens": 100000 }
  }
}
```

`agent run` needs no AI: each tick, for every BSV-21 id in `rules.tokens`, if `buy` is allowed and the floor
price is at or below `buyBelowUsd`, it asks to buy `maxPerTradeUsd` worth. The gate decides.

## Live vs paper

| Action | Paper | Live |
| --- | --- | --- |
| balance, price, log | yes | yes (read-only) |
| send BSV (address or paymail) | yes | **yes**: P2PKH from the pay key, WhatsOnChain UTXOs, ARC (GorillaPool) broadcast with WhatsOnChain fallback; paymail via P2P destinations or basic paymentDestination |
| buy BSV-21 | yes (fills at the floor on the paper book) | **yes**: takes the cheapest whole 1Sat OrdLock (v1) listing that fits `--max-usd` and that the 1Sat overlay holds as valid; pays the seller exactly as the lock encodes, adds the 1% bWalletX market fee and (when active) the overlay fee, sends the tokens to the ord address, change to the pay address. Every input script is verified locally before broadcast. OrdLock v2 listings: not yet (use the app) |

Live sends sign with the account's key file; set `BWALLETX_PASSPHRASE` for unattended use (MCP, servers).
1-sat outputs are never spent as fee money, so ordinals and tokens on the pay address are safe.

`bwalletx buy <tokenId> --max-usd 5` shows the exact totals (seller, market fee, overlay fee, network fee) and
asks before broadcasting; `-y` or `BWALLETX_YES=1` skips the prompt. The gate sees the full dollar cost
including fees. `--dry-run` builds and verifies the purchase against the real listing with throwaway keys and
a synthetic funding coin, without touching your account or broadcasting.

## Selling and listing (1Sat order book)

```bash
bwalletx list <outpoint> --price <sats> [--amount <n>] [-a account] [--yes] [--dry-run]
bwalletx unlist <outpoint> [-a account] [--yes] [--dry-run]
bwalletx listings [-a account]
bwalletx buy-listing <outpoint> [--max-usd <n>] [-a account] [--yes] [--dry-run]
```

These run on a key-file account's own **BRC-100 wallet** (the same local wallet `opns` and `brc100` use; fund it
with `bwalletx brc100 fund`). Paired accounts are refused, because their keys stay on the phone. The transactions are built
by the same `@1sat/actions` code the bWalletX app uses:

- `list`: finds `<outpoint>` among the wallet's ordinals, OpNS names and BSV-21 tokens and lists it with
  **OrdLock v2** for `--price` sats (the whole listing). Ordinals go through `sellOrdinal` and names through
  `sellOpns`. BSV-21 tokens are sent to a listing script (a transfer inscription around an OrdLock v2), as the app's
  sell sheet does; `--amount` lists part of the output (whole tokens, at the token's decimals). Proceeds go to the
  wallet's default 1Sat pay address. The token cancel key is recorded in `~/.bwalletx/listings-<account>.json`. It
  is derived from the token id, so it can be re-derived if that file is lost.
- `unlist`: cancels a listing the wallet tracks (`cancelOrdinalListing`, `cancelTokenListing`,
  `cancelOpnsListing`) or a recorded BSV-21 listing (signed with its cancel key). The item returns to the wallet.
- `listings`: OrdLock outputs in the wallet plus recorded BSV-21 listings, with price and `live` / `gone`
  (sold or cancelled) from the 1Sat index.
- `buy-listing <outpoint>`: decodes the listing (v1 or v2, ordinal or BSV-21) and buys it with `buyOrdinal` /
  `buyBsv21`: the seller price, plus the 1% bWalletX market fee, plus the overlay fee for tokens. `--max-usd`
  refuses it if the total is higher. This is a separate command from `buy <tokenId> --max-usd`, which is unchanged.

Every spend asks for confirmation and shows the price and fees. `-y` or `BWALLETX_YES=1` skips the prompt, for
scripts. Each one passes the gate: `buy-listing` with its full dollar cost, and `list` / `unlist` as a $0 `list` action
(kill switch, rate limit, strategy rules). A paper-mode strategy refuses these commands. `--dry-run` runs the real builder
against a wallet that records the `createAction` it is asked for and refuses it. You see the inputs and outputs
it would have made, and nothing is signed or broadcast. A dry run still opens the wallet, so it asks for the passphrase.

## OpNS: mint whole name lists unattended

```bash
bwalletx opns mint lists/*.txt --vault keep.txt --gift gift.txt --to <ordinals address> --budget 72000000 -a opns
bwalletx opns status -a opns      # progress, spent, ETA (also ~/.bwalletx/opns-batch-<account>.html)
bwalletx opns sweep --to <address> -a opns   # cancel unsold listings, send names + remaining sats to the owner
bwalletx opns bench               # proof-of-work speed on this machine
```

Mines every name from the agent account's own BRC-100 wallet, alphabetically (prefixes reused), re-checking each
name right before it is mined; vault/gift names are locked straight to `--to`, the rest are listed with OrdLock v2
at $1 / $5 / $15 by length. Resumable (`~/.bwalletx/opns-batch-<account>.json`), stops before going over `--budget`,
Ctrl-C stops cleanly. Proof of work runs on worker threads. The covenant code is shared with bWalletX
(`src/opns/opns*.ts`, copied with attribution). Owner runbook: [docs/OPNS-HEADLESS.md](docs/OPNS-HEADLESS.md).

## MCP

Tools (reads are free; anything that spends passes the gate above, paper mode never signs, live key-file
accounts need `BWALLETX_PASSPHRASE` in the MCP env, paired accounts sign on the phone):

| Tool | What it does |
|------|--------------|
| `accounts` | list accounts and loaded strategies |
| `balance` | BSV and BSV-21 balances in USD |
| `price` | floor price of a BSV-21 token |
| `send` | send BSV worth `usd` (gated) |
| `buy` | buy a BSV-21 token for at most `maxUsd` (gated) |
| `list_for_sale` | list an ordinal / OpNS name / BSV-21 output on the 1Sat order book (OrdLock v2; gated as `list`; `dryRun` builds only) |
| `unlist` | cancel one of the account's listings (`dryRun` builds only) |
| `listings` | the account's open listings with price and live status |
| `buy_listing` | buy one listing by outpoint, like `buy-listing` (+1% market fee; gated as `buy`; optional `maxUsd`; `dryRun` builds only) |
| `list_products` | bWalletX Store products agents can buy ($1 themes, $99/year Theme edition, Branded edition from $999 by quote) |
| `quote` | signed 5-minute single-use quote: USD, sats at the live rate, MNEE amount (nothing paid) |
| `buy_product` | quote → check → gate → pay from the BRC-100 wallet: the Store records it, the wallet broadcasts it, then the claim → granted to this identity key once the network has the payment (gated like `send`; `maxUsd`; `dryRun` builds only; API: `BWALLETX_STORE_API`, default https://pay.bwallet.space). `pending: true` = not bought yet: see "Store answers" below |
| `strategy_show` | the loaded strategy, mode and paper book |
| `strategy_load` | load a strategy file, always in **paper** mode |
| `log` | recent activity log entries |
| `stop_all` | kill switch: refuse every spending action |
| `lower_cap` | lower an account's daily cap (lowering only) |
| `brc100_balance` | BRC-100 wallet balance (`wallet`: `local` or `shared`) |
| `brc100_addresses` | pay address + app receive addresses (key-file accounts only) |
| `brc100_fund` | move the account's own pay/receive BSV into its own BRC-100 wallet (no money leaves; logged; refused while stopped) |
| `brc100_withdraw` | send `usd` (or `"all"`) from the BRC-100 wallet to an address (gated like `send`; paper refuses; logged; ARC relay) |
| `mint`, `mint_manifest` | mint files / a manifest as NFTs on a paired phone (the phone signs within its pairing's mint limits; refused while stopped; `dryRun` estimates only). Only files inside the **mint folder** (`~/.bwalletx/mint-inbox`, or `bwalletx mcp --mint-dir <dir>`); paths are relative to it; anything outside it after following symlinks, dotfiles and hidden folders are refused; over 1 MB needs a `dryRun` of the same files first or `confirm: true` |
| `pairing_status` | whether an account is paired and how (agent or brc100 main wallet), scopes, expiry, limits; never secrets |
| `serve_status` | whether something listens on the `serve` port (3321) |

**Human-only, never exposed over MCP:** raising caps or limits, `resume`, `strategy load --live`, `key import`,
`pair` / `login` / `logout`, `brc100 migrate`, and starting/stopping `serve`. Being off MCP is not the only guard:
the commands themselves need the owner PIN at a terminal (see "Owner PIN"), so an agent with a shell can't just run
them either. An agent can stop things (`stop_all`, `lower_cap`) but never turn them back on or raise its own limits.

`mint` publishes files on chain for anyone to read, so over MCP it only reads the mint folder. Put the files you
want minted there yourself.

**Store answers.** The bWalletX Store marks a purchase paid only once the network has the payment
([agent.json](https://bwalletx.com/.well-known/agent.json)):

- `200`: bought. The product is granted to the account's identity key.
- `202` with `pending: true`: the payment is pending, **not bought yet**. The Store has recorded it, but the network
  hasn't shown it yet. Don't pay again. The same buy request (same `quote_id`, `txid` and `rawtx`) answers `200` once
  the network has the payment, even after the quote expired.
- `409 payment_pending`: a payment for this product (or this quote) is already on its way. Don't pay again.

`buy_product` pays as the bWalletX app does: the Store first records the payment (an intent, nothing posted),
then the account's own wallet broadcasts it, so its change is spendable straight away, then it claims.

- **Bought:** `ok: true` and the text starts "Bought".
- **Pending:** `ok: true, pending: true` and the text starts "Pending, not bought yet". The tool asks again three
  times over about 30 s first. Don't pay again: the Store grants it once the network has the payment, even after the
  quote expires. For a theme, calling `buy_product` again is safe; it answers "already on its way" until then.
- **409 `payment_pending`** at quote time: `ok: false, pending: true`, and nothing is built or paid.
- The payment is released only when the Store refused the intent, so nothing was broadcast. After the broadcast it
  is never released; a refused claim says so with the txid.

**Claude Code**

```bash
claude mcp add bwalletx -e BWALLETX_PASSPHRASE=your-passphrase-here -- bwalletx mcp
```

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "bwalletx": {
      "command": "bwalletx",
      "args": ["mcp"],
      "env": { "BWALLETX_PASSPHRASE": "your-passphrase-here" }
    }
  }
}
```

Leave out `BWALLETX_PASSPHRASE` to keep MCP read-only and paper-only: live sends then fail with
"No passphrase". If `bwalletx` isn't on the PATH, use `"command": "node", "args": ["/path/to/bwalletx-cli/dist/cli.js", "mcp"]`.

## Security

Please report security problems privately through GitHub's security advisories for this repository
(Security › Report a vulnerability), not in public issues.

## Development

```bash
pnpm build
pnpm test      # keyfile round-trip, strategy rules, gate order, rate limit, paper book, offline send signing
```

Tests use freshly generated throwaway keys only.
