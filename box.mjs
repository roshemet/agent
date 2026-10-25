#!/usr/bin/env node
// `sudo finance-scraper <command>` on the Linux box (Debian 13). See linux.mjs for the
// design. Runs as root; the scraper itself always runs as the finance-scraper user,
// through systemd, with the vault key systemd unseals for it.
//
//   sudo finance-scraper setup [--new-key [--force]]   checks, the sealed key, Chromium, the vault, the services
//   sudo finance-scraper pair                          pair with the app (code from the dashboard)
//   sudo finance-scraper add-login <company> | map <company> <last4> <slot> | show | companies
//   sudo finance-scraper import-logins <file>         logins + account map from the PC's vault file, uploaded
//   sudo finance-scraper run [--days 100] [--review | --list | --csv rows.csv]
//   sudo finance-scraper check                         does the app accept this box? (writes nothing)
//   sudo finance-scraper diagnostics | version         what support needs (no login, account number or transaction)
//   sudo finance-scraper start | stop | status | update
//   sudo finance-scraper daily [on | off]               the box's daily run alone (🏦 stays on)
//   sudo finance-scraper github-connect --repo <owner>/<name> --code <code>
//                                                      the logins into the family's GitHub repo, checked there; then
//                                                      GitHub runs the daily run and the box's pauses (🏦 stays here)
//   sudo finance-scraper outbound [watch | enforce | off]  where the scraper may connect (outbound.mjs)

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync, copyFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  BOX, listenUnit, dailyUnit, dailyTimer, wrapperScript, runArgs, sealAndVerify, unsealCheckArgs, explainCredError,
  SYSCTL_CONF, hardenGuestAgent, swapWarning, missingTpmLibs, nodeTooOld,
} from './linux.mjs';
import { quietWindow, describeQuiet, cleanEndpoint } from './lib.mjs';
import { ensurePatched } from './patches.mjs';
import {
  OUTBOUND, allowList, allowFileText, readAllowFile, nameservers, nftRules, dnsmasqConf, dnsUnit, sniUnit, rulesUnit,
  readState, readLogs, formatReport, aptWithWaits,
} from './outbound.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : dflt;
};

/** spawnSync, always returning { status, stdout, stderr } (a missing program is status 127). */
function sh(program, args, { input, cwd, env, inherit } = {}) {
  const r = spawnSync(program, args, {
    input, cwd, encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    stdio: inherit ? 'inherit' : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  return { status: r.status ?? 127, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? r.error.message : ''}` };
}
const must = (what, r) => {
  if (r.status !== 0) throw new Error(`${what} failed:\n${(r.stderr || r.stdout).trim()}`);
  return r;
};
const ok = (line) => console.log(`  ✓ ${line}`);
const warn = (line) => console.log(`  ⚠ ${line}`);
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
/** The outbound filter's mode (off | watch | enforce): the scraper's units and every command
 *  typed here run with its settings while it is on. */
let filterMode = readState(readText(OUTBOUND.stateFile)).mode;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run scrape.mjs as the services do (see runArgs). Returns its exit status. */
function scraper(args, { tty = Boolean(process.stdin.isTTY && process.stdout.isTTY) } = {}) {
  return sh('systemd-run', runArgs(args, { tty, filtered: filterMode !== 'off' }), { inherit: true }).status;
}

/** The family's app address, for the outbound filter's list. Kept by root in BOX.appFile (setup and set-endpoint
 *  write it); a box set up before that file existed asks its own vault once, as the scraper, and keeps the answer. */
function appEndpoint() {
  const kept = cleanEndpoint(readJson(BOX.appFile)?.endpoint ?? '');
  if (kept) return kept;
  const r = sh('systemd-run', runArgs(['endpoint'], { tty: false, filtered: filterMode !== 'off' }));
  const asked = cleanEndpoint(r.status === 0 ? r.stdout.trim().split('\n').pop() : '');
  if (!asked) throw new Error('This box does not know your app\'s address. Run: sudo finance-scraper set-endpoint https://<your app>');
  keepAppEndpoint(asked);
  return asked;
}

function keepAppEndpoint(endpoint) {
  mkdirSync(dirname(BOX.appFile), { recursive: true, mode: 0o755 });
  writeFileSync(BOX.appFile, `${JSON.stringify({ endpoint })}\n`);
}

function requireRoot() {
  if (process.platform !== 'linux') throw new Error('finance-scraper is for the Linux box. On Windows use: node scrape.mjs');
  if (process.getuid?.() !== 0) throw new Error(`Run it with sudo: sudo finance-scraper ${cmd ?? ''}`.trim());
}

// --- setup -----------------------------------------------------------------

/** Fast checks that write nothing: everything setup will need, before it changes anything. */
function preflight() {
  console.log('Checking this machine first (nothing is changed yet)…');
  const problems = [];
  const here = dirname(fileURLToPath(import.meta.url));
  if (here !== BOX.scrapeDir) problems.push(`The code must be in ${BOX.repoDir} (it is in ${dirname(dirname(here))}). See scripts/scrape/README.md, "The scraper box", step 4.`);
  if (nodeTooOld(process.version)) problems.push(`Node ${process.version} is too old (22.22.2 or newer). Run the setup script: sudo bash ${BOX.scrapeDir}/linux/setup-debian.sh`);
  for (const program of ['systemd-run', 'systemd-creds', 'systemctl']) {
    if (sh(program, ['--version']).status !== 0) problems.push(`${program} is missing: this needs a systemd machine (Debian 13).`);
  }
  if (!existsSync('/dev/tpmrm0')) {
    problems.push('This machine has no TPM (no /dev/tpmrm0). On Google Cloud: stop the VM, turn on vTPM ' +
      '(gcloud compute instances update finance-scraper --zone=me-west1-a --shielded-vtpm) and start it. ' +
      'On a mini-PC: turn on the TPM ("PTT") in the BIOS.');
  }
  const missing = missingTpmLibs(sh('ldconfig', ['-p']).stdout);
  if (missing.length) problems.push(`TPM libraries missing (${missing.join(', ')}). Run the setup script: sudo bash ${BOX.scrapeDir}/linux/setup-debian.sh`);
  if (!existsSync(BOX.chromium)) problems.push(`Chromium is not installed (${BOX.chromium}). Run the setup script: sudo bash ${BOX.scrapeDir}/linux/setup-debian.sh`);
  // Chrome's sandbox needs unprivileged user namespaces (Debian allows them by default).
  if (sh('runuser', ['-u', 'nobody', '--', 'unshare', '--user', '--map-root-user', 'true']).status !== 0) {
    problems.push('An ordinary user cannot make a user namespace, which Chrome\'s sandbox needs. ' +
      'Check: sysctl kernel.unprivileged_userns_clone user.max_user_namespaces (both must be above 0).');
  }
  if (problems.length) throw new Error(`Not ready, nothing was changed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  ok('TPM, its libraries, Chromium, Node and user namespaces are all there.');
}

function ensureUser() {
  if (sh('id', ['-u', BOX.user]).status === 0) return ok(`The service user ${BOX.user} exists.`);
  must('useradd', sh('useradd', ['--system', '--user-group', '--home-dir', BOX.stateDir, '--no-create-home', '--shell', '/usr/sbin/nologin', BOX.user]));
  ok(`Created the service user ${BOX.user} (no login, no password).`);
}

/** npm ci as root (so the code stays read-only to the scraper), no install scripts and no
 *  browser download (the box uses Debian's Chromium); then the library patches. */
async function installCode() {
  must('npm ci', sh(BOX.npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: BOX.scrapeDir, env: { PATH: `${dirname(BOX.node)}:${process.env.PATH}`, PUPPETEER_SKIP_DOWNLOAD: '1' },
  }));
  const libDir = dirname(createRequire(join(BOX.scrapeDir, 'package.json')).resolve('israeli-bank-scrapers/package.json'));
  const notes = await ensurePatched(libDir);
  for (const n of notes) warn(n);
  ok('Installed the scraper\'s libraries (pinned versions, no install scripts) and its patches.');
}

function kernelSettings() {
  writeFileSync(BOX.sysctlFile, SYSCTL_CONF);
  const s = sh('sysctl', ['-q', '-p', BOX.sysctlFile]);
  if (s.status === 0) ok('Processes may only read the memory of their own children (Yama).');
  else warn(`Could not switch on Yama (${s.stderr.trim()}): Chrome could read the scraper's memory. Not fatal.`);
  const swap = swapWarning(existsSync('/proc/swaps') ? readFileSync('/proc/swaps', 'utf8') : '');
  if (swap) warn(swap); else ok('No swap: the scraper\'s memory is never written to disk.');
  const cfg = '/etc/default/instance_configs.cfg';
  const google = ['/usr/bin/google_guest_agent', '/usr/bin/google_metadata_script_runner', '/usr/bin/google_guest_agent_manager']
    .some((p) => existsSync(p)) || existsSync(cfg);
  if (google) {
    const before = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
    const after = hardenGuestAgent(before);
    if (after !== before) {
      if (before && !existsSync(`${cfg}.before-finance-scraper`)) copyFileSync(cfg, `${cfg}.before-finance-scraper`);
      writeFileSync(cfg, after);
      sh('systemctl', ['try-restart', 'google-guest-agent.service', 'google-guest-agent-manager.service']);
    }
    ok('Google\'s guest agent no longer runs root scripts from the VM\'s settings.');
  }
}

/** The vault key: made here, sealed to this machine's TPM, proven to come back unchanged
 *  through systemd before it is kept. Never shown, never written in the clear. */
function vaultKey() {
  mkdirSync(dirname(BOX.credFile), { recursive: true, mode: 0o700 });
  if (existsSync(BOX.credFile)) {
    const back = sh('systemd-run', unsealCheckArgs());
    const opens = back.status === 0 && back.stdout.length >= 32;
    if (!flag('new-key')) {
      if (opens) return ok('The vault key is sealed to this machine and opens.');
      throw new Error(explainCredError(back.stderr || back.stdout));
    }
    if (opens && !flag('force')) {
      throw new Error('The sealed key still opens, so there is nothing to fix. A new key means pairing again and typing ' +
        'every login again; add --force if that is really what you want.');
    }
  }
  const key = randomBytes(32).toString('base64url');
  const fresh = `${BOX.credFile}.new`;
  sealAndVerify(key, {
    credFile: fresh,
    run: (program, args, o) => sh(program === 'systemd-creds' ? '/usr/bin/systemd-creds' : program, args, o),
    removeFile: (p) => { try { unlinkSync(p); } catch { /* gone */ } },
  });
  if (existsSync(BOX.vault)) {
    const aside = `${BOX.vault}.old-key-${new Date().toISOString().slice(0, 10)}`;
    renameSync(BOX.vault, aside); // a new key cannot open it; kept aside, still encrypted
    warn(`The old vault cannot be opened with a new key: moved aside to ${aside}. Pair again and add the logins again.`);
  }
  renameSync(fresh, BOX.credFile);
  ok('Made a new vault key and sealed it to this machine\'s TPM (a copy of the disk cannot open it).');
}

function systemFiles() {
  writeFileSync(join(BOX.unitDir, BOX.listenUnit), listenUnit(BOX, filterMode));
  writeFileSync(join(BOX.unitDir, BOX.dailyUnit), dailyUnit(BOX, filterMode));
  writeFileSync(join(BOX.unitDir, BOX.dailyTimer), dailyTimer());
  writeFileSync(BOX.wrapper, wrapperScript());
  chmodSync(BOX.wrapper, 0o755);
  must('systemctl daemon-reload', sh('systemctl', ['daemon-reload']));
  const v = sh('systemd-analyze', ['verify', ...[BOX.listenUnit, BOX.dailyUnit, BOX.dailyTimer].map((u) => join(BOX.unitDir, u))]);
  if (v.status !== 0) throw new Error(`systemd does not accept the service files:\n${(v.stderr || v.stdout).trim()}`);
  ok(`Services written and checked by systemd: ${BOX.listenUnit}, ${BOX.dailyTimer} (not started yet).`);
}

async function setup() {
  requireRoot();
  preflight();
  console.log('\nStep 1/5: the service user and the code');
  ensureUser();
  await installCode();
  console.log('\nStep 2/5: kernel and Google agent settings');
  kernelSettings();
  console.log('\nStep 3/5: the vault key, sealed to this machine');
  vaultKey();
  console.log('\nStep 4/5: Chromium, started exactly as the scraper will start it');
  if (scraper(['chrome-check'], { tty: false }) !== 0) {
    throw new Error('Chromium did not start inside the scraper\'s service settings (what it said is above). ' +
      'Nothing is running yet; send that output to whoever maintains the scraper.');
  }
  console.log('\nStep 5/5: the vault and the services');
  if (!existsSync(BOX.vault)) {
    const endpoint = cleanEndpoint(opt('endpoint', '')) ?? cleanEndpoint(readJson(BOX.appFile)?.endpoint ?? '');
    if (!endpoint) throw new Error('Give your app\'s address, as your dashboard opens it: sudo finance-scraper setup --endpoint https://…');
    if (scraper(['init', '--sealed', '--endpoint', endpoint], { tty: false }) !== 0) {
      throw new Error('Could not create the vault (see above).');
    }
    keepAppEndpoint(endpoint);
  } else {
    ok(`The vault is there: ${BOX.vault}`);
  }
  systemFiles();
  console.log(`
✓ Setup done. Next, one at a time (README "The scraper box" has the details):
  1. Pair the box with the app. On the dashboard: Upload tab → Bank scrape → "Pair a scraper box". Then here:
       sudo finance-scraper pair
  2. Your logins, one company at a time (it asks for each field; nothing you type is shown):
       sudo finance-scraper add-login <company>      (the companies: sudo finance-scraper companies)
  3. The account map: the first run names each account without a slot and the command for it, like
       sudo finance-scraper map isracard 1234 card1
  4. The first run, for your approval:  sudo finance-scraper run --days 100 --review
     Check every row on the dashboard ("Show all"), press Save, and only then:
  5. sudo finance-scraper start`);
}

// --- start / stop / status / update ----------------------------------------

async function start() {
  requireRoot();
  if (!existsSync(join(BOX.unitDir, BOX.listenUnit))) throw new Error('Not set up yet. Run: sudo finance-scraper setup');
  console.log('Checking the app accepts this box (writes nothing)…');
  if (scraper(['check'], { tty: false }) !== 0) throw new Error('Not started: fix what the check said above, then run start again.');
  must('systemctl enable', sh('systemctl', ['enable', '--now', BOX.listenUnit, BOX.dailyTimer]));
  ok(`The daily run is scheduled for ${BOX.dailyAt} Israel time (never on Shabbat or Yom Tov).`);
  const q = quietWindow();
  if (q) return ok(`The listener is running; it is ${describeQuiet(q)}, so it starts listening right after that.`);
  const lockFile = join(BOX.stateDir, 'listen.lock');
  for (let i = 0; i < 60; i++) {
    if (readJson(lockFile)?.connectedAt) {
      return ok('The box is listening: 🏦 Scrape banks now (or /scrape) in the group starts a scrape within seconds.');
    }
    await sleep(1000);
  }
  throw new Error(`The listener did not reach the app within a minute. Its last lines: sudo journalctl -u ${BOX.listenUnit} -n 20`);
}

function stop() {
  requireRoot();
  must('systemctl disable', sh('systemctl', ['disable', '--now', BOX.listenUnit, BOX.dailyTimer]));
  ok('Stopped: no listener, no daily run. Start again with: sudo finance-scraper start');
}

function status() {
  requireRoot();
  const unit = (u) => `${sh('systemctl', ['is-active', u]).stdout.trim() || '?'}, ${sh('systemctl', ['is-enabled', u]).stdout.trim() || '?'}`;
  console.log(`Listener (${BOX.listenUnit}): ${unit(BOX.listenUnit)}`);
  console.log(`Daily run (${BOX.dailyTimer}): ${unit(BOX.dailyTimer)}`);
  const next = sh('systemctl', ['show', BOX.dailyTimer, '-p', 'NextElapseUSecRealtime', '--value']).stdout.trim();
  if (next) console.log(`Next daily run: ${next}`);
  const q = quietWindow();
  if (q) console.log(`Now: ${describeQuiet(q)}: nothing runs until then.`);
  const back = sh('systemd-run', unsealCheckArgs());
  console.log(back.status === 0 && back.stdout.length >= 32 ? 'Vault key: sealed to this machine, opens.' : `Vault key: ${explainCredError(back.stderr || back.stdout)}`);
  const chrome = sh(BOX.chromium, ['--version']);
  console.log(`Browser: ${chrome.status === 0 ? chrome.stdout.trim() : 'not found'} · Node ${process.version}`);
  const head = sh('git', ['-C', BOX.repoDir, 'log', '-1', '--format=%h %cs %s']);
  if (head.status === 0) console.log(`Code: ${head.stdout.trim()}`);
  console.log(`Outbound filter: ${describeFilter()}`);
  console.log('\nThe app:');
  scraper(['check'], { tty: false });
  console.log('\nLast lines of the scraper\'s log:');
  sh('journalctl', ['-u', BOX.listenUnit, '-u', BOX.dailyUnit, '-n', '25', '--no-pager', '-o', 'short-iso'], { inherit: true });
}

/** The latest master, through the read-only deploy key; then libraries, patches, service
 *  files, the Chromium check, and a restart of whatever was running. Everything after the
 *  pull runs in the code just pulled (`update --pulled`, which every version must keep):
 *  this process still holds the old code, and would write the old service files and the
 *  old outbound list until the next update. */
async function update() {
  requireRoot();
  if (!flag('pulled')) {
    const git = (...args) => sh('git', ['-C', BOX.repoDir, ...args], {
      env: { GIT_SSH_COMMAND: `ssh -i ${BOX.deployKey} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes` },
    });
    const before = git('rev-parse', '--short', 'HEAD').stdout.trim();
    must('git fetch', git('fetch', '--quiet', 'origin', 'master'));
    must('git merge', git('merge', '--ff-only', '--quiet', 'origin/master'));
    const after = git('rev-parse', '--short', 'HEAD').stdout.trim();
    ok(before === after ? `Already up to date (${after}).` : `Code ${before} → ${after}.`);
    if (before !== after) {
      process.exitCode = sh(BOX.node, [join(BOX.scrapeDir, 'box.mjs'), 'update', '--pulled'], { inherit: true }).status;
      return;
    }
  }
  await installCode();
  if (filterMode !== 'off') writeFilter(filterMode); // the list as the new code has it
  systemFiles();
  if (scraper(['chrome-check'], { tty: false }) !== 0) throw new Error('Chromium does not start with the new code (see above). The services were not restarted.');
  if (filterMode !== 'off') startFilter(filterMode);
  for (const u of [BOX.listenUnit, BOX.dailyTimer]) {
    if (sh('systemctl', ['is-active', '--quiet', u]).status === 0) sh('systemctl', ['restart', u]);
  }
  ok('Updated. Running services were restarted.');
}

// --- the daily run, and GitHub running it instead ----------------------------

/** The box's daily run alone: off, on, or how it is. The 🏦 listener is not touched. */
function daily(sub) {
  requireRoot();
  if (!existsSync(join(BOX.unitDir, BOX.dailyTimer))) throw new Error('Not set up yet. Run: sudo finance-scraper setup');
  if (sub === 'off') return dailyOff('');
  if (sub === 'on') {
    must('systemctl enable', sh('systemctl', ['enable', '--now', BOX.dailyTimer]));
    return ok(`The box's daily run is on again: every day at ${BOX.dailyAt} Israel time (never on Shabbat or Yom Tov).`);
  }
  if (sub) throw new Error('Usage: sudo finance-scraper daily [on | off]');
  const on = sh('systemctl', ['is-enabled', BOX.dailyTimer]).stdout.trim() === 'enabled';
  console.log(on ? `The box's daily run is on: every day at ${BOX.dailyAt} Israel time.` : 'The box\'s daily run is paused (sudo finance-scraper daily on turns it on).');
}

function dailyOff(why) {
  must('systemctl disable', sh('systemctl', ['disable', '--now', BOX.dailyTimer]));
  ok(`The box's daily run is paused${why ? ` (${why})` : ''}. 🏦 still works here. To run it from the box again: sudo finance-scraper daily on`);
}

/** github-connect, from the box's vault (scrape.mjs, githubConnect.mjs). When GitHub's check and first run pass,
 *  the box's own daily run pauses: one daily run, not two, so each bank sees one sign-in a day (household
 *  2026-10-11, "3 a": paused for GitHub's test; 🏦 keeps working here). */
function githubConnectBox() {
  requireRoot();
  if (filterMode === 'enforce') {
    throw new Error('The outbound filter lets the scraper reach only the banks and your app, and github-connect needs GitHub ' +
      '(api.github.com) once. Run: sudo finance-scraper outbound watch, then github-connect again, then sudo finance-scraper outbound enforce');
  }
  const status = scraper(['github-connect', ...rest]);
  process.exitCode = status;
  if (status === 0) dailyOff('GitHub runs it now');
}

// --- import-logins ---------------------------------------------------------

/** The PC's vault file, uploaded through the VM window: it lands in the user's home,
 *  which the scraper's sandbox cannot see (ProtectHome). Copy it where it can, import,
 *  then delete both: the logins now live in this box's own vault. */
function importLoginsFile(file) {
  requireRoot();
  if (!file) throw new Error('Usage: sudo finance-scraper import-logins scraper-vault.json   (upload it first: the Upload file button of the VM window)');
  const src = resolve(file);
  if (!existsSync(src)) {
    throw new Error(`No file at ${src}. Upload scraper-vault.json with the Upload file button of the VM window ` +
      '(it lands in your home folder), then run this again.');
  }
  const copy = join(BOX.stateDir, `import-${process.pid}.json`);
  copyFileSync(src, copy);
  chmodSync(copy, 0o600);
  must('chown', sh('chown', [`${BOX.user}:${BOX.user}`, copy]));
  let status;
  try {
    status = scraper(['import-logins', copy]);
  } finally {
    try { unlinkSync(copy); } catch { /* gone */ }
  }
  if (status === 0) {
    unlinkSync(src);
    ok(`Deleted the uploaded ${basename(src)}.`);
  }
  process.exitCode = status;
}

// --- the outbound filter (outbound.mjs) ---------------------------------------

function describeFilter(f = readState(readText(OUTBOUND.stateFile))) {
  if (f.mode === 'off') return 'off (sudo finance-scraper outbound watch starts it)';
  const since = f.since ? ` since ${f.since.slice(0, 16).replace('T', ' ')} UTC` : '';
  return f.mode === 'watch' ? `watching${since}: every name and connection is written down, nothing is blocked`
    : `enforcing${since}: only the banks and the app`;
}

/** nftables and dnsmasq, from Debian, when this box does not have them yet. If Debian's own
 *  daily updates are running (apt busy), wait for them rather than fail. */
async function ensureFilterPackages() {
  if (existsSync(OUTBOUND.nft) && existsSync(OUTBOUND.dnsmasq)) return;
  console.log('Installing nftables and dnsmasq from Debian (a minute or two)…');
  const o = { run: (args) => sh('apt-get', args, { env: { DEBIAN_FRONTEND: 'noninteractive' } }), sleep };
  await aptWithWaits('apt-get update', ['update', '-qq'], o);
  await aptWithWaits('apt-get install', ['install', '-y', '-qq', '--no-install-recommends', 'nftables', 'dnsmasq-base'], o);
  ok('Installed nftables and dnsmasq-base (neither starts a service of its own).');
}

function ensureFilterUser() {
  if (sh('id', ['-u', OUTBOUND.user]).status === 0) return;
  must('useradd', sh('useradd', ['--system', '--user-group', '--home-dir', '/nonexistent', '--no-create-home', '--shell', '/usr/sbin/nologin', OUTBOUND.user]));
  ok(`Created the user ${OUTBOUND.user} for the resolver and the hostname check (no login, no password).`);
}

/** The list, the resolver's settings, the rules and their units. Root-owned: the scraper
 *  cannot change where it may go. */
function writeFilter(mode) {
  mkdirSync(OUTBOUND.dir, { recursive: true, mode: 0o755 });
  const list = allowList({ endpoint: appEndpoint() });
  const upstream = nameservers(readText('/etc/resolv.conf'));
  writeFileSync(OUTBOUND.allowFile, allowFileText(list));
  writeFileSync(OUTBOUND.dnsmasqFile, dnsmasqConf(mode, { list, upstream }));
  writeFileSync(OUTBOUND.nftFile, nftRules(mode));
  writeFileSync(join(BOX.unitDir, OUTBOUND.dnsUnit), dnsUnit());
  writeFileSync(join(BOX.unitDir, OUTBOUND.sniUnit), sniUnit());
  writeFileSync(join(BOX.unitDir, OUTBOUND.rulesUnit), rulesUnit(mode));
}

/** Start (or restart) what the mode needs, then the rules: one systemctl call, so one
 *  transaction. Restarting the resolver restarts the rules too (they require it), and a
 *  second, separate restart of the rules could collide with that one. */
function startFilter(mode) {
  must('systemctl daemon-reload', sh('systemctl', ['daemon-reload']));
  const v = sh('systemd-analyze', ['verify', ...[OUTBOUND.dnsUnit, OUTBOUND.sniUnit, OUTBOUND.rulesUnit].map((u) => join(BOX.unitDir, u))]);
  if (v.status !== 0) throw new Error(`systemd does not accept the filter's service files:\n${(v.stderr || v.stdout).trim()}`);
  if (mode !== 'enforce') sh('systemctl', ['stop', OUTBOUND.sniUnit]); // the rules no longer require it
  must('systemctl enable', sh('systemctl', ['enable', OUTBOUND.rulesUnit]));
  const from = `@${Math.floor(Date.now() / 1000) - 1}`;
  const units = mode === 'enforce' ? [OUTBOUND.dnsUnit, OUTBOUND.sniUnit, OUTBOUND.rulesUnit] : [OUTBOUND.dnsUnit, OUTBOUND.rulesUnit];
  const r = sh('systemctl', ['restart', ...units]);
  if (r.status !== 0) {
    const log = sh('journalctl', [...units.flatMap((u) => ['-u', u]), '--since', from, '--no-pager', '-o', 'cat']).stdout.trim();
    throw new Error(`The filter did not start: ${r.stderr.trim()}${log ? `\n${log}` : ''}`);
  }
}

function stopFilter() {
  sh('systemctl', ['disable', '--now', OUTBOUND.rulesUnit]); // its ExecStop removes the table
  sh('systemctl', ['stop', OUTBOUND.sniUnit, OUTBOUND.dnsUnit]);
  if (existsSync(OUTBOUND.nft)) sh(OUTBOUND.nft, ['delete', 'table', 'inet', OUTBOUND.table]); // in case it outlived the unit
}

function scrapeRunning() {
  const lock = readJson(join(BOX.stateDir, 'scrape.lock'));
  return Boolean(lock?.at && Date.now() - Date.parse(lock.at) < 90_000); // refreshed every 30 s while a scrape runs
}

/** Since when to read the logs: when the mode began, or the last `days` days. */
function logsSince(state, days) {
  if (days) return `@${Math.floor(Date.now() / 1000 - Number(days) * 86_400)}`;
  return state.since ? `@${Math.floor(Date.parse(state.since) / 1000)}` : '-7d';
}

function readFilterLogs(since) {
  const j = (...args) => sh('journalctl', [...args, '--since', since, '-o', 'cat', '--no-pager']).stdout;
  return readLogs({ dns: j('-u', OUTBOUND.dnsUnit), kernel: j('_TRANSPORT=kernel'), sni: j('-u', OUTBOUND.sniUnit) });
}

async function outbound() {
  requireRoot();
  const sub = rest[0];
  const before = readState(readText(OUTBOUND.stateFile));
  if (!sub || sub === 'report') {
    const list = readAllowFile(readText(OUTBOUND.allowFile));
    console.log(formatReport(readFilterLogs(logsSince(before, opt('days', ''))), {
      list: list.length ? list : allowList({ endpoint: appEndpoint() }), mode: before.mode, since: before.since,
    }));
    return;
  }
  if (!['watch', 'enforce', 'off'].includes(sub)) throw new Error('Usage: sudo finance-scraper outbound [watch | enforce | off]');
  if (scrapeRunning()) throw new Error('A scrape is running right now. Run this again when it has finished (a few minutes).');
  const wasListening = sh('systemctl', ['is-active', '--quiet', BOX.listenUnit]).status === 0;
  const setState = (mode, since) => {
    mkdirSync(OUTBOUND.dir, { recursive: true, mode: 0o755 });
    writeFileSync(OUTBOUND.stateFile, `${JSON.stringify({ mode, since })}\n`);
    filterMode = mode;
  };
  const afterwards = () => {
    systemFiles();
    if (wasListening) sh('systemctl', ['restart', BOX.listenUnit]); // its new settings apply from now
  };

  if (sub === 'off') {
    stopFilter();
    setState('off', null);
    afterwards();
    return ok('The outbound filter is off: the scraper may connect anywhere again, and nothing is written down.');
  }

  await ensureFilterPackages();
  ensureFilterUser();
  const since = before.mode === sub && before.since ? before.since : new Date().toISOString();
  writeFilter(sub);
  setState(sub, since);
  const testFrom = `@${Math.floor(Date.now() / 1000) - 1}`;
  let failed = '';
  try {
    startFilter(sub);
    console.log(`\nChecking, as the scraper, that it ${sub === 'watch' ? 'still reaches everything' : 'reaches only the list'}:`);
    if (scraper(['filter-selftest', sub], { tty: false }) !== 0) failed = 'The check above did not come out as expected.';
    else if (scraper(['check'], { tty: false }) !== 0) failed = 'The app did not accept the box through the filter (see above).';
    else if (!readFilterLogs(testFrom).asked.size) failed = "The scraper's DNS did not reach its own resolver, so nothing would be written down.";
  } catch (err) {
    failed = err.message;
  }
  if (failed) {
    // Back to how it was, so a failed switch never leaves the scraper stuck or unwatched.
    if (before.mode === 'off') stopFilter();
    else {
      writeFilter(before.mode);
      filterMode = before.mode;
      try { startFilter(before.mode); } catch (err) { warn(`Could not go back to ${before.mode}: ${err.message}`); stopFilter(); before.mode = 'off'; }
    }
    setState(before.mode, before.mode === 'off' ? null : before.since);
    afterwards();
    throw new Error(`${failed}\nThe filter is back to: ${describeFilter()}. Send this output to whoever maintains the scraper.`);
  }
  afterwards();
  if (sub === 'watch') {
    if (!readFilterLogs(testFrom).flows.size) warn('The kernel did not write the connections down (nf_log): the report will show names only.');
    ok(`Watching: every name the scraper looks up and every connection it opens is written down. Nothing is blocked.
  In a week, run:  sudo finance-scraper outbound
  and send what it shows. Then the list is settled and blocking starts (sudo finance-scraper outbound enforce).`);
  } else {
    ok(`Enforcing: the scraper can reach only ${readAllowFile(readText(OUTBOUND.allowFile)).join(', ')}.
  If a bank stops working: sudo finance-scraper outbound watch   (blocks nothing again), and send: sudo finance-scraper outbound`);
  }
}

// --- dispatch --------------------------------------------------------------

const PASS_THROUGH = new Set(['pair', 'add-login', 'remove-login', 'map', 'show', 'companies', 'check', 'run', 'chrome-check', 'diagnostics', 'version']);

/** set-endpoint: in the vault (as the scraper), and in root's copy the outbound filter reads. */
function setEndpoint(raw) {
  requireRoot();
  const endpoint = cleanEndpoint(raw);
  if (!endpoint) throw new Error('Usage: sudo finance-scraper set-endpoint https://<your app\'s address>');
  const status = scraper(['set-endpoint', endpoint]);
  process.exitCode = status;
  if (status === 0) keepAppEndpoint(endpoint);
}

async function main() {
  switch (cmd) {
    case 'setup': return setup();
    case 'start': return start();
    case 'stop': return stop();
    case 'status': return status();
    case 'update': return update();
    case 'daily': return daily(rest[0]);
    case 'set-endpoint': return setEndpoint(rest[0]);
    case 'github-connect': return githubConnectBox();
    case 'import-logins': return importLoginsFile(rest[0]);
    case 'outbound': return outbound();
    default:
      if (PASS_THROUGH.has(cmd)) {
        requireRoot();
        process.exitCode = scraper([cmd, ...rest]);
        return;
      }
      console.log(usage());
      if (cmd) {
        // Instructions newer than the code on the box (household, 2026-10-07: import-logins
        // printed only this list): say so, and how to get the new code.
        console.error(`\n"${cmd}" is not a command this box knows${codeVersion()}. If you were just given it, ` +
          'the box has older code: run  sudo finance-scraper update  and then the command again.');
        process.exitCode = 1;
      }
  }
}

/** The comment block at the top of this file, all of it. */
function usage() {
  const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
  const end = lines.findIndex((l) => !l.startsWith('//'));
  return lines.slice(0, end < 0 ? lines.length : end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
}

/** " (its code: cf10d07, 2026-10-04)", or nothing when the checkout can't say. */
function codeVersion() {
  const r = sh('git', ['-C', BOX.repoDir, 'log', '-1', '--format=%h, %cd', '--date=short']);
  return r.status === 0 && r.stdout.trim() ? ` (its code: ${r.stdout.trim()})` : '';
}

main().catch((err) => {
  console.error(`\nError: ${err?.message ?? err}`);
  process.exitCode = 1;
});
