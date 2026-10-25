// The agent on GitHub (SINGLE_FAMILY_PLAN S5). A family's own private repo, made from our template, runs
// `scrape.mjs github-run` (the template's agent.yml): once a day on GitHub's schedule, and when someone presses
// "Run workflow". There is no vault on GitHub. What a vault holds comes from the repo's own settings, which only
// the family can change:
//   - each bank login: the secret LOGIN_<COMPANY>, the login's fields as JSON (GitHub keeps it encrypted);
//   - the device token: the secret ROSHEMET_TOKEN (review-only, from the dashboard's pairing);
//   - the app's address and the account map: the variables ROSHEMET_APP and ROSHEMET_MAP.
// agent.yml hands them to the agent's step only. Before it prints anything else, the agent tells GitHub to hide
// every login value from the run's log (::add-mask::), and it takes them out of its environment before the
// browser starts. `github-connect`, on the computer or box that holds the logins, fills these settings.
//
// Pure functions; scrape.mjs applies them. Nothing here talks to a bank or to the network.

import { SLOTS, cleanEndpoint, tokenProblem } from './lib.mjs';

export const TOKEN_SECRET = 'ROSHEMET_TOKEN';
export const APP_VARIABLE = 'ROSHEMET_APP';
export const MAP_VARIABLE = 'ROSHEMET_MAP';
export const LOGIN_PREFIX = 'LOGIN_';

/** The repo secret that holds `company`'s login ("visaCal" → "LOGIN_VISACAL"). */
export const loginSecretName = (company) => `${LOGIN_PREFIX}${String(company).toUpperCase()}`;

/** Login fields a run cannot do without: the library's, less what is asked at run time or only sometimes needed. */
const OPTIONAL_FIELDS = new Set(['otpCodeRetriever', 'otpLongTermToken', 'phoneNumber']);
export const requiredFields = (loginFields) => (loginFields ?? []).filter((f) => !OPTIONAL_FIELDS.has(f));

const MAP_KEY = /^[A-Za-z]{1,30}:\d{4}$/;
const isSlot = (s) => SLOTS.includes(s) || s === 'skip';

/** What agent.yml gave this step, taken as it is: the token, the app, the map and every LOGIN_* secret (raw). */
export function githubEnv(env) {
  const logins = Object.fromEntries(Object.entries(env ?? {})
    .filter(([k, v]) => k.startsWith(LOGIN_PREFIX) && typeof v === 'string' && v !== ''));
  return {
    app: String(env?.[APP_VARIABLE] ?? ''), map: String(env?.[MAP_VARIABLE] ?? ''), token: String(env?.[TOKEN_SECRET] ?? ''),
    logins, names: [APP_VARIABLE, MAP_VARIABLE, TOKEN_SECRET, ...Object.keys(logins)],
  };
}

/** GitHub's encoding for a workflow command's value (as the Actions toolkit's escapeData). */
export const commandData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** `::add-mask::` lines for the token and every value of every login: GitHub then shows each as *** wherever it
 *  appears in the run's log. GitHub hides each secret as a whole already; a login is JSON, so its parts need this. */
export function maskLines(given) {
  const values = [given.token];
  for (const raw of Object.values(given.logins ?? {})) {
    values.push(raw);
    try {
      const creds = JSON.parse(raw);
      if (creds && typeof creds === 'object') values.push(...Object.values(creds).filter((v) => typeof v === 'string'));
    } catch { /* not JSON: readGithubSettings says which secret; GitHub hides the whole value */ }
  }
  return [...new Set(values.map((v) => String(v ?? '').trim()).filter(Boolean))].map((v) => `::add-mask::${commandData(v)}`);
}

/**
 * The run's settings from what agent.yml gave (githubEnv). `companies`: the library's SCRAPERS (id → { loginFields }).
 * A problem names the setting and how to fix it, never a value.
 * @returns {{ config: { endpoint: string, token: string, logins: object, map: object }, problems: string[] }}
 */
export function readGithubSettings(given, companies) {
  const problems = [];
  const endpoint = cleanEndpoint(given.app) ?? '';
  if (!given.app.trim()) problems.push(`The variable ${APP_VARIABLE} (your app's address) is not set.`);
  else if (!endpoint) problems.push(`The variable ${APP_VARIABLE} is not an app address (https://…).`);
  const token = given.token.trim();
  if (!token) problems.push(`The secret ${TOKEN_SECRET} (this repo's pairing with your app) is not set.`);
  else if (tokenProblem(token)) problems.push(`The secret ${TOKEN_SECRET} is not a token your app gave: pair this repo again (github-connect).`);

  const byName = new Map(Object.entries(companies ?? {}).map(([id, def]) => [loginSecretName(id), [id, def]]));
  const logins = {};
  for (const [name, raw] of Object.entries(given.logins ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const known = byName.get(name);
    if (!known) { problems.push(`The secret ${name} is not a company this agent knows.`); continue; }
    const [company, def] = known;
    let creds = null;
    try { creds = JSON.parse(raw); } catch { /* below */ }
    if (!creds || typeof creds !== 'object' || Array.isArray(creds)) {
      problems.push(`The secret ${name} is not a login the agent can read: set it again with github-connect.`);
      continue;
    }
    const clean = Object.fromEntries(Object.entries(creds).filter(([, v]) => typeof v === 'string' && v.trim() !== ''));
    const missing = requiredFields(def?.loginFields).filter((f) => !clean[f]);
    if (missing.length) { problems.push(`The secret ${name} has no ${missing.join(', ')}: set it again with github-connect.`); continue; }
    logins[company] = clean;
  }

  let map = {};
  if (given.map.trim()) {
    let m = null;
    try { m = JSON.parse(given.map); } catch { /* below */ }
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      problems.push(`The variable ${MAP_VARIABLE} is not an account map: set it again with github-connect.`);
    } else {
      const entries = Object.entries(m);
      const good = entries.filter(([k, s]) => MAP_KEY.test(k) && isSlot(s));
      // Never the entries themselves: their keys hold the last 4 digits of an account.
      if (good.length < entries.length) {
        problems.push(`The variable ${MAP_VARIABLE} has ${entries.length - good.length} entr${entries.length - good.length === 1 ? 'y' : 'ies'} ` +
          `the agent cannot use (each is "company:last 4 digits": "${SLOTS.join('|')}|skip"): set it again with github-connect.`);
      }
      map = Object.fromEntries(good);
    }
  }
  return { config: { endpoint, token, logins, map }, problems };
}

/** Which days a run asks for: a whole number, 0 to 365. 0 is the check (no bank login). Null if it is not one. */
export function runDays(raw, dflt = 45) {
  const s = String(raw ?? '').trim();
  if (!s) return dflt;
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n <= 365 ? n : null;
}

/** 'private', 'public', or null when neither the API's answer nor the event says. */
export function repoVisibility({ api, event } = {}) {
  const fromApi = typeof api?.private === 'boolean' ? api.private : null;
  const fromEvent = typeof event?.repository?.private === 'boolean' ? event.repository.private : null;
  const priv = fromApi ?? fromEvent;
  return priv === null ? null : priv ? 'private' : 'public';
}

export const PUBLIC_REPO = 'This repo is public, so anyone can read its runs\' logs. The agent does not run in a public repo. ' +
  'Make it private (on GitHub: Settings → General → Danger Zone → Change visibility), then run again.';

/** An account the map does not know, and how to add it from where the logins are kept. */
export function unmappedGithubLine(u) {
  return `${u.company} ••${u.last4} (${u.txns} transactions) is not mapped: on the computer or box that keeps your logins, ` +
    `map it (map ${u.company} ${u.last4} <${SLOTS.join('|')}|skip>) and run github-connect again.`;
}

/** The scrape log, kept from run to run in GitHub's cache: its newest `keep` lines. */
export function trimLog(text, keep = 1000) {
  const lines = String(text ?? '').split('\n').filter(Boolean);
  return lines.length ? `${lines.slice(-keep).join('\n')}\n` : '';
}

const dayOf = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(String(ymd)) ? `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}` : '');
const cellText = (s) => String(s ?? '').replace(/[|\r\n]/g, ' ').slice(0, 200);

/**
 * The summary GitHub shows on the run's page (Markdown): per login, ok or the error type, how many transactions and
 * the newest date; then what happened. No amount, description, account or login.
 * @param {{ entries?: object[], notes?: string[], outcome: string }} r  entries: runLogEntry lines; outcome: one line.
 */
export function runSummary({ entries = [], notes = [], outcome }) {
  const lines = ['## Bank run', ''];
  if (entries.length) {
    lines.push('| Login | Result | Transactions | Newest |', '|---|---|---|---|');
    for (const e of entries) {
      const company = /^[A-Za-z]{1,30}$/.test(String(e.company ?? '')) ? e.company : '?';
      lines.push(e.ok
        ? `| ${company} | ✓ | ${Number.isFinite(e.txns) ? e.txns : '?'} | ${dayOf(e.newest)} |`
        : `| ${company} | ✗ ${cellText(e.errorType)} | | |`);
    }
    lines.push('');
  }
  for (const n of notes) lines.push(`- ${cellText(n)}`);
  if (notes.length) lines.push('');
  lines.push(cellText(outcome));
  return `${lines.join('\n')}\n`;
}

/** The check's summary (days 0): each line ✓ or ✗. */
export function checkSummary(checks) {
  const ok = checks.every((c) => c.ok);
  return [`## Check: ${ok ? 'everything is ready' : 'something needs fixing'}`, '',
    ...checks.map((c) => `- ${c.ok ? '✓' : '✗'} ${cellText(c.line)}`), ''].join('\n');
}
