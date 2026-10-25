# Roshemet agent

The family's own bank agent (package `roshemet-agent`; Roshemet is a working name). It signs in to the family's
bank and card websites with [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers) (a headless
Chrome using the family's own logins) and sends the transactions to the family's own app for approval, so nobody
downloads and drops statement files.

**It runs on a machine the family controls, never in the app.** The app can't run a browser, and bank logins
must never reach it, or anyone else. Three homes:

- **the family's own GitHub account** (recommended): a private repo made from the Roshemet template runs it on
  GitHub's computers once a day, even with the family's computer off. See "On GitHub";
- **the family's own computer** (Windows or Mac): see "On a family's computer";
- **a small box** (a Linux VM or mini-PC, always on): see "The scraper box".

Each family keeps a second way in, file upload at least: GitHub may stop runs on its computers (below).

**What keeps the logins the family's:**

- They are typed only on the machine that runs the agent, into its own prompt (or the setup app's form), and kept
  there in an encrypted vault. Never through the app, the bot, support, or e-mail.
- The vault's key stays with that machine: Windows keeps it for the Windows account (DPAPI), the Mac's Keychain
  for the Mac user, a box seals it to its TPM chip. Nobody types or keeps a passphrase.
- The agent's token for the app comes from pairing on the dashboard. It can only *send scrapes for approval*,
  never save rows itself, and the family can revoke it there.
- Only what the app needs leaves the machine: each transaction's date, amount, description and the account's
  *slot* (`bank`, `card1` … `card4`). No account numbers, references or memos.
- Support never signs in to a family's machine and never takes a login. `diagnostics` prints what support needs,
  with no login, account number, amount or transaction in it; the family reads it before sending it.

## What it does

1. Opens the vault (`~/.roshemet/vault.json` on a computer). It holds the logins, the account map, the app's
   address and the agent's token, encrypted with AES-256-GCM.
2. Signs in to each stored company and fetches the last 45 days (`--days N`, up to 365).
3. Maps each account by **company + last 4 digits** to one of the app's slots or `skip`. Only the slot is sent.
4. Sends the run to the app, which posts it in the family's chat and on the dashboard with **✅ Save / ❌ Discard**.
   Save books exactly those rows.
5. Writes one line per company to `scrape-log.jsonl` beside the vault: when, ok or the error type, how many
   transactions and the newest date; what the library said about a failure, with the login and anything that
   looks like a number, a name or a transaction taken out. It warns when a company has failed 3 times running,
   has found nothing 3 times running, or has no transaction newer than two weeks.

In the app, scraped rows go through **the same parsers as a file upload**. Card-bill payments, ATM withdrawals,
card-to-card transfers and ניוד are pulled out exactly as before, and dedup uses the same composite id.

It never runs on Shabbat or Yom Tov (its result posts to the family's chat): from 13:00 the day before to the end
of the day, in Israel time, from Node's own Hebrew calendar. Chol HaMoed runs as normal.

## On GitHub (recommended)

A private repo in the family's own GitHub account, made from the Roshemet template (github.com/roshemet/template →
**Use this template** → Private). Its workflow `agent.yml` ("Bank run") runs once a day at 07:00 UTC (10:00 Israel
time in summer, 09:00 in winter; GitHub may start it later), never on Shabbat or Yom Tov, and whenever someone
presses **Run workflow** (0 days: a check, no bank).

- **The logins** are repo secrets, one per company (`LOGIN_<COMPANY>`: the login's fields), each encrypted with the
  repo's own key on the machine that sends it. GitHub keeps them encrypted and gives them only to the run. Before
  printing anything, the run tells GitHub to hide every value of every login from its log, and it takes them out of
  its environment before the browser starts.
- **The rest:** the app's address and the account map are repo variables (`ROSHEMET_APP`, `ROSHEMET_MAP`); the repo's
  own token from pairing is the secret `ROSHEMET_TOKEN` (it can only send scrapes for approval).
- **The agent's version** is in the repo's `roshemet.json`. A run installs that release only after checking its
  provenance: GitHub's attestation that `roshemet/agent`'s own release workflow built it. `update.yml` moves to a newer
  one, checked the same way.
- **The repo must stay private:** the run does not start in a public one (anyone could read its log).
- The run's page shows a table per login: ok or the error type, how many transactions, the newest date. The scrape log
  is kept between runs in GitHub's cache, so a bank that blocked one run is left alone for 12 hours.

From a computer or box that already holds the logins, one command fills the repo and checks it on GitHub:

```bash
node scrape.mjs github-connect --repo <owner>/<repo> --code <the dashboard's pairing code>
sudo finance-scraper github-connect --repo <owner>/<repo> --code <code>     # on a box
```

It asks for a GitHub token once: a link fills in its name, 7 days and the three permissions it needs (Actions,
Secrets, Variables), and you pick the repo. Then it checks the repo (private, made from the template) and the app,
seals each login with the repo's key, sets the variables, pairs the repo with the app (the code from Upload tab →
Bank scrape → **Pair a scraper box**), and starts GitHub's check and a first run, showing what each said. The token is
kept nowhere. On a box, the box's own daily run then pauses (one sign-in a day per bank); 🏦 stays on the box.
`sudo finance-scraper daily on` brings it back.

**GitHub's risk, plainly:** GitHub's terms limit what its computers may be used for. GitHub may stop these runs, and
in rare cases suspend the account. Keep a second way: your computer, a box, or uploading a file from the bank.

## On a family's computer (Windows or Mac)

Needs Node **22.22.2 or newer** (nodejs.org) and about 500 MB for the browser. The setup app (coming) does all of
this behind its own screens; by hand:

```bash
cd roshemet-agent              # this folder
npm ci                         # the pinned libraries, and the Chrome the bank library drives
node scrape.mjs setup --endpoint https://<your app's address>
```

`setup` checks first and changes nothing until every check passes: Node and the libraries are here, the address
answers as the app does, and Windows (DPAPI) or the Keychain keeps a key and gives it back. Then, each step
checked:

1. **The vault**, with a random key this computer keeps (Windows for this Windows account; the Keychain for this
   Mac user). A vault that opened with a passphrase moves to such a key: the passphrase is asked once, never again.
2. **Pairing with the app.** On the dashboard: Upload tab → Bank scrape → **Pair a scraper box**. It shows a code
   like `K7QM-3XPD` (once, for 15 minutes); type it when asked, or pass `--code K7QM-3XPD`.
3. **The daily run and the 🏦 listener.** Every day at 09:00 (`--time 07:30` to change), never on Shabbat or Yom
   Tov. Windows: a task in Task Scheduler (while the computer is on) and the listener at logon. Mac: two LaunchAgents
   (a Mac asleep at that hour runs it when it wakes). It waits until the listener has reached the app.

Then the logins, one company at a time (it asks for each field; what you type is not shown):

```bash
node scrape.mjs companies              # the companies and the fields each needs
node scrape.mjs add-login leumi
node scrape.mjs add-login isracard     # one Isracard login (ID + 6 digits of either card) sees all its cards
node scrape.mjs run --review --days 90 # the first run, for your approval in the app
```

The first run names each account it finds that has no slot yet, with the command that gives it one:

```bash
node scrape.mjs map isracard 1234 card1   # company, its last 4 digits, the slot (or skip)
```

Run `setup` again at any time: it keeps what works (the key, the vault, the pairing) and redoes the rest.
`node scrape.mjs uninstall` stops and removes the daily run and the listener; `--forget-key` also removes the key
(the vault can then no longer be opened); `--delete-vault` removes the vault and everything kept beside it.

## The scraper box (Linux VM, Google Cloud)

The agent runs on a small VM in Google Cloud's Tel Aviv region (Debian 13):

- **Daily** at 09:00 Israel time. Never on Shabbat or Yom Tov.
- **🏦 in the group** starts a scrape within seconds.
- **Approval:** every result waits for Save on the dashboard or in the group. A day with nothing new and nothing
  wrong says nothing.
- **The bank balance:** each run checks the ledger against the balance the bank shows and says whether it adds up
  ("adds up ✓", or how much more came in or went out than the app has recorded). Save records that balance for
  `/balance` and the Saturday check. When the bank shows no balance, the message says it wasn't checked.

**How it is protected:**

- **Logins:** in an encrypted vault on the VM. Its key is made by setup and *sealed to the VM's TPM chip*, so nobody
  types a passphrase, a reboot needs nobody, and a copy of the disk cannot open it.
- **The box's token:** comes from pairing on the dashboard, can only *send scrapes for approval* (never save rows
  itself), and the family can revoke it there.
- **Access:** the VM has no public address. Only the Google Cloud console's SSH button reaches it, so **the family's
  Google account is the key**: protect it with a passkey or a security key, and keep the project to that one account.
- **Silence:** if the box goes quiet, the bot says so the next morning (never on Shabbat or Yom Tov).

### Setting it up (once). Each step checks itself and says what to do if it fails.

1. **Create the VM.** At console.cloud.google.com, with your project selected, open Cloud Shell (the `>_` button).
   Upload `linux/create-vm.sh` (⋮ → Upload). Then:
   ```bash
   bash create-vm.sh
   ```
   A copy that passed through Windows has Windows line endings: the script removes them itself and starts again (it
   says so). It makes:
   - a network of its own that lets in only the console's SSH,
   - the VM (Debian 13, vTPM on, no public address),
   - one fixed address the banks will see.

   It prints that address. About $33 a month.
2. **Open the VM:** Compute Engine → VM instances → `finance-scraper` → **SSH**.
3. **Give it read-only access to the code.** Paste this into the SSH window:
   ```bash
   sudo bash -c 'apt-get update -qq && apt-get install -y -qq git >/dev/null && mkdir -p -m 700 /root/.ssh && { [ -f /root/.ssh/finance-cloud-deploy ] || ssh-keygen -q -t ed25519 -N "" -C finance-scraper -f /root/.ssh/finance-cloud-deploy; } && cat /root/.ssh/finance-cloud-deploy.pub'
   ```
   It prints one line starting `ssh-ed25519`. On GitHub: the repository that holds the code → Settings → Deploy keys
   → Add deploy key. Give it the title "scraper VM", paste the line, and leave "Allow write access" **off**. This is a
   public key: nothing secret is copied. (Today a box takes the code from a private copy, with this agent in
   `scripts/scrape`, and updates from it; installing a box from the public releases comes later. Until then a family
   runs the agent on GitHub or on its own computer.)
4. **Fetch the code and set up**, with your app's address (the one your dashboard opens at):
   ```bash
   sudo git -c core.sshCommand="ssh -i /root/.ssh/finance-cloud-deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" clone git@github.com:<owner>/<repo>.git /opt/finance-scraper && sudo bash /opt/finance-scraper/scripts/scrape/linux/setup-debian.sh --endpoint https://<your app>
   ```
   (`Permission denied (publickey)` means the deploy key from step 3 is not added yet.)
   It installs Debian's Chromium, the TPM libraries and Node (checked against a pinned checksum). Then it checks the
   machine **before changing anything**. Then it seals the vault key, starts Chromium exactly as the agent will
   (sandbox on), and writes the services. It ends with the next steps.
5. **Pair the box with the app.** On the dashboard: Upload tab → Bank scrape → **Pair a scraper box**. It shows a
   code like `K7QM-3XPD` (once, for 15 minutes). On the VM:
   ```bash
   sudo finance-scraper pair
   ```
   Type the code. The group is told that a box paired.
6. **The logins.** Already on a computer with this agent? Bring them over instead of typing them again:
   1. At the top of the VM window, click **Upload file** and pick that computer's vault file (`vault.json` in
      `.roshemet`, or `scraper-vault.json` in `.finance-cloud`).
   2. Then:
      ```bash
      sudo finance-scraper import-logins scraper-vault.json
      ```
      It asks that vault's passphrase. It copies the logins and the account map (so step 7 is done too), never the
      other machine's token, and deletes the uploaded file.

   Or type them, one company at a time. It asks for each field, and what you type is not shown:
   ```bash
   sudo finance-scraper add-login leumi
   sudo finance-scraper add-login isracard
   ```
7. **The account map:** the first run names each account without a slot and gives the command for it:
   ```bash
   sudo finance-scraper map isracard 1234 card1
   ```
8. **The first run, for your approval:**
   ```bash
   sudo finance-scraper run --days 100 --review
   ```
   Everything already in the ledger stays out: the boundaries keep anything the files or earlier scrapes brought
   from coming in twice. Check every row on the dashboard ("Show all"), then press **Save** before step 9: a newer
   scrape replaces one nobody has saved yet.
9. **Start it:**
   ```bash
   sudo finance-scraper start
   ```
   It checks the app accepts the box, starts the listener and the daily run, and waits for `✓ The box is listening`.

Keep one agent per family: two would sign in to every bank twice, which is what the banks' anti-bot systems count.
A first run from a Google Cloud address is also the first test of whether each bank accepts that address. If one
answers `BLOCKED`, upload that card's file meanwhile; there is no disguising the browser (see "A site that blocks
the scraper").

### Day to day

```bash
sudo finance-scraper status       # services, next run, the sealed key, the browser, the app, the last log lines
sudo finance-scraper update       # the latest code (read-only key), its libraries and patches, then restart
sudo finance-scraper stop         # no listener, no daily run    (start: back on)
sudo finance-scraper daily off    # the daily run alone (🏦 stays on)    (daily on: back on)
sudo finance-scraper run --review --days 45    # a scrape now, for approval
sudo finance-scraper diagnostics  # what support needs (no login, account number or transaction)
sudo finance-scraper outbound     # what the outbound filter wrote down (below)
```

Debian installs security updates (Chromium among them) by itself every day; it does not reboot by itself. A reboot
needs nothing from you: the services start and open the vault themselves. If a Chromium update ever breaks the
agent, the bot says so: every bank fails right after the browser changed. That needs an agent update; meanwhile
upload files.

If the VM is ever rebuilt (a new machine, or a restored disk), the sealed key cannot be opened there, by design.
Run `sudo finance-scraper setup --new-key`, pair again, and type the logins again. No secret is kept anywhere else.

### The outbound filter: only the banks and the app

The agent holds the bank logins while it runs, so the box lets it talk only to the banks and the app. A week of
watching first, then blocking:

1. **Watch.** Nothing is blocked; every name the agent looks up and every connection it opens is written down:
   ```bash
   sudo finance-scraper update && sudo finance-scraper outbound watch
   ```
   The first time it installs nftables and dnsmasq from Debian. It checks, as the agent, that everything still goes
   through, and ends with `✓ Watching`.
2. **A week later**, see what it wrote down, and send it:
   ```bash
   sudo finance-scraper outbound
   ```
   Whatever the banks' pages turned out to load goes on the list (in the code: `SEEN_EXTRA` in `outbound.mjs`), so
   blocking never stops a bank's own page from working.
3. **Block:**
   ```bash
   sudo finance-scraper update && sudo finance-scraper outbound enforce
   ```
   It checks, as the agent, that the app still answers, and that a name off the list, the app's own address asked for
   another site, and another port are all refused. If any check fails, it goes back to watching and says why. It
   ends with `✓ Enforcing`.

If a bank stops working after that: `sudo finance-scraper outbound watch` (nothing blocked again), and send what
`sudo finance-scraper outbound` shows. `sudo finance-scraper status` shows the mode; `sudo finance-scraper outbound
off` removes the filter.

How it works (`outbound.mjs`): an nftables table that matches only the agent's user sends its DNS to a resolver of its
own (dnsmasq), and logs or, when blocking, drops every other new connection. When blocking, the resolver answers only
names on the list, and every HTTPS connection goes past a hostname check that reads the name the browser asked for and
passes it on only to a name on the list. The address alone would not do: the app is on Cloudflare, whose addresses
serve anyone's site. The banks see the same address and the same browser. And when blocking, a scrape first checks
that the filter is in place; if it is not (its rules flushed), no bank login opens.

## The first run for each slot: no double-counting with files

The bank's website and its downloadable statement don't always spell a description the same way, and the
description is part of the dedup id. The same purchase could therefore be booked twice, once from the file and once
from the scrape. So each slot has a **boundary**: the newest date your file uploads reached for it. Scraped rows are
imported only **after** that date. The first Save for a slot fixes it, and it never moves after that. Later scrapes
still pick up purchases that post a few days late, because dedup against earlier scrapes (whose text is stable)
handles the overlap.

**Once a slot is scraped, stop uploading files for it**, or you would bring back the file-vs-scrape overlap the
boundary exists to prevent.

Skipped by design: **pending** transactions (their amount and text change when they settle, so they come in on a
later run once completed) and zero-amount rows (a foreign charge not yet converted). An installment (תשלומים) is
booked in the month it is charged, as the card statement lists it.

To check every row of a plain dry run (it saves nothing): `run --list` prints them all, and `run --csv rows.csv`
writes them for Excel (UTF-8, so Hebrew opens right).

## Scrape now, from the group

Type `/scrape` in the group, or press **🏦 Scrape banks now** under `/menu`. The agent keeps a line open to the app
(the *listener*), so the scrape starts within seconds; one asked for while the machine was off starts as soon as it
is on, and the bot says when it does. The result comes to the group and the dashboard with Save / Discard, as usual.
A request waits on Shabbat and Yom Tov and then runs. The bot's answer says whether the agent is listening right
now, has been quiet since a given time (off, asleep or logged out), or was never set up.

## A site that blocks the scraper

If a site answers `BLOCKED` (HTTP 403/429), automatic runs skip that company for 12 hours. More attempts can only
extend a block. Upload that card's file from its website meanwhile. This agent deliberately does not try to
disguise the browser to get past a bank's anti-bot protection, and uses no fork of the library that does.

## Support: diagnostics

```bash
node scrape.mjs diagnostics        # on a computer
sudo finance-scraper diagnostics   # on the box
```

It prints the versions, where the agent runs, how its vault opens, the schedule and the listener, each company's
last runs (when, ok or the error type, how many found, the newest date) and what the library said about a failure,
scrubbed. It never opens the vault, and nothing in it is a login, an account number, an amount or a transaction.
Read it in full, then send it. Nobody from support will ever ask for a password or sign in to your machine.

## When it breaks

This signs in to websites. It breaks when a bank changes its sign-in page or adds a one-time SMS code; the run
prints a specific hint for each failure:

| Error | Meaning / what to do |
|---|---|
| `INVALID_PASSWORD` / `CHANGE_PASSWORD` | Sign in on the website, fix or change the password, then `add-login` again. |
| `TWO_FACTOR_RETRIEVER_MISSING` | The site now demands an SMS code. The library supports a code only for some companies (e.g. One Zero). Check the library's issues for yours. |
| `BLOCKED` (HTTP 403/429 on the sign-in page) | The site's anti-bot protection refused the automated browser. This is not your password. It usually lifts within a day, so don't retry repeatedly (automatic runs skip that company for 12 hours). Try once tomorrow, and meanwhile upload that card's file from its website. |
| `TIMEOUT` once | Retry. |
| `TIMEOUT` repeatedly, `GENERIC`, `GENERAL_ERROR` | The sign-in page changed. It needs an agent update; meanwhile upload files. |
| `Could not reach the app at …` | The scrape worked; sending it did not. The lines under it give the real cause (DNS, refused, timeout, certificate) and what to check. |
| `Every login failed right after the browser changed` (the box) | A Chromium update broke the agent. Not the banks, not the passwords. It needs an agent update; meanwhile upload files. |
| `This machine has no usable TPM` / `TPM libraries are not installed` (the box) | Setup says exactly which; on Google Cloud the vTPM must be on (create-vm.sh turns it on). |
| `The Mac's Keychain is locked` | Log in to the Mac (or unlock "login" in Keychain Access) and run it again. |

### Local patches to the library

`patches.mjs` fixes the installed library before each run. Each patch is an exact text replacement for one library
version. If the version or the text differs, it changes nothing and the run prints a warning.

- `fibi-optional-balance` (6.12.2): Fibi no longer always shows `.main_balance`, and 6.12.2 waits 10 s for it and
  then fails the whole scrape (`GENERIC`, "Waiting for selector `.main_balance` failed"), although the transactions
  are on the page. The patch makes a missing balance return no balance.

After updating the library, check whether upstream fixed it, then drop the patch or move it to the new version.

### "Could not reach the app" / fetch failed

`HTTP 401 unauthorized`: the request reached the app, but it does not accept this agent's token (revoked, or never
paired). Pair again: on a computer `node scrape.mjs setup --code <the code>`, on the box `sudo finance-scraper pair`.

`UND_ERR_INVALID_ARG: invalid authorization header` means Node refused to send the request at all: the stored token
contained invisible characters from pasting into a hidden prompt. The agent strips them from new input and cleans a
stored token on the next run.

1. `node scrape.mjs show`: the endpoint must be your app's address, with no path after it.
2. Open your app's address in a browser on the same computer.
3. If the browser works but the agent doesn't, the cause line usually names a certificate error
   (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `SELF_SIGNED_CERT_IN_CHAIN`). That means antivirus HTTPS scanning or a proxy
   re-signs traffic: browsers trust it, but Node doesn't read the Windows certificate store. Run with
   `NODE_OPTIONS=--use-system-ca` (PowerShell: `$env:NODE_OPTIONS="--use-system-ca"`), or exclude node.exe from HTTPS
   scanning. Never turn certificate checks off.

## Versions and updates

The agent has numbered releases (`CHANGELOG.md`; `node scrape.mjs version`), published at github.com/roshemet/agent
under the MIT licence. Each release is a package built by that repo's release workflow, with GitHub's attestation of
where it was built, and with every library pinned (`npm-shrinkwrap.json`, integrity hashes included): this code handles
bank logins, so the bank library is updated on purpose, in a release, never by accident. The family chooses when to
install a release.

`--show-browser` opens the real browser window, to watch where a sign-in gets stuck.

## Commands

```
node scrape.mjs setup [--endpoint <url>] [--code <code>] [--time 09:00]   a computer: vault, pairing, daily run, listener
node scrape.mjs uninstall [--forget-key | --delete-vault]
node scrape.mjs diagnostics | version | show | companies
node scrape.mjs add-login <company> | remove-login <company> | import-logins <file>
node scrape.mjs map <company> <last4> <bank|card1|card2|card3|card4|skip>
node scrape.mjs pair [--code <code>] | check | set-endpoint <url>
node scrape.mjs run [--review] [--days 45] [--only <company>] [--list] [--csv rows.csv] [--show-browser]
node scrape.mjs run --auto [--daily]   what the daily run starts
node scrape.mjs poll                   the listener
node scrape.mjs github-connect --repo <owner>/<repo> [--code <code>] [--days 45]   the logins into a GitHub repo, checked there
node scrape.mjs github-run [--days 45] what the repo's agent.yml runs on GitHub (--days 0: a check, no bank)
--vault <path>   another vault file (default ~/.roshemet/vault.json)
```

On the box, every command is `sudo finance-scraper <command>` (`box.mjs`), plus `setup`, `start`, `stop`, `status`,
`update`, `daily [on | off]` and `outbound`. The first computer's commands (`init`, `remember`, `schedule`, `automate`, `listen`,
`set-token`) still work for a vault opened by a passphrase; a new computer uses `setup`.

Forgot the passphrase of such a vault? There is no recovery. Delete the vault and run `setup` again.
