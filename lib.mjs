// Pure-ish helpers for the local bank scraper (scrape.mjs). Kept apart from the
// CLI so vitest can exercise them; typed by lib.d.mts (the repo's tsconfig has
// no node typings, so this stays plain JS).
//
// Nothing in this file talks to a bank or to the network.

import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export const SLOTS = ['bank', 'card1', 'card2', 'card3', 'card4'];

// ---------------------------------------------------------------------------
// Vault: the whole config (logins, the account map, endpoint + token) encrypted
// with AES-256-GCM under a key derived from a passphrase with scrypt. GCM's tag
// makes a wrong passphrase and a tampered file fail the same, loudly.
// ---------------------------------------------------------------------------

const KDF = { N: 2 ** 17, r: 8, p: 1 }; // ~128 MiB, a fraction of a second: fine once per run

function deriveKey(passphrase, salt, kdf) {
  return scryptSync(String(passphrase).normalize('NFKC'), salt, 32, {
    N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r,
  });
}

/** Which store opens a vault without anyone typing (setup's random key): written beside the ciphertext, never the key. */
export const KEY_STORES = Object.freeze(['dpapi', 'keychain']);

/** @returns {string} the vault file's text. `meta.key`: the store that keeps its key (KEY_STORES), if not a passphrase. */
export function encryptVault(config, passphrase, kdf = KDF, meta = {}) {
  if (!passphrase || String(passphrase).length < 8) throw new Error('Passphrase must be at least 8 characters.');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, kdf);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1, kdf: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p,
    ...(KEY_STORES.includes(meta.key) ? { key: meta.key } : {}),
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  }, null, 1);
}

/** What a vault file says about itself without being opened: { key: 'dpapi' | 'keychain' | null } (null: a
 *  passphrase, or the box's sealed key). */
export function vaultMeta(text) {
  try {
    const f = JSON.parse(text);
    return { key: KEY_STORES.includes(f?.key) ? f.key : null };
  } catch {
    return { key: null };
  }
}

export function decryptVault(text, passphrase) {
  let f;
  try {
    f = JSON.parse(text);
  } catch {
    throw new Error('The vault file is not valid JSON — damaged?');
  }
  if (f?.v !== 1 || f.kdf !== 'scrypt') throw new Error('Unknown vault format.');
  const key = deriveKey(passphrase, Buffer.from(f.salt, 'base64'), { N: f.N, r: f.r, p: f.p });
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
  d.setAuthTag(Buffer.from(f.tag, 'base64'));
  try {
    const plain = Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new Error('Wrong passphrase, or the vault file was modified.');
  }
}

export function emptyConfig() {
  return { endpoint: '', token: '', logins: {}, map: {} };
}

/** The app's address as typed ("roshemet.cohen.workers.dev/" → "https://roshemet.cohen.workers.dev"), or null.
 *  http only for this machine itself (a test app). */
export function cleanEndpoint(raw) {
  let s = cleanSecretInput(raw).replace(/\/+$/, '');
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return null;
  return u.origin;
}

// ---------------------------------------------------------------------------
// Account map: "company:last4" -> slot. Only the slot ever leaves this machine.
// ---------------------------------------------------------------------------

/** Last 4 digits of an account/card number ("12-345-678901" -> "8901"). */
export function last4(accountNumber) {
  const digits = String(accountNumber ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : digits;
}

export const mapKey = (company, digits) => `${company}:${digits}`;
const VISUAL_ORDER_COMPANIES = new Set(['isracard', 'amex']);

export function setMapping(config, company, digits, slot) {
  if (!/^\d{4}$/.test(String(digits))) throw new Error('Use exactly the last 4 digits.');
  if (!SLOTS.includes(slot) && slot !== 'skip') throw new Error(`Slot must be one of ${SLOTS.join(', ')} or skip.`);
  config.map[mapKey(company, digits)] = slot;
  return config;
}

/** Another vault's logins and account map (the Windows PC's), merged into this one, so
 *  moving to the box needs no logins typed again. Never its token or endpoint: this
 *  machine keeps its own (a box's token is review-only; the PC's has full rights). */
export function importLogins(config, other) {
  const logins = Object.keys(other.logins ?? {}).filter((c) => /^[A-Za-z]{1,30}$/.test(c) &&
    other.logins[c] && typeof other.logins[c] === 'object' && !Array.isArray(other.logins[c]));
  const replaced = logins.filter((c) => config.logins[c]);
  for (const c of logins) {
    // Text fields only, without the invisible marks a paste on the PC may have left.
    config.logins[c] = Object.fromEntries(Object.entries(other.logins[c])
      .filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, cleanSecretInput(v)]));
  }
  const mapped = Object.entries(other.map ?? {})
    .filter(([k, slot]) => /^[A-Za-z]{1,30}:\d{4}$/.test(k) && (SLOTS.includes(slot) || slot === 'skip'))
    .map(([k, slot]) => { config.map[k] = slot; return k; });
  return { logins, replaced, mapped };
}

/** A command as the household types it: `sudo finance-scraper …` on the box, `node scrape.mjs …` on the PC. */
export const commandFor = (args, onBox) => `${onBox ? 'sudo finance-scraper' : 'node scrape.mjs'} ${args}`;

/** The line for an account the map does not know yet, with the command that maps it. */
export function unmappedLine(u, onBox) {
  return `${u.company} ••${u.last4} (${u.txns} transactions) is not mapped: run ` +
    commandFor(`map ${u.company} ${u.last4} <${SLOTS.join('|')}|skip>`, onBox);
}

/**
 * Turn scrape results into the POST body.
 * @param results [{ company, at, accounts: [{ accountNumber, balance, txns }] }] — successful scrapes only;
 *   `at` is when that company's scrape finished.
 * @returns {{ payload, unmapped: {company,last4,txns}[], skipped: {company,last4,txns}[] }}
 */
export function buildPayload(config, results, dryRun) {
  const accounts = [];
  const unmapped = [];
  const skipped = [];
  for (const r of results) {
    for (const acc of r.accounts ?? []) {
      const d = last4(acc.accountNumber);
      const slot = config.map[mapKey(r.company, d)];
      const info = { company: r.company, last4: d, txns: (acc.txns ?? []).length };
      if (!slot) { unmapped.push(info); continue; }
      if (slot === 'skip') { skipped.push(info); continue; }
      // The bank's own balance, so the app can check its ledger against it. A card
      // company's "balance" is something else (the next bill), so only the bank's goes.
      const balance = slot === 'bank' && typeof acc.balance === 'number' && Number.isFinite(acc.balance)
        ? { balance: acc.balance, balanceAt: r.at ?? new Date().toISOString() } : {};
      accounts.push({
        slot,
        ...balance,
        // Only what the app reads. No account numbers, identifiers or memos.
        txns: (acc.txns ?? []).map((t) => ({
          date: t.date,
          processedDate: t.processedDate,
          chargedAmount: t.chargedAmount,
          // Isracard and Amex (same platform) sometimes send visual-order text.
          description: VISUAL_ORDER_COMPANIES.has(r.company) ? fixVisualOrder(t.description ?? '') : String(t.description ?? ''),
          status: t.status,
          installments: t.installments ?? null,
          category: t.category ?? undefined,
        })),
      });
    }
  }
  return { payload: { dryRun, accounts }, unmapped, skipped };
}

// ---------------------------------------------------------------------------
// Scrape health. Bank sites change their login pages and add OTP steps; the
// library breaks quietly when they do. Every run appends one line per company
// to a local log; these warnings read it back.
// ---------------------------------------------------------------------------

const ADVICE = {
  INVALID_PASSWORD: 'the site rejected the password. Check it on the website, then `add-login` again.',
  CHANGE_PASSWORD: 'the site wants a new password. Change it on the website, then `add-login` again.',
  ACCOUNT_BLOCKED: 'the site says the account is blocked. Sort it out with the bank before scraping again.',
  TWO_FACTOR_RETRIEVER_MISSING: 'the site now asks for a one-time SMS code. The scraper needs an OTP step for it — see README.',
  TIMEOUT: 'the site did not answer in time. Retry once; if it repeats, the login page probably changed.',
  GENERIC: 'the scraper could not get through. The login page probably changed — update israeli-bank-scrapers (see README).',
  GENERAL_ERROR: 'the scraper failed. The login page probably changed — update israeli-bank-scrapers (see README).',
  BLOCKED: 'the site refused the automated browser (HTTP 403/429: anti-bot protection), not a password problem. ' +
    'It usually lifts within a day: do not retry repeatedly (automatic runs skip it for 12 hours); try once tomorrow. ' +
    'Until then, upload that card\'s file from its website.',
};

/** The library reports a refused page as a generic navigation error; name it for what it is. */
export function classifyFailure(errorType, errorMessage) {
  if (/status code: (403|429)\b/.test(String(errorMessage ?? ''))) return 'BLOCKED';
  return String(errorType || 'GENERAL_ERROR').toUpperCase().replace(/[^A-Z_]/g, '_').slice(0, 40);
}
export const adviceFor = (errorType) => ADVICE[errorType] ?? ADVICE.GENERAL_ERROR;

/**
 * @param log   parsed log lines: { at, company, ok, errorType?, txns?, newest? }
 * @param today yyyy-mm-dd
 * @returns string[] warnings, one per company at most
 */
export function healthWarnings(log, today) {
  const byCompany = new Map();
  for (const e of log) {
    if (!byCompany.has(e.company)) byCompany.set(e.company, []);
    byCompany.get(e.company).push(e);
  }
  const out = [];
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  // A browser update that breaks the scraper looks like every bank failing at once, right
  // after the browser changed. Say so first: it is not the banks, and not the passwords.
  const byTime = (a, b) => (a.at < b.at ? -1 : 1);
  const latest = [...byCompany.values()].map((es) => [...es].sort(byTime).pop());
  if (latest.length && latest.every((e) => !e.ok && e.browser)) {
    const now = [...latest].sort(byTime).pop().browser;
    const lastOk = log.filter((e) => e.ok && e.browser).sort(byTime).pop();
    if (lastOk && lastOk.browser !== now) {
      out.push(`Every login failed right after the browser changed (${lastOk.browser} → ${now}). That points at the ` +
        'browser update, not the banks or the passwords: the scraper needs an update for it. Meanwhile, upload the files from the websites.');
    }
  }
  for (const [company, entries] of byCompany) {
    entries.sort((a, b) => (a.at < b.at ? -1 : 1));
    const recent = entries.slice(-3);
    const last = recent[recent.length - 1];
    // A card that is usually empty (a backup card, hardly used): nothing found is normal for it.
    // Three empty runs are news only for one that usually has rows.
    const earlier = entries.slice(-23, -3).filter((e) => e.ok);
    const usuallyEmpty = earlier.length >= 2 && earlier.filter((e) => !e.txns).length * 2 >= earlier.length;
    if (recent.length === 3 && recent.every((e) => !e.ok)) {
      out.push(`${company}: the last 3 scrapes failed (${last.errorType ?? 'error'}) — ${adviceFor(last.errorType)}`);
    } else if (recent.length === 3 && recent.every((e) => e.ok && !e.txns) && !usuallyEmpty) {
      out.push(`${company}: logged in but found no transactions 3 times running — the site may have changed where it lists them.`);
    } else if (last.ok && last.newest && daysBetween(last.newest, today) > 14) {
      out.push(`${company}: the newest transaction is from ${last.newest} — over two weeks old. Check the account on the website.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unattended runs. The vault passphrase is kept protected by Windows (DPAPI,
// CurrentUser scope): only this Windows account on this machine can unprotect
// it, and it never travels anywhere. PowerShell 5.1 (always on Windows) does the
// DPAPI call, so no native module is needed. The secret goes in on stdin, never
// on a command line (visible to other processes), and as base64 so a Hebrew
// passphrase survives the console's code page.
// ---------------------------------------------------------------------------

const PS_PRELUDE = "Add-Type -AssemblyName System.Security; $e=[Text.Encoding]::UTF8.GetBytes('finance-cloud-scraper'); " +
  '$in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ';
export const PS_PROTECT = PS_PRELUDE +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($in,$e,'CurrentUser'))";
export const PS_UNPROTECT = PS_PRELUDE +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($in,$e,'CurrentUser'))";

/** Runs a PowerShell script with `input` on stdin; returns trimmed stdout. */
export async function powershell(script, input) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    input, encoding: 'utf8', windowsHide: true,
  });
  if (r.error || r.status !== 0) throw new Error(`Windows protection failed: ${(r.stderr || r.error?.message || '').trim()}`);
  return String(r.stdout).trim();
}

export async function protectKey(passphrase, run = powershell) {
  return run(PS_PROTECT, Buffer.from(String(passphrase), 'utf8').toString('base64'));
}
export async function unprotectKey(blob, run = powershell) {
  return Buffer.from(await run(PS_UNPROTECT, String(blob).trim()), 'base64').toString('utf8');
}

// ---------------------------------------------------------------------------
// The weekly scheduled task (Windows Task Scheduler). Never on Shabbat: the run
// ends in a message to the household chat.
// ---------------------------------------------------------------------------

export const TASK_NAME = 'finance-cloud-scrape';
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export function checkSchedule(day, time) {
  const d = String(day ?? '').toUpperCase();
  if (!DAYS.includes(d)) throw new Error(`Day must be one of ${DAYS.join(', ')}.`);
  const m = String(time ?? '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) throw new Error('Time must be HH:MM (24-hour).');
  if (d === 'SAT') throw new Error('Not on Shabbat: the run posts to the household chat.');
  if (d === 'FRI' && Number(m[1]) >= 13) throw new Error('On Friday, schedule before 13:00 (Shabbat starts early in winter).');
  return { day: d, time: `${m[1]}:${m[2]}` };
}

/** The .cmd wrapper the task runs (schtasks' /TR is capped at 261 characters). */
export function autoCmd({ nodePath, scriptPath, vaultPath, logPath }) {
  return [
    '@echo off',
    `"${nodePath}" "${scriptPath}" run --auto --vault "${vaultPath}" >> "${logPath}" 2>&1`,
    '',
  ].join('\r\n');
}

export function schtasksCreateArgs(cmdPath, day, time) {
  const s = checkSchedule(day, time);
  // Quote only a path with spaces (Task Scheduler needs the quotes then). Without
  // spaces, no quotes: nothing for Node's Windows argument escaping to get wrong.
  const tr = /\s/.test(cmdPath) ? `"${cmdPath}"` : cmdPath;
  return ['/Create', '/F', '/TN', TASK_NAME, '/SC', 'WEEKLY', '/D', s.day, '/ST', s.time, '/TR', tr];
}

/** The vault key systemd hands the Linux box's services ($CREDENTIALS_DIRECTORY/vault-key):
 *  exactly as sealed, except one trailing newline if someone sealed it with `echo`. */
export function readSealedKey(text) {
  const key = String(text ?? '').replace(/\r?\n$/, '');
  if (key.length < 32) throw new Error('The vault key from systemd is missing or too short. Run: sudo finance-scraper setup');
  return key;
}

/** Windows-only commands, and what does their job on the Linux box. */
export const LINUX_INSTEAD = Object.freeze({
  remember: 'the vault key is already sealed to this machine by `sudo finance-scraper setup`; nothing to remember',
  forget: 'to make a new key: sudo finance-scraper setup --new-key',
  schedule: 'sudo finance-scraper start (a daily run, plus the listener)',
  automate: 'sudo finance-scraper setup, then pair, add the logins, and sudo finance-scraper start',
  listen: 'sudo finance-scraper start',
  unschedule: 'sudo finance-scraper stop',
  setup: 'sudo finance-scraper setup',
  uninstall: 'sudo finance-scraper stop',
});

/** One chat line per login that failed this run, with what to do about it. */
export function failureWarnings(failures) {
  return failures.map((f) => `${f.company}: login failed (${f.errorType}) — ${adviceFor(f.errorType)}`);
}

// ---------------------------------------------------------------------------
// "fetch failed" says nothing: Node puts the real reason in err.cause (often
// nested: undici wraps the socket error). Name it, the URL, and what to check.
// ---------------------------------------------------------------------------

const NET_HINTS = [
  [/^(ENOTFOUND|EAI_AGAIN)$/, 'DNS could not find the host. Check the URL (`node scrape.mjs show`) and that this PC is online.'],
  [/^ECONNREFUSED$/, 'The host refused the connection. Check the URL and port.'],
  [/^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT)$/, 'The connection timed out. A firewall, VPN or proxy may be blocking it; try again on another network.'],
  [/^(ECONNRESET|EPIPE|UND_ERR_SOCKET)$/, 'The connection was cut. Often antivirus "web shield" / HTTPS scanning, a VPN or a proxy; try again, then with it paused.'],
  [/^(UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_\w+|ERR_TLS_\w+)$/,
    'The HTTPS certificate was not trusted. Usually antivirus HTTPS scanning or a corporate proxy re-signing traffic. ' +
    'Node does not use the Windows certificate store: run with NODE_OPTIONS=--use-system-ca (Node 22.15+), or turn off HTTPS scanning for node.exe. Never disable certificate checks.'],
  [/^UND_ERR_BODY_TIMEOUT$/, 'The app took too long to answer. Try a shorter --days window.'],
  [/^UND_ERR_INVALID_ARG$/, 'Node refused to send the request: the stored scraper token is not a valid header (usually invisible characters from pasting). Run: node scrape.mjs set-token'],
];

/** Every { code, message } in an error's cause chain, outermost first. */
export function errorChain(err) {
  const out = [];
  for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth++) {
    out.push({ code: e.code ?? e.errno ?? e.name ?? '', message: String(e.message ?? e) });
    if (Array.isArray(e.errors)) for (const sub of e.errors.slice(0, 3)) out.push({ code: sub.code ?? '', message: String(sub.message ?? sub) });
  }
  return out;
}

export function describeFetchError(err, url) {
  const chain = errorChain(err);
  const lines = [`Could not reach the app at ${url}`];
  for (const c of chain) lines.push(`  ${c.code ? `${c.code}: ` : ''}${c.message}`);
  const hint = chain.map((c) => NET_HINTS.find(([re]) => re.test(String(c.code)))?.[1]).find(Boolean);
  lines.push(hint ? `What to check: ${hint}` : 'What to check: open the app\'s /api/health in a browser on this PC; if that works, the problem is Node\'s connection (proxy, antivirus, certificates).');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// --csv: every row of a listAll dry run, for checking in Excel. UTF-8 with a BOM
// (Excel needs it for Hebrew) and CRLF; every field quoted (descriptions carry
// commas and the quote in בע"מ).
// ---------------------------------------------------------------------------

const LABELS = { bank: 'Bank', card1: 'Card 1', card2: 'Card 2', card3: 'Card 3', card4: 'Card 4' };

/** "Card 4 (••1234)": a slot with the last 4 digits its accounts have in this vault's map, so a
 *  card is never named without them. The digits come from the family's own map, never from here. */
export function slotLabel(slot, map = {}) {
  const digits = Object.entries(map).filter(([, s]) => s === slot).map(([k]) => k.split(':').pop()).sort();
  const name = LABELS[slot] ?? slot;
  return digits.length ? `${name} (${digits.map((d) => `••${d}`).join(', ')})` : name;
}
const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
// A description starting with = + - @ would run as a formula when the CSV is opened.
const cell = (v) => q(/^[=+\-@\t\r]/.test(String(v ?? '')) ? `'${v}` : v);

export function rowsCsv(slots, map = {}) {
  const lines = [['account', 'what', 'date', 'amount', 'type', 'description'].map(q).join(',')];
  for (const s of slots) {
    for (const t of s.newRows ?? []) lines.push([slotLabel(s.slot, map), 'new', t.date, t.amount, t.type, cell(t.description)].map((v, i) => (i === 5 ? v : q(v))).join(','));
    for (const t of s.excludedRows ?? []) lines.push([slotLabel(s.slot, map), 'kept out of spending', t.date, t.amount, t.kind, cell(t.description)].map((v, i) => (i === 5 ? v : q(v))).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Pasted secrets. In raw mode (the hidden prompt) a terminal wraps pasted text in
// "bracketed paste" markers, ESC[200~ … ESC[201~; Windows Terminal does. Kept,
// they made the scraper token an invalid HTTP header (undici:
// UND_ERR_INVALID_ARG "invalid authorization header") and would corrupt a
// pasted bank password. No real secret contains an escape or a control char.
// ---------------------------------------------------------------------------

export function cleanSecretInput(s) {
  return String(s ?? '')
    .replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '') // bracketed paste, arrow keys, other CSI sequences
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
}

/** The token the app expects: what `randomBytes(32).toString('base64url')` makes. */
export function tokenProblem(token) {
  const t = String(token ?? '');
  if (!t) return 'No scraper token. Run: node scrape.mjs set-token';
  if (/[^\x21-\x7e]/.test(t)) return 'The scraper token contains characters that cannot be sent (spaces, Hebrew or hidden characters). Run: node scrape.mjs set-token';
  if (t.length < 32) return `The scraper token is ${t.length} characters; the app needs at least 32 (the same value as the Worker's SCRAPER_TOKEN). Run: node scrape.mjs set-token`;
  return null;
}

/** Clean every stored secret in place; true if anything changed (caller re-saves). */
export function cleanConfigSecrets(config) {
  let changed = false;
  const fix = (v) => { const c = cleanSecretInput(v); if (c !== v) changed = true; return c; };
  config.token = fix(config.token ?? '');
  for (const creds of Object.values(config.logins ?? {})) {
    for (const k of Object.keys(creds)) if (typeof creds[k] === 'string') creds[k] = fix(creds[k]);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// The token both sides share. Copying it by hand between two prompts went wrong
// twice, so `set-token --generate` makes it here, sets it on the Worker through
// wrangler (piped, never pasted), and keeps it only if that worked. `check`
// proves the pair matches without scraping or writing anything.
// ---------------------------------------------------------------------------

export function generateToken() {
  return randomBytes(32).toString('base64url');
}

/** What an answer from the app's scraper endpoints means, for a person. */
export function refusalMessage(status, body = {}) {
  if (status === 401) {
    return 'The app does not accept this token: it is not a paired box\'s (revoked, or never paired) nor the ' +
      'Worker\'s SCRAPER_TOKEN. On the Linux box: sudo finance-scraper pair. ' +
      'On the Windows PC: node scrape.mjs set-token --generate (sets a new one on both sides).';
  }
  if (status === 503 && body.error === 'scraper_disabled') {
    return 'The app has no scraper connected (no box paired, no SCRAPER_TOKEN set). On the Linux box: ' +
      'sudo finance-scraper pair. On the Windows PC: node scrape.mjs set-token --generate';
  }
  if (status === 403 && body.error === 'review_only') {
    return body.detail ?? 'This box can only send scrapes for approval: run with --review.';
  }
  if (status === 413) return 'The upload is too large for the app (5 MB). Use a shorter --days window.';
  return `The app refused the upload: HTTP ${status} ${body.error ?? ''} ${body.detail ?? ''}`.trim();
}

// ---------------------------------------------------------------------------
// Pairing a box with the app: the dashboard shows a one-time code, `pair` sends it
// once, and the app answers with this box's own (review-only) token.
// ---------------------------------------------------------------------------

/** The code as typed: "k7qm-3xpd" → "K7QM3XPD" (I and L read as 1, O as 0). Null unless 8
 *  code characters. The app applies the same rule (src/worker/scrapeDevices.ts; a test
 *  keeps the two equal). */
export function normalizePairCode(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(s) ? s : null;
}

/** What a refused pairing means. The app words its refusals for people already. */
export function pairRefusal(status, body = {}) {
  if (body.detail) return body.detail;
  return `The app refused the pairing: HTTP ${status} ${body.error ?? ''}`.trim();
}

/** `check`: a POST with an empty payload. The token is checked before the payload,
 *  so 400 invalid_payload proves the token is right and nothing was written. */
export function interpretCheck(status, body = {}) {
  if (status === 400 && body.error === 'invalid_payload') return { ok: true, message: 'The app accepts this scraper token.' };
  return { ok: false, message: refusalMessage(status, body) };
}

// ---------------------------------------------------------------------------
// Isracard sometimes sends text in VISUAL order: an all-English name reversed
// ("AZZIP ESEEHC YAS" = SAY CHEESE PIZZA, "S'RENIERHCS" = SCHREINER'S) and
// brackets mirrored inside Hebrew (")ער(" = "(ער)"). The same scrape also sends
// "CLOUDFLARE" the right way round, so only a clear signal flips anything: a
// leading "S'" (a possessive read backwards), or the reversed text reading as
// English far better than the original (letter-pair frequencies). The margin is
// set so none of 56 real merchant names flips. An ambiguous name stays as sent.
// ---------------------------------------------------------------------------

// Common English letter pairs, per 1000 (standard frequency tables).
const BIGRAMS = {
  TH: 27, HE: 23, IN: 20, ER: 18, AN: 16, RE: 14, ND: 13, ON: 13, EN: 12, AT: 12, OU: 11, ED: 11, HA: 11, TO: 10,
  OR: 10, IT: 10, IS: 10, HI: 10, ES: 10, NG: 9, ST: 9, AR: 9, TE: 9, SE: 8, NT: 8, VE: 8, ME: 8, AS: 8, LE: 8, AL: 8,
  EA: 7, RA: 7, RI: 7, RO: 7, DE: 7, CO: 6, CH: 6, LL: 6, LI: 6, NE: 6, IC: 6, EL: 6, TI: 6, SH: 5, MA: 5, DI: 5,
  NO: 5, LA: 5, UR: 5, CE: 5, CA: 5, BE: 5, IO: 5, ET: 5, OF: 5, SS: 4, EE: 4, OO: 4, US: 4, UT: 4, OL: 4, IL: 4,
  OM: 4, PE: 4, PR: 4, FO: 4, WA: 4, NI: 4, LO: 4, AD: 4, SI: 4, TR: 4, UN: 4, EC: 4, TA: 4, CL: 3, WH: 3, PO: 3,
  PL: 3, PA: 3, AC: 3, AI: 3, AY: 3, OP: 3, SA: 3, SO: 3, GE: 3, IE: 3, ID: 3, EM: 3, FI: 3, MO: 3, MI: 3, NA: 3,
  OW: 3, OT: 3, RT: 3, RS: 3, TS: 3, AM: 3, OS: 3, GR: 2, BL: 2, BR: 2, EX: 2, FL: 2, KE: 2, RY: 2, UL: 2, UM: 2,
  UP: 2, AP: 2, AV: 2, EW: 2, IV: 2, OD: 2, PI: 2, PP: 1, ZA: 1, IZ: 1, ZZ: 1,
};
const HEBREW = /[֐-׿]/;
const reverseText = (s) => [...s].reverse().join('');

function englishScore(s) {
  let total = 0, pairs = 0;
  for (const w of s.toUpperCase().split(/[^A-Z]+/).filter(Boolean)) {
    for (let i = 0; i + 1 < w.length; i++) { total += Math.log1p(BIGRAMS[w[i] + w[i + 1]] ?? 0); pairs++; }
  }
  return pairs ? total / pairs : 0;
}

export function looksReversed(s) {
  const t = String(s ?? '').trim();
  if (HEBREW.test(t) || !/[A-Za-z]{3}/.test(t)) return false;
  if (/^S'[A-Za-z]/.test(t)) return true; // "…'S" read backwards
  if (/[A-Za-z]'S$/i.test(t)) return false;
  return englishScore(reverseText(t)) - englishScore(t) > 0.6;
}

/** Isracard/Amex descriptions back into reading order; anything unclear stays as sent. */
export function fixVisualOrder(desc) {
  const s = String(desc ?? '');
  if (HEBREW.test(s)) return s.replace(/\)([^()]*)\(/g, '($1)'); // mirrored brackets around Hebrew
  return looksReversed(s) ? reverseText(s.trim()) : s;
}

// ---------------------------------------------------------------------------
// Backing off. A site that answered BLOCKED is not retried by automatic runs for
// 12 hours: more attempts can only extend a block (it may be on the IP).
// ---------------------------------------------------------------------------

/** The latest BLOCKED for `company` within `hours`, unless a success came after it. */
export function recentBlock(log, company, now = new Date(), hours = 12) {
  const mine = log.filter((e) => e.company === company).sort((a, b) => (a.at < b.at ? -1 : 1));
  const last = mine[mine.length - 1];
  if (!last || last.ok || last.errorType !== 'BLOCKED') return null;
  return now.getTime() - Date.parse(last.at) < hours * 3_600_000 ? last : null;
}

// ---------------------------------------------------------------------------
// `/scrape` from the group: a task polls every 15 minutes (hidden, via
// wscript) and runs the unattended scrape when asked. Never on Shabbat: the
// result posts to the household chat, so the request waits.
// ---------------------------------------------------------------------------

export const POLL_TASK_NAME = 'finance-cloud-scrape-poll';

/** Friday from 13:00 to the end of Saturday, Israel time (the weekly schedule's own rule). */
export function isShabbatWindow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return p.weekday === 'Sat' || (p.weekday === 'Fri' && Number(p.hour) >= 13);
}

// ---------------------------------------------------------------------------
// Quiet days: Shabbat and Yom Tov, as kept in Israel. Anything that ends in a
// message to the household chat waits from 13:00 the day before (the rule above)
// to the end of the day, and back-to-back days make one window (Yom Tov on a
// Friday + Shabbat; Rosh Hashana's two days). The Hebrew date comes from Node's
// own calendar (ICU, `en-u-ca-hebrew`): no dependency and no table that runs out.
// It matched hebcal's Israel calendar on every day from Sep 2026 to Sep 2037.
// ---------------------------------------------------------------------------

/** Yom Tov in Israel by Hebrew month (ICU's English names) and day. Chol HaMoed is not Yom Tov. */
export const YOM_TOV = Object.freeze({ Tishri: [1, 2, 10, 15, 22], Nisan: [15, 21], Sivan: [6] });
/** Quiet from this hour (Israel time) on the day before a Shabbat or Yom Tov. */
export const EREV_HOUR = 13;

const IL_TZ = 'Asia/Jerusalem';
const hebrewFmt = new Intl.DateTimeFormat('en-u-ca-hebrew', { timeZone: 'UTC', day: 'numeric', month: 'long' });
const ilClockFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: IL_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});
const ilOffsetFmt = new Intl.DateTimeFormat('en-US', { timeZone: IL_TZ, timeZoneName: 'longOffset' });
const partsOf = (fmt, d) => Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
const noonUtc = (ymd) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
};

/** yyyy-mm-dd plus n days. */
export function addDays(ymd, n) {
  const t = noonUtc(ymd);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** The Hebrew date of a civil date (yyyy-mm-dd): { day, month } with month as ICU names it ("Tishri", "Adar II"…). */
export function hebrewDate(ymd) {
  const p = partsOf(hebrewFmt, noonUtc(ymd));
  return { day: Number(p.day), month: p.month };
}

let calendarOk = false;
function checkCalendar() {
  if (calendarOk) return;
  const rh = hebrewDate('2026-09-12'); // Rosh Hashana 5787
  if (rh.day !== 1 || rh.month !== 'Tishri') {
    throw new Error('This Node has no Hebrew calendar (a "small-icu" build), so Yom Tov cannot be found. ' +
      'Install the official Node from nodejs.org.');
  }
  calendarOk = true;
}

/** Is this civil date (yyyy-mm-dd) Yom Tov in Israel? */
export function isYomTov(ymd) {
  checkCalendar();
  const h = hebrewDate(ymd);
  return YOM_TOV[h.month]?.includes(h.day) ?? false;
}

/** 'shabbat' | 'yomtov' | null for a civil date in Israel. */
export function quietDay(ymd) {
  if (noonUtc(ymd).getUTCDay() === 6) return 'shabbat';
  return isYomTov(ymd) ? 'yomtov' : null;
}

/** The civil date (yyyy-mm-dd) and hour (0-23) in Israel at an instant. */
export function israelClock(now = new Date()) {
  const p = partsOf(ilClockFmt, now);
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** The instant a civil day starts in Israel (00:00 Asia/Jerusalem; clocks change at 02:00, never at midnight). */
export function israelMidnight(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  let t = base - 2 * 3_600_000; // first guess: winter time, then correct with the offset in force
  for (let i = 0; i < 2; i++) {
    const g = /GMT([+-])(\d\d):(\d\d)/.exec(partsOf(ilOffsetFmt, new Date(t)).timeZoneName ?? '');
    const offsetMin = g ? (g[1] === '-' ? -1 : 1) * (Number(g[2]) * 60 + Number(g[3])) : 0;
    t = base - offsetMin * 60_000;
  }
  return new Date(t);
}

/** Quiet right now? null, or why and until when: { kind: 'shabbat' | 'yomtov', until: Date }, where
 *  `until` is the midnight (Israel) after the last of the back-to-back quiet days. */
export function quietWindow(now = new Date()) {
  const { ymd, hour } = israelClock(now);
  let first = null;
  if (quietDay(ymd)) first = ymd;
  else if (hour >= EREV_HOUR && quietDay(addDays(ymd, 1))) first = addDays(ymd, 1);
  if (!first) return null;
  let last = first;
  while (quietDay(addDays(last, 1))) last = addDays(last, 1);
  return { kind: quietDay(first), until: israelMidnight(addDays(last, 1)) };
}

/** "Shabbat until Sun 04/10 00:00" (Israel time), for logs. */
export function describeQuiet(q) {
  const when = q.until.toLocaleString('en-GB', {
    timeZone: IL_TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).replace(/,/g, '');
  return `${q.kind === 'yomtov' ? 'Yom Tov' : 'Shabbat'} until ${when} (Israel time)`;
}

/** An automatic run (daily timer, weekly task) inside a quiet window does nothing: its
 *  result would post to the group. Returns the line to log, or null to go ahead. */
export function autoRunQuietSkip(now = new Date()) {
  const q = quietWindow(now);
  return q ? `${now.toISOString()} not scraping: ${describeQuiet(q)}. The next run after it catches up.` : null;
}

export function pollCmd({ nodePath, scriptPath, vaultPath, logPath }) {
  return [
    '@echo off',
    `"${nodePath}" "${scriptPath}" poll --vault "${vaultPath}" >> "${logPath}" 2>&1`,
    '',
  ].join('\r\n');
}

/** Starts the .cmd with no window (style 0), so nothing flashes every 15 minutes. */
export function hiddenLauncherVbs(cmdPath) {
  return `CreateObject("WScript.Shell").Run """${cmdPath.replace(/"/g, '')}""", 0, False\r\n`;
}

export function schtasksPollArgs(vbsPath, minutes = 15, name = POLL_TASK_NAME) {
  const target = /\s/.test(vbsPath) ? `"${vbsPath}"` : vbsPath;
  return ['/Create', '/F', '/TN', name, '/SC', 'MINUTE', '/MO', String(minutes), '/TR', `wscript.exe //B //Nologo ${target}`];
}

// ---------------------------------------------------------------------------
// The listener: `poll` keeps a line open to the app (/api/scrape/request/wait),
// so 🏦 / `/scrape` reaches the PC within seconds, and a request made while the
// PC was off runs as soon as it is on. A launcher in the Startup folder starts
// it at logon; the 15-minute task restarts it if it ever stops. One at a time.
// ---------------------------------------------------------------------------

/** The listener refreshes its lock every 30 s; older than this, it is gone. */
export const LISTEN_LOCK_STALE_MS = 90_000;
export const STARTUP_LAUNCHER = 'finance-cloud-scrape-listen.vbs';

/** The current user's Startup folder (no admin rights needed to put a launcher there). */
export function startupFolder(appData) {
  if (!appData) throw new Error('APPDATA is not set, so the Startup folder cannot be found (run this on the Windows PC).');
  return `${appData}\\Microsoft\\Windows\\Start Menu\\Programs\\Startup`;
}

/** Is another listener running? Its lock is fresh and its process still exists. */
export function listenerAlive(lock, { now = new Date(), ownPid, pidAlive }) {
  if (!lock || !lock.pid || lock.pid === ownPid) return false;
  if (!(now.getTime() - Date.parse(lock.at) < LISTEN_LOCK_STALE_MS)) return false;
  return pidAlive(lock.pid);
}

/** One scrape at a time on this machine (the daily run, a 🏦 request, a run typed by
 *  hand): two at once log into every bank twice, which is what bank anti-bot systems
 *  count. The lock file holds { pid, at }; the holder refreshes `at` every 30 s, so a
 *  lock whose process died or stopped refreshing is stale and is taken over.
 *  Returns true when this process now holds it. `fs` is node:fs (injected for tests). */
export function takeLock(path, { fs, pid, now = () => new Date(), pidAlive }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx': exclusive create, so two processes starting together cannot both win.
      fs.writeFileSync(path, JSON.stringify({ pid, at: now().toISOString() }), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }
    let seen;
    try {
      seen = fs.readFileSync(path, 'utf8');
    } catch {
      continue; // released meanwhile: try again
    }
    let lock = null;
    try {
      lock = JSON.parse(seen);
    } catch {
      // Unreadable: another process may be writing it this instant. Fresh means held.
      try {
        if (now().getTime() - fs.statSync(path).mtimeMs < 5_000) return false;
      } catch {
        continue;
      }
    }
    if (listenerAlive(lock, { now: now(), ownPid: pid, pidAlive })) return false;
    // Stale. Remove it only if it is still the file we judged, so two processes
    // clearing the same stale lock cannot both go on to take it.
    try {
      if (fs.readFileSync(path, 'utf8') === seen) fs.unlinkSync(path);
    } catch { /* already gone */ }
  }
  return false;
}

/** Keep a held lock fresh (every 30 s while working). Does nothing if it is no longer ours. */
export function refreshLock(path, { fs, pid, now = () => new Date() }) {
  try {
    if (JSON.parse(fs.readFileSync(path, 'utf8'))?.pid !== pid) return false;
    fs.writeFileSync(path, JSON.stringify({ pid, at: now().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

/** Let go of a lock this process holds (never someone else's). */
export function releaseLock(path, { fs, pid }) {
  try {
    if (JSON.parse(fs.readFileSync(path, 'utf8'))?.pid === pid) fs.unlinkSync(path);
  } catch { /* not ours, or gone */ }
}

/** Wait before retrying after the app could not be reached: 5 s, doubling, at most 2 min. */
export function nextBackoff(prevMs) {
  return prevMs ? Math.min(prevMs * 2, 120_000) : 5_000;
}

/** The app said no (wrong token, endpoint off): asking again cannot help. */
export class Refused extends Error {}

/** Inside a quiet window the listener naps at most this long, then looks again (a
 *  stop file, or a clock that jumped, is noticed within a nap). */
export const QUIET_NAP_MS = 15 * 60_000;

/** The listening loop, every outside effect passed in: ask the app → scrape if asked
 *  → ask again. If the app can't be reached, retry with back-off and say so once. A
 *  refusal ends it (thrown). A failed scrape is logged and listening goes on. On
 *  Shabbat and Yom Tov (`quiet`) it does not ask at all: it sleeps until the window
 *  ends and then listens again, so a request made meanwhile runs after it. (It used
 *  to exit instead; under systemd that was 5 quick restarts and a dead service.)
 *  Returns why it stopped: whatever `shouldStop` returned ('stop'). */
export async function listenLoop({ ask, scrape, shouldStop, sleep, log, onConnected = () => {}, now = () => new Date(), quiet = () => null }) {
  let delay = 0;
  let unreachable = false;
  let quietUntil = null;
  for (;;) {
    const stop = shouldStop();
    if (stop) return stop;
    const q = quiet(now());
    if (q) {
      if (quietUntil !== q.until.getTime()) log(`${now().toISOString()} not listening: ${describeQuiet(q)}`);
      quietUntil = q.until.getTime();
      await sleep(Math.max(1_000, Math.min(q.until.getTime() - now().getTime(), QUIET_NAP_MS)));
      continue;
    }
    if (quietUntil !== null) log(`${now().toISOString()} listening again`);
    quietUntil = null;
    let reply;
    try {
      reply = await ask();
    } catch (err) {
      if (err instanceof Refused) throw err;
      if (!unreachable) log(`${now().toISOString()} can't reach the app (${err?.message ?? err}); retrying`);
      unreachable = true;
      delay = nextBackoff(delay);
      await sleep(delay);
      continue;
    }
    if (unreachable) log(`${now().toISOString()} reached the app again`);
    unreachable = false;
    delay = 0;
    onConnected();
    if (!reply?.requested) continue;
    log(`--- ${now().toISOString()} scrape requested in the group${reply.at ? ` at ${reply.at}` : ''}`);
    try {
      await scrape();
    } catch (err) {
      log(`${now().toISOString()} the scrape failed: ${err?.message ?? err}`);
    }
  }
}
