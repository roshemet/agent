# Changes

Numbered releases of the agent (`node scrape.mjs version`). The family chooses when to install one.

## Not released yet

- A card is named with its last 4 digits from the vault's own account map ("Card 4 (••1234)") in the run's lines and
  in `--csv`'s file.

## 1.1.0 (2026-10-11)

The agent on GitHub, and the first release published (github.com/roshemet/agent, MIT).

- **`github-run`:** the daily "Bank run" of a family's private repo made from the Roshemet template. The logins come
  from the repo's encrypted secrets; every value is hidden from the run's log before anything is printed, and taken
  out of the environment before the browser starts. It does not run in a public repo, nor on Shabbat or Yom Tov.
  `--days 0` checks everything without a bank: the repo is private, the logins and the map are there, the app accepts
  the repo's token, the browser starts with its sandbox on. The run's page shows a table per login (ok or the error
  type, how many, the newest date). The scrape log comes back from GitHub's cache, so a bank that blocked a run is
  left alone for 12 hours.
- **`github-connect`:** from the vault on a computer or box into the family's own repo: each login sealed with the
  repo's key (libsodium, as GitHub requires), the app's address and the account map, the repo's own pairing with the
  app; then GitHub's check and a first run, with what each said. A GitHub token is typed once and kept nowhere. On a
  box (`sudo finance-scraper github-connect`) the box's own daily run then pauses; 🏦 stays there
  (`sudo finance-scraper daily on | off`).
- **The box** keeps the family's app address in `/etc/finance-scraper/app.json` (its first `update` reads it from the
  vault once); its outbound filter's list holds every bank the library knows.
- **Fixed:** the browser check took Chrome's "You are NOT adequately sandboxed" for sandboxed.
- New library: libsodium-wrappers 0.8.4 (GitHub's secret encryption). israeli-bank-scrapers unchanged (6.12.2).

## 1.0.0 (2026-10-11)

The first numbered release: the agent household #1 has run since 2026-10-01 (on a Windows PC, then on a Linux box),
made into a package for any family.

- **A family's computer, Windows or Mac:** `setup` makes the vault with a random key that Windows (DPAPI) or the
  Mac's Keychain keeps, so nobody types a passphrase; pairs with the family's app (a code from the dashboard; the
  agent's token can only send scrapes for approval); starts the daily run and the 🏦 listener (Task Scheduler and the
  Startup folder on Windows, launchd on the Mac); and checks each step. `uninstall` undoes it.
- **`diagnostics`:** what support needs (versions, where it runs, how the vault opens, the schedule, each company's
  last runs), with no login, account number, amount or transaction. It never opens the vault.
- **The scrape log** keeps what the library said about a failed sign-in, with the login and anything that looks like
  a number, a name or a transaction taken out; the same text is what a run prints.
- No app address is built in: each family's agent is given its own.
- Unchanged: the vault format, the box (`sudo finance-scraper …`), the outbound filter, quiet days, the 12-hour back-off
  after a block, israeli-bank-scrapers 6.12.2 with the `fibi-optional-balance` patch.
