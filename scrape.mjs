#!/usr/bin/env node
// The family's agent (Roshemet; this folder is the package roshemet-agent). Runs on the family's own computer,
// box or GitHub, never in the app: it logs into the bank and card websites with israeli-bank-scrapers (a
// headless Chrome), maps each account by company + last 4 digits to an app slot, and sends the transactions to
// the family's own app for approval. The logins never leave the machine it runs on.
//
// A family's computer (Windows or Mac), from nothing:
//   node scrape.mjs setup --endpoint <the app's address>   the vault (its key kept by Windows or the Keychain),
//                                              pairing (the code from the dashboard), the daily run, the 🏦 listener
//   node scrape.mjs add-login <company>        then map, and a first run: run --review --days 90
//   node scrape.mjs diagnostics                what support needs; no login, account number or transaction
//   node scrape.mjs uninstall [--forget-key | --delete-vault]   stop the daily run and the listener
//   node scrape.mjs version
//
// Every command:
//   node scrape.mjs init                       create the encrypted vault (opened by a passphrase)
//   node scrape.mjs add-login <company>        store (or replace) a login
//   node scrape.mjs remove-login <company>
//   node scrape.mjs import-logins <file>       logins + account map from another vault (the PC's), never its token
//   node scrape.mjs map <company> <last4> <bank|card1|card2|card3|card4|skip>
//   node scrape.mjs set-endpoint <url>   |   node scrape.mjs set-token [--generate]
//   node scrape.mjs check                      does the app accept the token? (writes nothing)
//   node scrape.mjs show                       config, secrets masked
//   node scrape.mjs companies                  what the library supports
//   node scrape.mjs run [--commit] [--days 45] [--only <company>] [--show-browser]
//   node scrape.mjs automate [--day SUN] [--time 09:00]   remember + check unattended + schedule, verified
//   node scrape.mjs remember | forget          let Windows unlock the vault (for --auto)
//   node scrape.mjs schedule [--day SUN] [--time 09:00] | unschedule
//   node scrape.mjs run --auto                 unattended dry run; the bot asks to Save
//   node scrape.mjs poll                       the listener: 🏦 / /scrape in the group starts a scrape within seconds
//   node scrape.mjs listen                     start the listener at logon, start it now, and check it reaches the app
//   node scrape.mjs run --list [--csv rows.csv] dry run listing EVERY row (and to a CSV for Excel)
//   node scrape.mjs run --review               send to the dashboard and the group for approval
//   node scrape.mjs pair [--code <code>]       pair this machine with the app (code from the dashboard)
//
// On the Linux box every command runs as `sudo finance-scraper <command>` (box.mjs).
//
// GitHub (the family's own private repo, made from the template; github.mjs, githubConnect.mjs):
//   node scrape.mjs github-connect --repo <owner>/<name> [--code <pairing code>] [--days 45]
//                                              from this machine's vault: the logins into the repo's secrets, the
//                                              repo paired with the app, then GitHub's check and a first run
//   node scrape.mjs github-run [--days 45]      agent.yml's step: the logins from the repo's secrets, for approval;
//                                              --days 0 checks everything without signing in to a bank
// Options for every command: --vault <path> (default ~/.roshemet/vault.json; ~/.finance-cloud/scraper-vault.json if there is one)

import * as fs from 'node:fs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  encryptVault, decryptVault, emptyConfig, setMapping, buildPayload,
  adviceFor, healthWarnings, failureWarnings, protectKey, unprotectKey,
  TASK_NAME, autoCmd, schtasksCreateArgs, describeFetchError, rowsCsv, slotLabel, classifyFailure, recentBlock,
  POLL_TASK_NAME, quietWindow, describeQuiet, autoRunQuietSkip, pollCmd, hiddenLauncherVbs, schtasksPollArgs,
  STARTUP_LAUNCHER, startupFolder, listenerAlive, listenLoop, Refused, takeLock, refreshLock, releaseLock,
  cleanSecretInput, tokenProblem, cleanConfigSecrets, generateToken, refusalMessage, interpretCheck,
  readSealedKey, LINUX_INSTEAD, normalizePairCode, pairRefusal, commandFor, unmappedLine, importLogins,
  vaultMeta, cleanEndpoint,
} from './lib.mjs';
import {
  AGENT, keychainSave, keychainLoad, keychainRemove, dailyPlist, listenPlist, launchctlArgs, launchdState,
  dailyCmd, schtasksDailyArgs, schtasksQueryArgs, schtasksState,
} from './computer.mjs';
import { runLogEntry, diagnosticsReport } from './diagnostics.mjs';
import {
  githubEnv, maskLines, readGithubSettings, runDays, repoVisibility, PUBLIC_REPO, unmappedGithubLine, trimLog,
  runSummary, checkSummary,
} from './github.mjs';
import { cleanRepo, tokenSteps, connectRepo, GithubRefused } from './githubConnect.mjs';
import { nodeTooOld, BOX } from './linux.mjs';
import { randomBytes } from 'node:crypto';
import { release, arch } from 'node:os';
import { spawnSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { ensurePatched, PATCHES } from './patches.mjs';
import { filterGuard, selftest } from './outbound.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--vault', '--days', '--only', '--day', '--time', '--csv', '--endpoint', '--name', '--code', '--repo'].includes(args[i - 1])));
const [cmd, ...rest] = positional;

// The household's first PC kept its vault in ~/.finance-cloud; a new computer keeps it in ~/.roshemet.
const LEGACY_VAULT = join(homedir(), '.finance-cloud', 'scraper-vault.json');
const VAULT = opt('vault', existsSync(LEGACY_VAULT) ? LEGACY_VAULT : join(homedir(), '.roshemet', 'vault.json'));
/** What the agent may keep in the clear beside the vault: when it paired, the app's address, the daily hour. */
const STATE = join(dirname(VAULT), 'agent-state.json');
const LOG = join(dirname(VAULT), 'scrape-log.jsonl');
const KEYFILE = join(dirname(VAULT), 'vault-key.dpapi');
// The Linux box: systemd unseals the vault key for the scraper's services and for
// `sudo finance-scraper <command>` (see linux.mjs). Nowhere else has it.
const SEALED_KEY = process.env.CREDENTIALS_DIRECTORY ? join(process.env.CREDENTIALS_DIRECTORY, 'vault-key') : '';
const sealed = () => Boolean(SEALED_KEY) && existsSync(SEALED_KEY);
// The Linux box drives Debian's Chromium (kept patched by its security updates) instead of
// the Chrome puppeteer pins. Unset elsewhere: puppeteer's own Chrome, as before.
const CHROME = process.env.FINANCE_SCRAPER_CHROME || '';
// GitHub's runner: the logins come from the repo's secrets (github.mjs), never a vault or a prompt.
const GITHUB_RUN = cmd === 'github-run';
// `poll` runs unattended too: it is started by Task Scheduler, never at a keyboard. So is a run on GitHub.
const AUTO = flag('auto') || cmd === 'poll' || GITHUB_RUN;
// The daily run: a day with nothing new and nothing wrong stays quiet in the group. On GitHub, its schedule.
const DAILY = flag('daily') || (GITHUB_RUN && process.env.GITHUB_EVENT_NAME === 'schedule');

// --- prompts ---------------------------------------------------------------

// Piped input: ONE reader for the whole run (a readline per question would
// swallow every buffered line on the first question). A terminal gets a fresh
// readline per question so it never competes with askHidden's raw mode.
let piped;
async function ask(q) {
  if (!process.stdin.isTTY) {
    process.stdout.write(q);
    piped ??= createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
    const r = await piped.next();
    if (r.done) throw new Error('Input ended before every question was answered.');
    return r.value.trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

/** Read a line without echoing it (passwords, the passphrase, the token). */
function askHidden(q) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return ask(q).then(cleanSecretInput); // piped input: nothing to hide from
  return new Promise((resolve, reject) => {
    stdout.write(q);
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      err ? reject(err) : resolve(cleanSecretInput(buf));
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// --- vault -----------------------------------------------------------------

let passphrase = '';
/** Where this vault's key lives when nobody types it: 'dpapi' (Windows) or 'keychain' (Mac), from setup; null for
 *  a passphrase (or the box's sealed key). Kept on every save. */
let keyStore = null;

/** A program the agent asks something of (`security`, `launchctl`, `schtasks`), as { status, stdout, stderr }.
 *  A secret goes in on stdin (`input`), never on its command line. */
function runProgram(program, programArgs, { input } = {}) {
  const r = spawnSync(program, programArgs, { input, encoding: 'utf8', windowsHide: true });
  return { status: r.status ?? 127, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? r.error.message : ''}` };
}

async function openVault() {
  if (!existsSync(VAULT)) throw new Error(`No vault at ${VAULT}. Run: ${sealed() ? 'sudo finance-scraper setup' : 'node scrape.mjs setup'}`);
  const text = readFileSync(VAULT, 'utf8');
  keyStore = vaultMeta(text).key;
  if (sealed()) {
    passphrase = readSealedKey(readFileSync(SEALED_KEY, 'utf8'));
  } else if (keyStore === 'keychain') {
    passphrase = keychainLoad(VAULT, runProgram);
  } else if (keyStore === 'dpapi') {
    if (!existsSync(KEYFILE)) {
      throw new Error(`This vault opens with a key Windows keeps (${KEYFILE}), and that file is gone. ` +
        'Run setup again: it makes a new vault, and the logins must be added again.');
    }
    passphrase = await unprotectKey(readFileSync(KEYFILE, 'utf8'));
  } else if (AUTO && process.platform !== 'win32') {
    throw new Error('On Linux an unattended run opens the vault with the key sealed to the machine: start it through ' +
      'systemd (sudo finance-scraper start) or run the command as: sudo finance-scraper <command>');
  } else if (AUTO) {
    // Unattended: Windows unlocks it (see `remember`). Never falls back to a prompt.
    if (!existsSync(KEYFILE)) throw new Error('No saved unlock. On this PC, run: node scrape.mjs remember');
    passphrase = await unprotectKey(readFileSync(KEYFILE, 'utf8'));
  } else {
    passphrase = await askHidden('Vault passphrase: ');
  }
  const config = decryptVault(text, passphrase);
  // Secrets pasted before cleanSecretInput existed may carry paste markers: fix them once.
  if (cleanConfigSecrets(config)) {
    saveVault(config);
    console.log('Removed hidden characters (from pasting) from the stored token / logins, and re-saved the vault.');
  }
  return config;
}
function saveVault(config) {
  mkdirSync(dirname(VAULT), { recursive: true });
  const tmp = `${VAULT}.tmp`;
  writeFileSync(tmp, encryptVault(config, passphrase, undefined, { key: keyStore }), { mode: 0o600 });
  renameSync(tmp, VAULT); // never leave a half-written vault behind
}

const readState = () => readJson(STATE) ?? {};
function writeState(patch) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, `${JSON.stringify({ ...readState(), ...patch }, null, 1)}\n`, { mode: 0o600 });
}

function readLog() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const LISTEN_LOCK = join(dirname(VAULT), 'listen.lock');
const SCRAPE_LOCK = join(dirname(VAULT), 'scrape.lock');
const LISTEN_STOP = join(dirname(VAULT), 'listen.stop');
const POLL_LOG = join(dirname(VAULT), 'poll.log');
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const pidAlive = (pid) => {
  try { process.kill(pid, 0); } catch (e) { return e?.code === 'EPERM'; }
  // One that has ended but not been collected yet (a "zombie") is not running: Linux says so in /proc.
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
};

/** The listener (started at logon, and by the 15-minute task if it ever stopped; on
 *  Linux by systemd): keeps a line open to the app, so 🏦 / /scrape in the group starts
 *  a scrape within seconds — and a request made while the machine was off runs as soon
 *  as it is on. One at a time: if another is running this exits at once. On Shabbat
 *  and Yom Tov it sleeps instead of asking (the result would post to the group), so a
 *  request waits and runs after. Logs only when something happens. */
async function poll() {
  if (listenerAlive(readJson(LISTEN_LOCK), { ownPid: process.pid, pidAlive })) return;
  const lock = { pid: process.pid, at: new Date().toISOString(), connectedAt: null };
  const saveLock = () => { lock.at = new Date().toISOString(); writeFileSync(LISTEN_LOCK, JSON.stringify(lock)); };
  saveLock();
  const beat = setInterval(saveLock, 30_000); // also while a scrape runs
  try {
    const config = await openVault();
    const url = `${config.endpoint}/api/scrape/request/wait`;
    console.log(`--- ${new Date().toISOString()} listening for 🏦 / /scrape`);
    const why = await listenLoop({
      ask: async () => {
        let res;
        try {
          // The app holds this ~20 s; a much longer silence means the line is dead.
          res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(60_000) });
        } catch (err) {
          throw new Error(describeFetchError(err, url));
        }
        const body = await res.json().catch(() => ({}));
        if ([401, 403, 503].includes(res.status)) throw new Refused(refusalMessage(res.status, body));
        if (!res.ok) throw new Error(refusalMessage(res.status, body));
        return body;
      },
      scrape: () => run(config),
      shouldStop: () => (existsSync(LISTEN_STOP) ? 'stop' : null),
      quiet: (t) => quietWindow(t),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (line) => console.log(line),
      onConnected: () => { if (!lock.connectedAt) { lock.connectedAt = new Date().toISOString(); saveLock(); } },
    });
    if (why === 'stop') { try { unlinkSync(LISTEN_STOP); } catch { /* gone */ } }
    console.log(`--- ${new Date().toISOString()} stopped listening (${why})`);
  } finally {
    clearInterval(beat);
    if (readJson(LISTEN_LOCK)?.pid === process.pid) { try { unlinkSync(LISTEN_LOCK); } catch { /* gone */ } }
  }
}

async function lib() {
  let libDir;
  try {
    libDir = dirname(createRequire(import.meta.url).resolve('israeli-bank-scrapers/package.json'));
  } catch {
    throw new Error('israeli-bank-scrapers is not installed. In scripts/scrape run: npm ci');
  }
  // Local fixes go in BEFORE the library is loaded (see patches.mjs).
  for (const line of await ensurePatched(libDir)) console.log(`⚠ ${line}`);
  const m = await import('israeli-bank-scrapers');
  return m.default ?? m;
}

// --- commands --------------------------------------------------------------

async function init() {
  if (existsSync(VAULT)) throw new Error(`A vault already exists at ${VAULT}.`);
  if (flag('sealed')) {
    // The Linux box: the key is the one setup sealed to this machine. Nothing to type;
    // the app token comes from pairing.
    if (!sealed()) throw new Error('No sealed key here. Run: sudo finance-scraper setup');
    passphrase = readSealedKey(readFileSync(SEALED_KEY, 'utf8'));
    const config = emptyConfig();
    config.endpoint = cleanEndpoint(opt('endpoint', '')) ?? '';
    if (!config.endpoint) throw new Error('Give the app\'s address: --endpoint https://… (nothing was saved).');
    saveVault(config);
    return console.log(`  ✓ Vault created: ${VAULT} (it opens with the key sealed to this machine).`);
  }
  const a = await askHidden('New vault passphrase (8+ characters): ');
  const b = await askHidden('Repeat it: ');
  if (a !== b) throw new Error('The two passphrases differ.');
  passphrase = a;
  const config = emptyConfig();
  config.endpoint = cleanEndpoint(opt('endpoint', '') || await ask('Your app\'s address (https://…): ')) ?? '';
  if (!config.endpoint) throw new Error('That is not an app address (https://…). Nothing was saved.');
  config.token = await askHidden('Scraper token (the SCRAPER_TOKEN secret): ');
  if (tokenProblem(config.token)) throw new Error(`${tokenProblem(config.token)} (nothing was saved)`);
  saveVault(config);
  console.log(`Vault created: ${VAULT}\nNext: ${commandFor('add-login <company>', sealed())}   (see: ${commandFor('companies', sealed())})`);
}

async function addLogin(company) {
  const { SCRAPERS } = await lib();
  const def = SCRAPERS[company];
  if (!def) throw new Error(`Unknown company "${company}". See: ${commandFor('companies', sealed())}`);
  const config = await openVault();
  const creds = {};
  for (const field of def.loginFields) {
    if (field === 'otpCodeRetriever') continue; // asked for at run time
    const secret = /password|token|id|num|card6Digits|userCode/i.test(field);
    creds[field] = secret ? await askHidden(`${def.name} ${field}: `) : await ask(`${def.name} ${field}: `);
  }
  config.logins[company] = creds;
  saveVault(config);
  console.log(`Saved the ${def.name} login. Run \`${commandFor('run', sealed())}\` to see its accounts, then map them.`);
}

/** Bring the logins and the account map over from another vault file (the Windows PC's
 *  scraper-vault.json), opened with that vault's passphrase. Its token is never copied. */
async function importLoginsFrom(file) {
  if (!file) throw new Error(`Usage: ${commandFor('import-logins <file>', sealed())}   (the PC's scraper-vault.json)`);
  if (!existsSync(file)) throw new Error(`No file at ${file}.`);
  let text = readFileSync(file, 'utf8');
  try {
    const f = JSON.parse(text);
    if (f?.v !== 1 || f.kdf !== 'scrypt') throw new Error();
  } catch {
    throw new Error('That is not a scraper vault. Upload scraper-vault.json from the PC: C:\\Users\\<you>\\.finance-cloud\\');
  }
  const config = await openVault();
  let other;
  for (let tries = 0; !other; tries++) {
    try {
      other = decryptVault(text, await askHidden("The PC vault's passphrase (the one you chose on the PC): "));
    } catch {
      if (tries >= 2) throw new Error('That passphrase does not open the file (3 tries). Nothing was changed. Run the command again when you have it.');
      console.log('That passphrase does not open it. Try again.');
    }
  }
  text = '';
  const r = importLogins(config, other);
  if (!r.logins.length) throw new Error('That vault has no logins in it. Nothing was changed.');
  saveVault(config);
  console.log(`✓ Logins: ${r.logins.join(', ')}${r.replaced.length ? ` (replaced: ${r.replaced.join(', ')})` : ''}`);
  console.log(r.mapped.length ? `✓ Account map: ${r.mapped.map((k) => `${k.replace(':', ' ••')} → ${config.map[k]}`).join(', ')}`
    : '  No account map in that vault: map the accounts after the first run.');
  console.log("  Not copied: the PC's token. This machine keeps its own.");
}

async function removeLogin(company) {
  const config = await openVault();
  if (!config.logins[company]) throw new Error(`No login stored for ${company}.`);
  delete config.logins[company];
  saveVault(config);
  console.log(`Removed the ${company} login.`);
}

async function map(company, digits, slot) {
  const config = await openVault();
  setMapping(config, company, digits, slot);
  saveVault(config);
  console.log(`${company} ••${digits} → ${slot}`);
}

async function show() {
  const config = await openVault();
  console.log(`Vault:    ${VAULT}\nEndpoint: ${config.endpoint}\nToken:    ${config.token ? `set (${config.token.length} chars)` : 'NOT SET'}`);
  console.log('Logins:   ' + (Object.keys(config.logins).join(', ') || 'none'));
  console.log('Accounts:');
  for (const [k, slot] of Object.entries(config.map)) console.log(`  ${k.replace(':', ' ••')} → ${slot}`);
}

async function companies() {
  const { SCRAPERS } = await lib();
  for (const [id, d] of Object.entries(SCRAPERS)) console.log(`${id.padEnd(18)} ${d.name.padEnd(20)} ${d.loginFields.join(', ')}`);
}

/** One scrape at a time on this machine (see takeLock). */
async function run(preloaded) {
  // The daily timer / weekly task: never on Shabbat or Yom Tov (the result posts to the
  // group). A 🏦 request the listener took just before a window still runs: the listener
  // does not ask inside one, and the 13:00 start leaves hours before Shabbat itself.
  if (AUTO && cmd === 'run') {
    const skip = autoRunQuietSkip();
    if (skip) return console.log(skip);
  }
  const lockOpts = { fs, pid: process.pid, pidAlive };
  mkdirSync(dirname(SCRAPE_LOCK), { recursive: true }); // GitHub's runner has no vault, so no folder for it yet
  if (!takeLock(SCRAPE_LOCK, lockOpts)) {
    const held = readJson(SCRAPE_LOCK);
    const since = held?.at ? ` (started ${new Date(held.at).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' })})` : '';
    const msg = `Another scrape is already running on this machine${since}. Not starting a second one: it would log into every bank twice.`;
    if (AUTO) return console.log(`${new Date().toISOString()} ${msg} Its result comes to the group.`);
    throw new Error(`${msg} Wait for it to finish, then try again.`);
  }
  const lockBeat = setInterval(() => refreshLock(SCRAPE_LOCK, lockOpts), 30_000);
  try {
    return await scrapeOnce(preloaded);
  } finally {
    clearInterval(lockBeat);
    releaseLock(SCRAPE_LOCK, lockOpts);
  }
}

async function scrapeOnce(preloaded) {
  const commit = flag('commit');
  const review = AUTO || flag('review');
  const csvPath = opt('csv', '');
  const listAll = flag('list') || !!csvPath;
  if (review && commit) throw new Error('--auto/--review never save here: the household approves on the dashboard or in the chat.');
  // A paired box's token cannot save (review only): say so before ten minutes of logins.
  if (commit && sealed()) throw new Error('On the box, scrapes go for approval: use --review, then Save on the dashboard or in the group.');
  if (listAll && (commit || review)) throw new Error('--list/--csv are for a plain dry run (no --commit, --review or --auto).');
  const days = Math.max(1, Math.min(365, parseInt(opt('days', '45'), 10) || 45));
  const only = opt('only', '');
  // On a box enforcing the outbound filter, no bank login opens unless the filter is in place.
  const unfiltered = await filterGuard();
  if (unfiltered) throw new Error(unfiltered);
  const config = preloaded ?? await openVault();
  // Before any login: a token the app can't accept would fail only after the whole scrape.
  const tokenIssue = tokenProblem(config.token);
  if (tokenIssue) throw new Error(tokenIssue);
  const { createScraper } = await lib();
  const browser = browserVersion(); // recorded per login, so a browser update that breaks every login is named
  const startDate = new Date(Date.now() - days * 86_400_000);
  const today = new Date().toISOString().slice(0, 10);
  if (AUTO) console.log(`--- ${new Date().toISOString()} automatic run`);

  const results = [];
  const failures = [];
  const skippedNotes = [];
  const entries = []; // this run's log lines, for GitHub's run summary
  const priorLog = readLog();
  for (const [company, creds] of Object.entries(config.logins)) {
    if (only && company !== only) continue;
    // Back off from a site that just blocked us: another attempt can only extend it.
    const block = recentBlock(priorLog, company);
    if (block) {
      const when = new Date(block.at).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      if (AUTO) {
        skippedNotes.push(`${company}: skipped — it blocked the scraper at ${when}; automatic runs wait 12 hours for the block to lift.`);
        console.log(`${company}: skipped (blocked at ${when}; automatic runs wait 12 hours)`);
        continue;
      }
      console.log(`⚠ ${company} blocked the scraper at ${when}. Trying once because you asked; if it is still blocked, wait a day.`);
    }
    process.stdout.write(`${company}: scraping ${days} days… `);
    const scraper = createScraper({
      companyId: company, startDate, combineInstallments: false, showBrowser: flag('show-browser'),
      ...(CHROME ? { executablePath: CHROME } : {}),
    });
    const credentials = { ...creds };
    if (company === 'oneZero' && !credentials.otpLongTermToken) {
      if (AUTO) {
        failures.push({ company, errorType: 'TWO_FACTOR_RETRIEVER_MISSING' });
        console.log('skipped: needs an SMS code, which an unattended run cannot type');
        continue;
      }
      credentials.otpCodeRetriever = () => ask('SMS code: ');
    }
    let r;
    try {
      r = await scraper.scrape(credentials);
    } catch (err) {
      r = { success: false, errorType: 'GENERAL_ERROR', errorMessage: String(err?.message ?? err) };
    }
    // One log line per login: never the login, an account number or a transaction (diagnostics.mjs).
    const entry = runLogEntry({ at: new Date().toISOString(), company, browser }, r, creds, classifyFailure);
    entries.push(entry);
    if (r.success) {
      console.log(`${r.accounts.length} account(s), ${entry.txns} transaction(s)`);
      results.push({ company, at: entry.at, accounts: r.accounts });
    } else {
      failures.push({ company, errorType: entry.errorType });
      console.log(`FAILED (${entry.errorType}) — ${adviceFor(entry.errorType)}`);
      // This output goes to a log file too (auto.log, poll.log): what the library said, scrubbed like the log line.
      if (entry.said) console.log(`  ${entry.said}`);
    }
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, JSON.stringify(entry) + '\n'); // no secrets, no account numbers
  }

  const { payload, unmapped, skipped } = buildPayload(config, results, !commit);
  const unmappedLines = unmapped.map((u) => (GITHUB_RUN ? unmappedGithubLine(u) : unmappedLine(u, sealed())));
  for (const l of unmappedLines) console.log(l);
  for (const sk of skipped) console.log(`Skipped (mapped to skip): ${sk.company} ••${sk.last4}`);

  // Health: read the whole log back and warn about companies that look broken.
  const health = healthWarnings(readLog(), today);

  const post = async (body) => {
    const url = `${config.endpoint}/api/ingest/scraped`;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(describeFetchError(err, url));
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(refusalMessage(res.status, out));
    return out;
  };

  if (review) {
    // Failures and warnings go to the chat too — that is the point of automating it.
    const warnings = [...new Set([...failureWarnings(failures), ...skippedNotes, ...unmappedLines, ...health])].slice(0, 10).map((w) => w.slice(0, 300));
    // The daily timer's run stays quiet in the group on a day with nothing new and nothing wrong.
    const out = await post({ dryRun: true, review: true, accounts: payload.accounts, failures, warnings, ...(DAILY ? { quietIfEmpty: true } : {}) });
    const outcome = out.runId != null
      ? `Sent for approval (run ${out.runId}): check every row on the dashboard (Upload tab, Bank scrape, "Show all"), then Save there or in the group.`
      : `Nothing new to approve${out.posted ? '; the chat was told' : ''}.`;
    console.log(outcome);
    return { entries, notes: [...skippedNotes, ...unmappedLines], outcome };
  }

  if (payload.accounts.length) {
    const body = await post(listAll ? { ...payload, listAll: true } : payload);
    console.log(`\n${body.dryRun ? 'DRY RUN — nothing was saved. Re-run with --commit to save.' : 'SAVED.'}`);
    for (const sl of body.slots) {
      console.log(`\n${slotLabel(sl.slot, config.map)}: +${sl.added} new, ${sl.duplicates} already there, ${sl.excluded} card bills/ATM/transfers, ` +
        `${sl.beforeCutoff} before ${sl.importsFrom || 'the start'}, ${sl.pending} pending skipped` +
        (sl.invalid ? `, ${sl.invalid} with unreadable dates` : ''));
      if (sl.pinned) {
        console.log(`  First scrape for this slot: files cover it up to ${sl.boundary || '(nothing yet)'}; ` +
          `only later dates are imported${body.dryRun ? ' (fixed when you --commit)' : ' — fixed from now on'}.`);
      }
      for (const t of sl.newRows) console.log(`  ${t.date}  ${String(t.amount).padStart(9)}  ${t.type === 'income' ? '+' : ' '} ${t.description}`);
      if (!listAll && sl.added > sl.newRows.length) console.log(`  …and ${sl.added - sl.newRows.length} more (see them all: --list or --csv rows.csv)`);
      for (const t of sl.excludedRows ?? []) console.log(`  ${t.date}  ${String(t.amount).padStart(9)}  [${t.kind}, kept out of spending] ${t.description}`);
    }
    if (csvPath) {
      writeFileSync(csvPath, rowsCsv(body.slots, config.map));
      console.log(`\nEvery row written to ${csvPath} (opens in Excel).`);
    }
  } else if (!unmapped.length) {
    console.log('Nothing to send.');
  }
  if (health.length) console.log('\n⚠ Scrape health:\n' + health.map((w) => `  - ${w}`).join('\n'));
}

/** POST an empty payload: the token is checked first, so a 400 proves it and nothing is written. */
async function checkToken(config) {
  const url = `${config.endpoint}/api/ingest/scraped`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` }, body: '{}',
    });
  } catch (err) {
    return { ok: false, message: describeFetchError(err, url) };
  }
  return interpretCheck(res.status, await res.json().catch(() => ({})));
}

async function check() {
  const config = await openVault();
  const issue = tokenProblem(config.token);
  if (issue) throw new Error(issue);
  const r = await checkToken(config);
  console.log(`${r.ok ? '✓' : '✗'} ${config.endpoint}: ${r.message}`);
  const logins = Object.keys(config.logins ?? {});
  console.log(logins.length
    ? `  Logins: ${logins.join(', ')} · accounts mapped: ${Object.keys(config.map ?? {}).length}`
    : `  No logins yet: add each with ${commandFor('add-login <company>', sealed())}`);
  if (!r.ok) process.exitCode = 1;
}

/** Pair this machine with the app: the code from the dashboard, once, for this box's own
 *  token (review only). Then proves the app accepts it, writing nothing. */
async function pair() {
  const c = await pairWith(await openVault());
  console.log(`${c.ok ? '✓' : '✗'} ${c.message}`);
  if (!c.ok) process.exitCode = 1;
}

/** The pairing itself; returns the app's answer to the new token (`checkToken`). */
async function pairWith(config) {
  const name = cleanSecretInput(opt('name', '') || hostname()).slice(0, 40);
  const given = opt('code', '');
  if (!given) console.log('On the dashboard: Upload tab → Bank scrape → "Pair a scraper box". It shows a code like K7QM-3XPD.');
  const code = normalizePairCode(cleanSecretInput(given || await ask('The code: ')));
  if (!code) throw new Error('That is not a pairing code: 8 letters and digits, like K7QM-3XPD. Check it on the dashboard and run pair again.');
  const url = `${config.endpoint}/api/scrape/pair`;
  let res;
  try {
    // What this machine is, for the app's alarm and dashboard (a GitHub repo pairs through github-connect).
    const kind = !sealed() && (isMac() || isWindows()) ? 'computer' : 'box';
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name, kind }) });
  } catch (err) {
    throw new Error(describeFetchError(err, url));
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new Error(pairRefusal(res.status, body));
  config.token = body.token;
  saveVault(config);
  writeState({ pairedAt: new Date().toISOString(), endpoint: config.endpoint });
  console.log(`✓ Paired as "${body.device?.name ?? name}". Checking that the app accepts it (writes nothing)…`);
  return checkToken(config);
}

/** The browser's version, for the scrape log (Debian's Chromium on the Linux box). */
function browserVersion() {
  if (!CHROME) return undefined;
  const r = spawnSync(CHROME, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 ? String(r.stdout).trim().slice(0, 80) : undefined;
}

/** The outbound filter's self-test, run as the scraper (box.mjs runs it after switching
 *  the filter on). Opens no vault. */
async function filterSelftest(mode) {
  if (mode !== 'watch' && mode !== 'enforce') throw new Error('Usage: filter-selftest watch|enforce');
  const config = await openVault();
  const results = await selftest(mode, { app: new URL(config.endpoint).hostname });
  for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.what}: ${r.detail}`);
  if (!results.every((r) => r.pass)) process.exitCode = 1;
}

/** Does the browser start under this machine's settings, with its sandbox on? { ok, line }. Opens no website. */
async function chromeStarts() {
  let libDir;
  try {
    libDir = dirname(createRequire(import.meta.url).resolve('israeli-bank-scrapers/package.json'));
  } catch {
    return { ok: false, line: 'israeli-bank-scrapers is not installed. In scripts/scrape run: npm ci' };
  }
  // The library's own puppeteer, so this checks exactly what a scrape will use.
  const { default: puppeteer } = await import(pathToFileURL(createRequire(join(libDir, 'package.json')).resolve('puppeteer')).href);
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, ...(CHROME ? { executablePath: CHROME } : {}) });
  } catch (err) {
    return { ok: false, line: `The browser does not start${CHROME ? ` (${CHROME})` : ''}: ${String(err?.message ?? err).split('\n')[0].slice(0, 300)}` };
  }
  try {
    const page = await browser.newPage();
    if (process.platform !== 'linux') {
      // Windows and macOS sandbox Chrome themselves (puppeteer turns nothing off); chrome://sandbox is Linux's page.
      await page.goto('about:blank');
      return { ok: true, line: `${await browser.version()} starts.` };
    }
    await page.goto('chrome://sandbox');
    const text = await page.evaluate(() => document.body.innerText);
    // Chrome's page says "You are adequately sandboxed." or "You are NOT adequately sandboxed."
    const sandboxed = /You are adequately sandboxed/i.test(text);
    return { ok: sandboxed, line: `${await browser.version()} starts${sandboxed ? ' with its sandbox on.' : ', but WITHOUT its sandbox.'}` };
  } finally {
    await browser.close();
  }
}

/** Setup's check (`chrome-check`): the browser starts, with its sandbox on. */
async function chromeCheck() {
  const c = await chromeStarts();
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.line}`);
  if (!c.ok) process.exitCode = 1;
}

async function generateAndSetToken() {
  // wrangler's login can redeploy the Worker: it must never sit on the box.
  if (sealed()) throw new Error('On the box, connect with: sudo finance-scraper pair (no Cloudflare login is ever needed here).');
  const config = await openVault();
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (!existsSync(join(repoRoot, 'wrangler.toml'))) throw new Error(`No wrangler.toml at ${repoRoot}: run this from the repo's scripts/scrape folder.`);
  const token = generateToken();
  console.log('Setting a new SCRAPER_TOKEN on the Worker with wrangler (it may ask you to log in)…');
  // Piped, never pasted: wrangler reads stdin to the end and trims trailing whitespace.
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', 'SCRAPER_TOKEN'], {
    cwd: repoRoot, input: token, stdio: ['pipe', 'inherit', 'inherit'], shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error('wrangler did not set the secret. Nothing changed in the vault; the Worker keeps its old token.');
  config.token = token;
  saveVault(config);
  console.log('Saved the same token in the vault. Checking that the app accepts it…');
  // A new secret takes a few seconds to reach every Cloudflare location.
  for (let attempt = 1; ; attempt++) {
    const c = await checkToken(config);
    if (c.ok || attempt === 6) {
      console.log(`${c.ok ? '✓' : '✗'} ${c.message}`);
      if (!c.ok) process.exitCode = 1;
      return;
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
}

function windowsOnly(name) {
  if (process.platform === 'linux') throw new Error(`\`${name}\` is for the Windows PC. On the Linux box: ${LINUX_INSTEAD[name]}.`);
}

async function remember() {
  windowsOnly('remember');
  if (process.platform !== 'win32') throw new Error('`remember` uses Windows DPAPI and only works on Windows.');
  const config = await openVault(); // proves the passphrase before storing anything
  const blob = await protectKey(passphrase);
  if ((await unprotectKey(blob)) !== passphrase) throw new Error('Windows could not round-trip the key; nothing saved.');
  mkdirSync(dirname(KEYFILE), { recursive: true });
  writeFileSync(KEYFILE, blob, { mode: 0o600 });
  console.log(`Saved. This Windows account can now open the vault unattended (${Object.keys(config.logins).length} login(s)).\n` +
    'Anyone who can log in as you on this PC can too. Undo with: node scrape.mjs forget');
}

function forget() {
  windowsOnly('forget');
  if (existsSync(KEYFILE)) unlinkSync(KEYFILE);
  console.log('Forgotten. The vault needs the passphrase again; --auto runs will fail until `remember`.');
}

function schedule() {
  windowsOnly('schedule');
  if (process.platform !== 'win32') throw new Error('`schedule` creates a Windows scheduled task. On other systems use cron with: run --auto');
  if (!existsSync(KEYFILE)) throw new Error('Run `node scrape.mjs remember` first, or the task cannot open the vault.');
  const cmdPath = join(dirname(VAULT), 'scrape-auto.cmd');
  writeFileSync(cmdPath, autoCmd({
    nodePath: process.execPath, scriptPath: fileURLToPath(import.meta.url), vaultPath: VAULT, logPath: join(dirname(VAULT), 'auto.log'),
  }));
  const argv = schtasksCreateArgs(cmdPath, opt('day', 'SUN'), opt('time', '09:00'));
  const r = spawnSync('schtasks', argv, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`schtasks failed: ${(r.stderr || r.stdout || '').trim()}`);
  console.log(`Scheduled "${TASK_NAME}" weekly (${argv[7]} ${argv[9]}). It runs only while you are logged in and the PC is on.\n` +
    `Its output goes to ${join(dirname(VAULT), 'auto.log')}. Remove with: node scrape.mjs unschedule`);
}

/** remember → prove an unattended run can open the vault and reach the app → schedule →
 *  confirm Windows has the task. Stops at the first step that fails, saying why. */
async function automate() {
  windowsOnly('automate');
  if (process.platform !== 'win32') throw new Error('`automate` sets up Windows (DPAPI + Task Scheduler); run it on the household PC.');
  console.log('Step 1/3: let Windows unlock the vault for this Windows account.');
  await remember();

  console.log('\nStep 2/3: an unattended run — a separate process, no keyboard — opens the vault and checks the app…');
  const c = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'check', '--auto', '--vault', VAULT], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  if (c.status !== 0) {
    throw new Error(`The unattended check failed, so no task was created:\n${`${c.stdout ?? ''}${c.stderr ?? ''}`.trim()}`);
  }
  console.log(c.stdout.trim());

  console.log('\nStep 3/3: the weekly task.');
  schedule();
  const q = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME], { encoding: 'utf8', windowsHide: true });
  if (q.status !== 0) throw new Error(`Windows does not show the task "${TASK_NAME}" after creating it: ${(q.stderr || q.stdout || '').trim()}`);
  console.log(`✓ Windows has the task "${TASK_NAME}" (Task Scheduler → Task Scheduler Library).`);
  await listen();
  const q2 = spawnSync('schtasks', ['/Query', '/TN', POLL_TASK_NAME], { encoding: 'utf8', windowsHide: true });
  if (q2.status !== 0) throw new Error(`Windows does not show the task "${POLL_TASK_NAME}" after creating it: ${(q2.stderr || q2.stdout || '').trim()}`);
  console.log(`✓ Windows has the task "${POLL_TASK_NAME}": it restarts the listener if it ever stops.`);
  console.log('\nDone. Each week it scrapes, and the bot posts what it found with ✅ Save / ❌ Discard (also on the dashboard).\n' +
    'Try it now without waiting: schtasks /Run /TN ' + TASK_NAME + '   (then look in the group within a few minutes)');
}

/** Every 15 minutes, hidden: starts the listener if it is not running. */
function schedulePoll() {
  const dir = dirname(VAULT);
  const cmdPath = join(dir, 'scrape-poll.cmd');
  const vbsPath = join(dir, 'scrape-poll.vbs');
  writeFileSync(cmdPath, pollCmd({
    nodePath: process.execPath, scriptPath: fileURLToPath(import.meta.url), vaultPath: VAULT, logPath: POLL_LOG,
  }));
  writeFileSync(vbsPath, hiddenLauncherVbs(cmdPath));
  const r = spawnSync('schtasks', schtasksPollArgs(vbsPath), { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`schtasks failed for ${POLL_TASK_NAME}: ${(r.stderr || r.stdout || '').trim()}`);
  return cmdPath;
}

/** The listener at logon (Startup folder), now, and proof that it reaches the app:
 *  after this, 🏦 / /scrape starts a scrape within seconds. Writes nothing in the app. */
async function listen() {
  windowsOnly('listen');
  if (process.platform !== 'win32') throw new Error('`listen` sets up Windows (Startup folder + Task Scheduler); run it on the household PC.');
  if (!existsSync(KEYFILE)) throw new Error('The listener runs unattended, so Windows must unlock the vault first: node scrape.mjs automate');
  const cmdPath = schedulePoll();
  const launcher = join(startupFolder(process.env.APPDATA), STARTUP_LAUNCHER);
  writeFileSync(launcher, hiddenLauncherVbs(cmdPath));
  console.log(`✓ Starts at logon: ${launcher}`);
  try { unlinkSync(LISTEN_STOP); } catch { /* none */ }
  const q = quietWindow();
  if (q) return console.log(`It is ${describeQuiet(q)}: the listener starts listening right after it.`);
  const already = readJson(LISTEN_LOCK);
  if (!listenerAlive(already, { ownPid: process.pid, pidAlive })) {
    const r = spawnSync('schtasks', ['/Run', '/TN', POLL_TASK_NAME], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`Could not start the listener: ${(r.stderr || r.stdout || '').trim()}`);
  }
  for (let i = 0; i < 40; i++) {
    const l = readJson(LISTEN_LOCK);
    if (l?.connectedAt && listenerAlive(l, { ownPid: process.pid, pidAlive })) {
      return console.log('✓ Your PC is listening: 🏦 Scrape banks now (or /scrape) starts a scrape within seconds,\n' +
        '  and one asked for while the PC was off starts as soon as you log in.');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`The listener did not reach the app within 40 seconds. What it printed is in ${POLL_LOG} (the last lines say why).`);
}

function unschedule() {
  windowsOnly('unschedule');
  for (const name of [TASK_NAME, POLL_TASK_NAME]) {
    const r = spawnSync('schtasks', ['/Delete', '/F', '/TN', name], { encoding: 'utf8', windowsHide: true });
    console.log(r.status === 0 ? `Unscheduled ${name}.` : `${name}: ${(r.stderr || r.stdout || '').trim()}`);
  }
  if (process.env.APPDATA) {
    try { unlinkSync(join(startupFolder(process.env.APPDATA), STARTUP_LAUNCHER)); console.log('Removed the listener from Startup.'); } catch { /* none */ }
  }
  writeFileSync(LISTEN_STOP, new Date().toISOString()); // a running listener stops within ~20 s
}

// --- a family's own computer: setup, uninstall, diagnostics -------------------------
// (computer.mjs builds what Windows and the Mac are given; diagnostics.mjs the report.)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (line) => console.log(`  ✓ ${line}`);
const isMac = () => process.platform === 'darwin';
const isWindows = () => process.platform === 'win32';
const uid = () => process.getuid?.() ?? 0;
const vaultDir = () => dirname(VAULT);
const SCRIPT = fileURLToPath(import.meta.url);
const plistPath = (label) => join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const agentVersion = () => readJson(join(dirname(SCRIPT), 'package.json'))?.version ?? '?';

/** The bank library's version and the local patches in it, or { version: null } when it is not installed. */
function libraryInfo() {
  let dir;
  try {
    dir = dirname(createRequire(import.meta.url).resolve('israeli-bank-scrapers/package.json'));
  } catch {
    return { version: null, patches: [] };
  }
  const patches = PATCHES.filter((p) => { try { return readFileSync(join(dir, p.file), 'utf8').includes(p.patched); } catch { return false; } });
  return { version: readJson(join(dir, 'package.json'))?.version ?? null, patches: patches.map((p) => p.id) };
}

function computerOnly(name) {
  if (sealed() || process.platform === 'linux') throw new Error(`\`${name}\` is for a family's Windows or Mac computer. On the Linux box: ${LINUX_INSTEAD[name]}.`);
  if (!isMac() && !isWindows()) throw new Error(`\`${name}\` is for Windows and Mac (this is ${process.platform}).`);
}

/** Does this address answer as the app does? A GET of the pairing address: the app says 405 method_not_allowed.
 *  Writes nothing. */
async function appAnswers(endpoint) {
  const url = `${endpoint}/api/scrape/pair`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new Error(describeFetchError(err, url));
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 405 && body.error === 'method_not_allowed') return;
  throw new Error(`${endpoint} answered, but not as your app does (HTTP ${res.status}). Check the address: it is the one your dashboard opens at. Nothing was changed.`);
}

/** The check before anything changes: a throwaway key into this computer's store and back. */
async function keyStoreWorks() {
  const probe = randomBytes(32).toString('base64url');
  if (isMac()) {
    keychainSave(probe, `${VAULT}#check`, runProgram);
    keychainRemove(`${VAULT}#check`, runProgram);
    return;
  }
  if ((await unprotectKey(await protectKey(probe))) !== probe) throw new Error('Windows (DPAPI) did not give a test value back unchanged. Nothing was changed.');
}

/** Keep `key` where this computer opens it without anyone typing, proven to come back unchanged first. */
async function storeKey(key) {
  if (isMac()) {
    keychainSave(key, VAULT, runProgram);
    return 'keychain';
  }
  const blob = await protectKey(key);
  if ((await unprotectKey(blob)) !== key) throw new Error('Windows could not give the key back unchanged; nothing was kept.');
  mkdirSync(vaultDir(), { recursive: true });
  writeFileSync(KEYFILE, blob, { mode: 0o600 });
  return 'dpapi';
}

const WIN_FILES = ['roshemet-daily.cmd', 'roshemet-daily.vbs', 'roshemet-listen.cmd', 'roshemet-listen.vbs'];

/** Windows: the daily task (through a hidden launcher), the listener at logon (Startup folder) and its 15-minute
 *  watchdog task; the first PC's task names removed, so one daily run and one listener remain. */
function scheduleWindows(at) {
  const dir = vaultDir();
  const [dCmd, dVbs, lCmd, lVbs] = WIN_FILES.map((f) => join(dir, f));
  writeFileSync(dCmd, dailyCmd({ nodePath: process.execPath, scriptPath: SCRIPT, vaultPath: VAULT, logPath: join(dir, 'auto.log') }));
  writeFileSync(dVbs, hiddenLauncherVbs(dCmd));
  writeFileSync(lCmd, pollCmd({ nodePath: process.execPath, scriptPath: SCRIPT, vaultPath: VAULT, logPath: POLL_LOG }));
  writeFileSync(lVbs, hiddenLauncherVbs(lCmd));
  for (const [what, argv] of [['the daily task', schtasksDailyArgs(dVbs, at)], ['the listener\'s task', schtasksPollArgs(lVbs, 15, AGENT.listenTask)]]) {
    const r = runProgram('schtasks', argv);
    if (r.status !== 0) throw new Error(`Windows did not create ${what}: ${(r.stderr || r.stdout).trim()}`);
  }
  writeFileSync(join(startupFolder(process.env.APPDATA), AGENT.startupLauncher), hiddenLauncherVbs(lCmd));
  for (const name of [TASK_NAME, POLL_TASK_NAME]) {
    if (runProgram('schtasks', ['/Delete', '/F', '/TN', name]).status === 0) ok(`Removed the older task ${name}.`);
  }
  try { unlinkSync(join(startupFolder(process.env.APPDATA), STARTUP_LAUNCHER)); ok('Removed the older listener from Startup.'); } catch { /* none */ }
  for (const name of [AGENT.dailyTask, AGENT.listenTask]) {
    const q = runProgram('schtasks', schtasksQueryArgs(name));
    if (q.status !== 0) throw new Error(`Windows does not show the task "${name}" after creating it: ${(q.stderr || q.stdout).trim()}`);
  }
}

/** Mac: two LaunchAgents, loaded now; the listener starts at once (RunAtLoad) and at every login. An older copy is
 *  unloaded first, and its listener given time to end: a new one that found it still running would step aside, and
 *  launchd does not start again a listener that stepped aside. */
async function scheduleMac(at) {
  const files = { node: process.execPath, script: SCRIPT, vault: VAULT };
  mkdirSync(dirname(plistPath(AGENT.dailyLabel)), { recursive: true });
  writeFileSync(plistPath(AGENT.dailyLabel), dailyPlist({ ...files, logPath: join(vaultDir(), 'auto.log') }, at));
  writeFileSync(plistPath(AGENT.listenLabel), listenPlist({ ...files, logPath: POLL_LOG }));
  const old = readJson(LISTEN_LOCK)?.pid;
  for (const label of [AGENT.dailyLabel, AGENT.listenLabel]) runProgram('launchctl', launchctlArgs.bootout(uid(), label));
  for (let i = 0; i < 100 && old && old !== process.pid && pidAlive(old); i++) await sleep(100);
  for (const label of [AGENT.dailyLabel, AGENT.listenLabel]) {
    let r;
    for (let attempt = 0; attempt < 5; attempt++) { // the old copy may take a moment to go
      r = runProgram('launchctl', launchctlArgs.bootstrap(uid(), plistPath(label)));
      if (r.status === 0) break;
      await sleep(1000);
    }
    if (r.status !== 0) throw new Error(`macOS did not load ${label}: ${(r.stderr || r.stdout).trim()}`);
    if (runProgram('launchctl', launchctlArgs.print(uid(), label)).status !== 0) throw new Error(`macOS does not show ${label} after loading it.`);
  }
}

/** Until the listener has reached the app (its lock says when), at most `seconds`. */
async function waitListening(seconds) {
  for (let i = 0; i < seconds; i++) {
    const l = readJson(LISTEN_LOCK);
    if (l?.connectedAt && listenerAlive(l, { ownPid: process.pid, pidAlive })) return true;
    await sleep(1000);
  }
  return false;
}

/** A family's own computer, from nothing to listening (SINGLE_FAMILY_PLAN S4). Checks first and changes nothing
 *  until they pass; run again any time: it keeps what works (the key, the vault, the pairing) and redoes the rest. */
async function setup() {
  computerOnly('setup');
  const at = opt('time', readState().dailyAt ?? AGENT.dailyAt);
  console.log('Checking this computer first (nothing is changed yet)…');
  if (nodeTooOld(process.version)) throw new Error(`Node ${process.version} is too old: install Node 22.22.2 or newer from nodejs.org, then run setup again.`);
  if (!libraryInfo().version) throw new Error(`The bank library is not installed here. In ${dirname(SCRIPT)} run: npm ci   (then setup again)`);
  ok(`Node ${process.version} and the bank library are here.`);
  let config = null;
  const existed = existsSync(VAULT);
  if (existed) {
    if (!vaultMeta(readFileSync(VAULT, 'utf8')).key) {
      console.log('  This vault opens with a passphrase. Setup moves it to a key this computer keeps, so nobody types it again.');
    }
    config = await openVault();
  }
  const endpoint = cleanEndpoint(opt('endpoint', '') || config?.endpoint || readState().endpoint ||
    await ask('Your app\'s address, as your dashboard opens it (https://…): '));
  if (!endpoint) throw new Error('That is not an app address (https://…). Nothing was changed.');
  await appAnswers(endpoint);
  ok(`${endpoint} answers as your app does.`);
  await keyStoreWorks();
  ok(isMac() ? 'The Keychain keeps a key and gives it back.' : 'Windows (DPAPI) keeps a key and gives it back.');

  console.log('\nStep 1/3: the vault, with a key this computer keeps');
  if (!config || !keyStore) {
    const key = randomBytes(32).toString('base64url');
    const store = await storeKey(key);
    config ??= emptyConfig();
    config.endpoint = endpoint;
    passphrase = key;
    keyStore = store;
    saveVault(config);
    ok(`${existed ? 'Moved the vault to' : 'Made the vault with'} a random key that ${isMac() ? 'the Keychain keeps for this Mac user' : 'Windows keeps for this Windows account'}: ${VAULT}`);
  } else {
    if (config.endpoint !== endpoint) {
      config.endpoint = endpoint;
      saveVault(config);
    }
    ok(`The vault opens with the key ${isMac() ? 'the Keychain' : 'Windows'} keeps: ${VAULT}`);
  }
  writeState({ endpoint, home: isMac() ? 'mac' : 'windows' });

  console.log('\nStep 2/3: pairing with your app');
  if (!config.token || opt('code', '')) {
    const c = await pairWith(config);
    if (!c.ok) throw new Error(`${c.message}\nSetup stopped here; run it again.`);
    ok(c.message);
  } else {
    const c = await checkToken(config);
    if (!c.ok) throw new Error(`${c.message}\nTo pair again: on the dashboard, Upload tab → Bank scrape → "Pair a scraper box", then run setup with --code <the code>.`);
    ok(`Already paired: ${c.message}`);
  }

  console.log('\nStep 3/3: the daily run and the 🏦 listener');
  if (isMac()) await scheduleMac(at); else scheduleWindows(at);
  writeState({ dailyAt: at });
  ok(`The daily run: every day at ${at}${isWindows() ? ' while this computer is on' : ' (later, if the Mac was asleep)'}, never on Shabbat or Yom Tov.`);
  const q = quietWindow();
  if (q) {
    ok(`It is ${describeQuiet(q)}: the listener starts listening right after it.`);
  } else {
    if (isWindows() && !listenerAlive(readJson(LISTEN_LOCK), { ownPid: process.pid, pidAlive })) runProgram('schtasks', ['/Run', '/TN', AGENT.listenTask]);
    if (!(await waitListening(40))) {
      throw new Error(`The listener did not reach your app within 40 seconds. What it printed is in ${POLL_LOG} (the last lines say why).`);
    }
    ok('The listener reached your app: 🏦 in the app or the bot starts a scrape within seconds.');
  }
  const logins = Object.keys(config.logins ?? {});
  console.log(`\n✓ Setup done.${logins.length ? ` Logins: ${logins.join(', ')}.` : ''}`);
  if (!logins.length) {
    console.log(`Next:
  1. Each bank's and card company's login (what you type is not shown):
       ${commandFor('add-login <company>', false)}      (the companies: ${commandFor('companies', false)})
  2. A first run, for your approval in the app:  ${commandFor('run --review --days 90', false)}
     It names each account it finds; give each its place in the app: ${commandFor('map <company> <last4> <slot>', false)}`);
  }
}

/** Stop and remove the daily run and the listener. --forget-key: also the key (this vault can no longer be
 *  opened). --delete-vault: also the vault and everything the agent kept beside it. */
async function uninstall() {
  computerOnly('uninstall');
  const deleting = flag('delete-vault');
  const scrape = readJson(SCRAPE_LOCK);
  if (deleting && listenerAlive(scrape, { ownPid: process.pid, pidAlive })) {
    throw new Error('A scrape is running right now. Run this again when it has finished (a few minutes). Nothing was changed.');
  }
  if (isMac()) {
    for (const label of [AGENT.dailyLabel, AGENT.listenLabel]) {
      runProgram('launchctl', launchctlArgs.bootout(uid(), label));
      try { unlinkSync(plistPath(label)); } catch { /* none */ }
    }
    ok('The daily run and the listener are stopped and removed (launchd).');
  } else {
    for (const name of [AGENT.dailyTask, AGENT.listenTask, TASK_NAME, POLL_TASK_NAME]) {
      if (runProgram('schtasks', ['/Delete', '/F', '/TN', name]).status === 0) ok(`Removed the task ${name}.`);
    }
    for (const f of [AGENT.startupLauncher, STARTUP_LAUNCHER]) {
      try { unlinkSync(join(startupFolder(process.env.APPDATA), f)); ok(`Removed ${f} from Startup.`); } catch { /* none */ }
    }
  }
  // A listener still running holds the logins in memory: stop it now, not at its next look at the stop file.
  const l = readJson(LISTEN_LOCK);
  if (listenerAlive(l, { ownPid: process.pid, pidAlive })) {
    try { process.kill(l.pid); ok('Stopped the listener that was running.'); } catch { /* gone */ }
  }
  mkdirSync(vaultDir(), { recursive: true });
  writeFileSync(LISTEN_STOP, new Date().toISOString()); // and any other copy stops within ~20 s
  if (flag('forget-key') || deleting) {
    if (isMac()) keychainRemove(VAULT, runProgram); else { try { unlinkSync(KEYFILE); } catch { /* none */ } }
    ok('The vault\'s key is removed: this vault can no longer be opened.');
  }
  if (deleting) {
    const files = [VAULT, `${VAULT}.tmp`, STATE, LOG, join(vaultDir(), 'auto.log'), POLL_LOG, LISTEN_LOCK, SCRAPE_LOCK, ...WIN_FILES.map((f) => join(vaultDir(), f))];
    for (const f of files) { try { unlinkSync(f); } catch { /* none */ } }
    ok(`Deleted the vault and what the agent kept beside it in ${vaultDir()}.`);
  }
}

/** What support needs, and nothing that is the family's (diagnostics.mjs). Opens no vault. */
function diagnostics() {
  const lib = libraryInfo();
  // A computer or box with its own vault is that, wherever it runs; GitHub is the agent with no vault (its logins
  // come from the repo's secrets).
  const home = (sealed() || VAULT.startsWith(BOX.stateDir)) ? 'box'
    : (process.env.GITHUB_ACTIONS === 'true' && !existsSync(VAULT)) ? 'github'
      : ({ win32: 'windows', darwin: 'mac' }[process.platform] ?? 'linux');
  const text = existsSync(VAULT) ? readFileSync(VAULT, 'utf8') : null;
  const store = text === null ? null : home === 'box' ? 'tpm' : vaultMeta(text).key ?? (existsSync(KEYFILE) ? 'remembered' : 'passphrase');
  const schedule = [];
  const state = readState();
  if (home === 'windows') {
    for (const [what, name] of [['Daily run', AGENT.dailyTask], ['Listener\'s restarts', AGENT.listenTask]]) {
      const r = runProgram('schtasks', schtasksQueryArgs(name));
      const st = r.status === 0 ? schtasksState(r.stdout) : null;
      schedule.push(`${what} (Task Scheduler): ${st ? `${st.status ?? '?'}${st.next ? `, next ${st.next}` : ''}` : 'not set up'}`);
    }
    let atLogon = false;
    try { atLogon = existsSync(join(startupFolder(process.env.APPDATA), AGENT.startupLauncher)); } catch { /* no APPDATA */ }
    schedule.push(`Listener at logon (Startup folder): ${atLogon ? 'yes' : 'no'}`);
  } else if (home === 'mac') {
    const st = (label) => {
      const r = runProgram('launchctl', launchctlArgs.print(uid(), label));
      return r.status === 0 ? `loaded${launchdState(r.stdout) ? `, ${launchdState(r.stdout)}` : ''}` : 'not loaded';
    };
    schedule.push(`Daily run (launchd): ${st(AGENT.dailyLabel)}${state.dailyAt ? `, every day at ${state.dailyAt}` : ''}`);
    schedule.push(`Listener (launchd): ${st(AGENT.listenLabel)}`);
  } else if (home === 'box') {
    for (const [what, unit] of [['Daily run', BOX.dailyTimer], ['Listener', BOX.listenUnit]]) {
      schedule.push(`${what} (systemd): ${runProgram('systemctl', ['is-active', unit]).stdout.trim() || '?'}`);
    }
  }
  const lock = readJson(LISTEN_LOCK);
  const q = quietWindow();
  const log = readLog();
  const osName = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] ?? process.platform;
  process.stdout.write(diagnosticsReport({
    now: new Date(),
    versions: { agent: agentVersion(), library: lib.version, patches: lib.patches, node: process.version, os: `${osName} ${release()} ${arch()}`, browser: home === 'box' ? browserVersion() : null },
    home,
    vault: { exists: text !== null, keyStore: store },
    state: { pairedAt: state.pairedAt ?? null },
    schedule,
    listener: lock ? { alive: listenerAlive(lock, { ownPid: process.pid, pidAlive }), connectedAt: lock.connectedAt ?? null, at: lock.at ?? null } : { alive: false },
    quiet: q ? describeQuiet(q) : 'an ordinary day: everything runs',
    log,
    warnings: healthWarnings(log, new Date().toISOString().slice(0, 10)),
  }));
}

// --- GitHub: the family's own private repo runs the agent (github.mjs) ------------------

/** 'private', 'public' or null: GitHub's API with the run's own read-only token, or else what the event says. */
async function githubVisibility(token) {
  let api = null;
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo && token) {
    try {
      const res = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repo}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) api = await res.json();
    } catch { /* the event may say */ }
  }
  return repoVisibility({ api, event: process.env.GITHUB_EVENT_PATH ? readJson(process.env.GITHUB_EVENT_PATH) : null });
}

/** agent.yml's step. The logins come from the repo's secrets (never a vault or a prompt) and are hidden from the
 *  run's log before anything else is printed; the rows go to the app for approval, as every unattended run's do. */
async function githubRun() {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('github-run is for GitHub Actions (agent.yml in your repo): it reads the logins from the repo\'s secrets. ' +
      'On a computer or box: run --review.');
  }
  const given = githubEnv(process.env);
  for (const line of maskLines(given)) console.log(line);
  // Out of the environment before anything starts: the browser and every other program inherit it.
  const ghToken = process.env.GITHUB_TOKEN ?? '';
  for (const name of [...given.names, 'GITHUB_TOKEN']) delete process.env[name];
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  const summary = (text) => { if (summaryFile) appendFileSync(summaryFile, text); };
  try {
    const days = runDays(opt('days', ''));
    if (days === null) throw new Error('Days must be a whole number from 0 to 365 (0 checks everything without signing in to a bank).');
    const quiet = quietWindow();
    if (quiet && days > 0) {
      const line = `Not running: ${describeQuiet(quiet)}. The next run after it catches up.`;
      console.log(line);
      summary(runSummary({ outcome: line }));
      return;
    }
    const visibility = await githubVisibility(ghToken);
    if (visibility === 'public') throw new Error(PUBLIC_REPO);
    const { SCRAPERS } = await lib();
    const { config, problems } = readGithubSettings(given, SCRAPERS);
    if (days === 0) return await githubCheck(config, problems, visibility, summary);
    if (problems.length) throw new Error(`This repo's settings need fixing first (no bank was signed in to):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    if (!Object.keys(config.logins).length) {
      throw new Error('No bank login in this repo\'s secrets yet. On the computer or box that keeps your logins, run github-connect.');
    }
    if (visibility === null) console.log('⚠ GitHub did not say whether this repo is private (the agent goes on).');
    let r;
    try {
      r = await run(config);
    } finally {
      trimScrapeLog();
    }
    if (!r) return; // another run held the lock (it says so above)
    const failed = r.entries.length > 0 && !r.entries.some((e) => e.ok);
    summary(runSummary({ entries: r.entries, notes: r.notes, outcome: failed ? `✗ No login got through. ${r.outcome}` : r.outcome }));
    if (failed) {
      console.log('\n✗ No login got through (the table on the run\'s page says why for each). The app was told.');
      process.exitCode = 1;
    }
  } catch (err) {
    summary(runSummary({ outcome: `✗ ${String(err?.message ?? err).split('\n')[0]}` }));
    throw err;
  }
}

/** --days 0: everything a run needs, without signing in to a bank or writing anything. */
async function githubCheck(config, problems, visibility, summary) {
  const checks = [{
    ok: visibility === 'private',
    line: visibility === 'private' ? 'The repo is private.' : 'GitHub did not say whether this repo is private (agent.yml gives the step GITHUB_TOKEN for that).',
  }];
  for (const p of problems) checks.push({ ok: false, line: p });
  const logins = Object.keys(config.logins);
  checks.push({ ok: logins.length > 0, line: logins.length ? `Logins: ${logins.join(', ')}.` : 'No bank login in this repo\'s secrets yet (github-connect sets them).' });
  const mapped = Object.keys(config.map).length;
  checks.push({ ok: mapped > 0, line: mapped ? `Accounts mapped: ${mapped}.` : 'No account is mapped yet: a first run names each account, then map them and run github-connect again.' });
  if (config.endpoint && config.token && !tokenProblem(config.token)) {
    const c = await checkToken(config);
    checks.push({ ok: c.ok, line: `${config.endpoint}: ${c.message}` });
  }
  checks.push(await chromeStarts());
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.line}`);
  summary(checkSummary(checks));
  if (!checks.every((c) => c.ok)) process.exitCode = 1;
}

/** GitHub keeps the scrape log between runs (its cache): only its newest lines. */
function trimScrapeLog() {
  if (!existsSync(LOG)) return;
  writeFileSync(LOG, trimLog(readFileSync(LOG, 'utf8')));
}

/** One call to GitHub's API with the token typed for github-connect: { status, body, text }; status 0 when GitHub
 *  could not be reached. */
function githubApi(token) {
  return async (method, path, body) => {
    let res;
    try {
      res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
          'user-agent': 'roshemet-agent', ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      return { status: 0, body: { message: describeFetchError(err, `https://api.github.com${path}`).split('\n').slice(1).join(' ').trim() } };
    }
    const text = await res.text();
    let parsed = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* a log is text */ }
    return { status: res.status, body: parsed, text };
  };
}

/** GitHub's encryption for a secret (a libsodium sealed box with the repo's public key): only GitHub can open it. */
async function sealer() {
  const sodium = createRequire(import.meta.url)('libsodium-wrappers');
  await sodium.ready;
  const b64 = sodium.base64_variants.ORIGINAL;
  return (publicKey, value) => sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(publicKey, b64)), b64);
}

/** The repo's own pairing with the app (the dashboard's code): its token goes to the repo's secret, never to this
 *  vault, which keeps this machine's own. */
async function pairRepo(endpoint, repo) {
  const given = opt('code', '');
  if (!given) console.log('On the dashboard: Upload tab → Bank scrape → "Pair a scraper box". It shows a code like K7QM-3XPD.');
  const code = normalizePairCode(cleanSecretInput(given || await ask('The code: ')));
  if (!code) throw new Error('That is not a pairing code: 8 letters and digits, like K7QM-3XPD. Check it on the dashboard and run github-connect again.');
  const url = `${endpoint}/api/scrape/pair`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: `GitHub ${repo}`.slice(0, 40), kind: 'github', repo }),
    });
  } catch (err) {
    throw new Error(describeFetchError(err, url));
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new Error(pairRefusal(res.status, body));
  return body.token;
}

/** From this machine's vault into the family's own GitHub repo (githubConnect.mjs), checked on GitHub itself. */
async function githubConnect() {
  const repo = cleanRepo(opt('repo', '') || rest[0] || '');
  if (!repo) throw new Error(`Usage: ${commandFor('github-connect --repo <owner>/<name> --code <pairing code>', sealed())}   (your private repo made from the Roshemet template)`);
  const days = runDays(opt('days', ''));
  if (days === null) throw new Error('--days is the first run\'s days: a whole number from 0 (no first run) to 365.');
  const config = await openVault();
  if (!cleanEndpoint(config.endpoint)) throw new Error(`This vault has no app address. Run: ${commandFor('set-endpoint https://<your app>', sealed())}`);
  console.log(`Connecting ${repo} on GitHub. Checking first; nothing changes until the checks pass.`);
  await appAnswers(config.endpoint);
  ok(`${config.endpoint} answers as your app does.`);
  const { SCRAPERS } = await lib();
  console.log(`\n${tokenSteps(repo)}`);
  const token = cleanSecretInput(await askHidden('GitHub token: '));
  if (!token) throw new Error('No token was given. Nothing was changed.');
  try {
    await connectRepo({
      repo, config, companies: SCRAPERS, gh: githubApi(token), seal: await sealer(), pair: () => pairRepo(config.endpoint, repo),
      newPairing: Boolean(opt('code', '')), log: (line) => console.log(line), days,
    });
  } catch (err) {
    if (err instanceof GithubRefused) throw new Error(err.message);
    throw err;
  }
  console.log('\n✓ Done. GitHub runs the agent every day at 07:00 UTC (10:00 Israel time in summer, 09:00 in winter), never on ' +
    'Shabbat or Yom Tov; each run comes to your app for approval. The token you typed is not kept: you may delete it on GitHub.');
}

async function main() {
  switch (cmd) {
    case 'github-run': return githubRun();
    case 'github-connect': return githubConnect();
    case 'setup': return setup();
    case 'uninstall': return uninstall();
    case 'diagnostics': return diagnostics();
    case 'version': return console.log(`roshemet-agent ${agentVersion()} · israeli-bank-scrapers ${libraryInfo().version ?? 'not installed'} · Node ${process.version}`);
    case 'init': return init();
    case 'add-login': if (!rest[0]) throw new Error('Usage: add-login <company>'); return addLogin(rest[0]);
    case 'remove-login': if (!rest[0]) throw new Error('Usage: remove-login <company>'); return removeLogin(rest[0]);
    case 'import-logins': return importLoginsFrom(rest[0]);
    case 'map': if (rest.length !== 3) throw new Error('Usage: map <company> <last4> <slot>'); return map(rest[0], rest[1], rest[2]);
    case 'set-endpoint': {
      const ep = cleanEndpoint(rest[0]);
      if (!ep) throw new Error('Usage: set-endpoint https://<your app\'s address>');
      const c = await openVault(); c.endpoint = ep; saveVault(c); writeState({ endpoint: ep }); return console.log(`Endpoint: ${c.endpoint}`);
    }
    case 'check': return check();
    case 'set-token': {
      if (flag('generate')) return generateAndSetToken();
      const c = await openVault();
      const t = await askHidden('Scraper token (the SCRAPER_TOKEN secret): ');
      if (tokenProblem(t)) throw new Error(`${tokenProblem(t)} (nothing was saved)`);
      c.token = t; saveVault(c); return console.log(`Token saved (${t.length} characters).`);
    }
    case 'show': return show();
    case 'companies': return companies();
    case 'run': return run();
    case 'remember': return remember();
    case 'forget': return forget();
    case 'schedule': return schedule();
    case 'automate': return automate();
    case 'poll': return poll();
    case 'listen': return listen();
    case 'unschedule': return unschedule();
    case 'chrome-check': return chromeCheck();
    case 'pair': return pair();
    case 'filter-selftest': return filterSelftest(rest[0]);
    case 'endpoint': return console.log((await openVault()).endpoint); // the app's address (the box keeps it for its filter)
    default: {
      const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
      const end = lines.findIndex((l) => !l.startsWith('//'));
      console.log(lines.slice(0, end < 0 ? lines.length : end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      if (cmd) {
        console.error(`\n"${cmd}" is not a command this agent knows (version ${agentVersion()}). If you were just given it, update the agent first.`);
        process.exitCode = 1;
      }
    }
  }
}

main().catch((err) => {
  console.error(`\nError: ${err?.message ?? err}`);
  process.exitCode = 1;
});
