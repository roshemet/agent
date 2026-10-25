// `diagnostics`: what support needs to help a family, and nothing that is the family's (SINGLE_FAMILY_PLAN S4:
// "a test shows diagnostics prints no login, account number or transaction"). Support never logs in to a
// family's machine or takes a login (MULTI_TENANT_PLAN, "Support without access"): the family copies this
// report, after reading it in full.
//
// It never opens the vault. It is built from what lies beside it unencrypted: the scrape log (per company and
// run: when, ok or the error type, how many transactions, the newest date) and the agent's state file, plus
// the versions and the schedule's state. The one kind of free text that comes from outside, a library's error
// message, is scrubbed with the login's own values when the log line is written (runLogEntry, field `said`);
// the report shows only that field, scrubbed again, and no other text a line may hold.

/** Text from outside (a library's error message) with what could be a person's or an account's taken out: every
 *  value of the login (`secrets`), each run of 4 or more digits (account, card and ID numbers, amounts, dates),
 *  e-mail addresses, Hebrew text (names, descriptions), and URLs past their host. Capped at `max` characters. */
export function scrubPersonal(text, secrets = [], max = 200) {
  let s = String(text ?? '');
  const values = [...new Set((secrets ?? []).map((v) => String(v ?? '').trim()).filter((v) => v.length >= 3))]
    .sort((a, b) => b.length - a.length);
  for (const v of values) {
    const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    s = s.replace(re, '<login>');
  }
  s = s
    .replace(/\b(https?|wss?):\/\/([^/\s?#'"]+)[^\s'"]*/gi, (_m, scheme, host) => `${scheme}://${host.replace(/^[^@]*@/, '')}/…`)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/[֐-׿][֐-׿\s"'.,\-()]*/g, '<text> ')
    .replace(/\d[\d\s.,:\-/]*\d|\d/g, (m) => (m.replace(/\D/g, '').length >= 4 ? '#' : m))
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The scrape log's line for one login in one run: when, ok or the error type, how many transactions and the newest
 *  date; never a login, an account number or a transaction. `creds`, the login, takes its own values out of the
 *  library's message too; `classify` names the error (lib.mjs classifyFailure). */
export function runLogEntry({ at, company, browser }, r, creds = {}, classify = (type) => type) {
  const entry = { at, company, ok: !!r?.success, ...(browser ? { browser } : {}) };
  if (r?.success) {
    const txns = (r.accounts ?? []).flatMap((a) => a?.txns ?? []);
    entry.txns = txns.length;
    const newest = txns.map((t) => String(t?.date ?? '').slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop();
    if (newest) entry.newest = newest;
  } else {
    entry.errorType = classify(r?.errorType, r?.errorMessage);
    // `said`: the only free text a log line carries, and only ever scrubbed with the login's own values here.
    if (r?.errorMessage) entry.said = scrubPersonal(r.errorMessage, Object.values(creds ?? {}));
  }
  return entry;
}

const IL = 'Asia/Jerusalem';
const when = (iso, withYear = false) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  return d.toLocaleString('en-GB', {
    timeZone: IL, day: '2-digit', month: '2-digit', ...(withYear ? { year: 'numeric' } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).replace(',', '').replace(/\//g, '.');
};
const dayOf = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(String(ymd)) ? `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}` : '?');

const HOMES = {
  windows: 'this computer (Windows)', mac: 'this computer (Mac)', linux: 'this computer (Linux)',
  box: 'the scraper box (Linux, systemd)', github: 'GitHub Actions',
};
const KEY_STORES = {
  dpapi: 'opened by Windows (DPAPI), for this Windows account only',
  keychain: 'opened by the Mac\'s Keychain, for this Mac user only',
  tpm: 'opened by the key sealed to this machine\'s TPM',
  passphrase: 'opened by a passphrase typed at each run',
  remembered: 'opened by a passphrase Windows remembers (DPAPI)',
};
/** Company ids as the library names them (letters only); anything else in a log line is not shown. */
const companyName = (c) => (/^[A-Za-z]{1,30}$/.test(String(c ?? '')) ? String(c) : '?');
const errorName = (e) => String(e ?? 'error').toUpperCase().replace(/[^A-Z_]/g, '_').slice(0, 40);

/**
 * The report, as text. Every field is either ours (versions, states, counts, dates, the library's company ids
 * and error types) or scrubbed (`message`).
 * @param {object} d see diagnostics.d.mts
 */
export function diagnosticsReport(d) {
  const lines = [];
  lines.push('Roshemet agent: diagnostics');
  lines.push(`Made ${when(d.now, true)} (Israel time). No login, account number, amount or transaction is in it.`);
  lines.push('');
  const v = d.versions ?? {};
  const lib = v.library ? `israeli-bank-scrapers ${v.library}${v.patches?.length ? ` (patched: ${v.patches.join(', ')})` : ''}` : 'israeli-bank-scrapers NOT INSTALLED';
  lines.push(`Versions: agent ${v.agent ?? '?'} · ${lib} · Node ${v.node ?? '?'} · ${v.os ?? '?'}${v.browser ? ` · ${v.browser}` : ''}`);
  lines.push(`Runs on: ${HOMES[d.home] ?? d.home ?? '?'}`);
  const vault = d.vault ?? {};
  lines.push(vault.exists
    ? `Vault: present, ${KEY_STORES[vault.keyStore] ?? 'opened by a passphrase typed at each run'}`
    : 'Vault: none yet (setup makes it)');
  if (d.state?.pairedAt) lines.push(`Paired with the app: ${when(d.state.pairedAt, true)}`);
  for (const s of d.schedule ?? []) lines.push(s);
  if (d.listener) {
    const l = d.listener;
    lines.push(l.alive
      ? `Listener (🏦): running${l.connectedAt ? `, reached the app at ${when(l.connectedAt)}` : ', has not reached the app yet'}`
      : `Listener (🏦): not running${l.at ? ` (last seen ${when(l.at)})` : ''}`);
  }
  if (d.quiet) lines.push(`Now: ${d.quiet}`);
  lines.push('');

  const per = d.perCompany ?? 5;
  const byCompany = new Map();
  for (const e of [...(d.log ?? [])].sort((a, b) => (a.at < b.at ? 1 : -1))) {
    const c = companyName(e.company);
    if (!byCompany.has(c)) byCompany.set(c, []);
    if (byCompany.get(c).length < per) byCompany.get(c).push(e);
  }
  if (!byCompany.size) {
    lines.push('Banks and cards: no run yet.');
  } else {
    lines.push(`Banks and cards, the last ${per} runs of each, newest first (Israel time):`);
    for (const [c, es] of [...byCompany].sort(([a], [b]) => a.localeCompare(b))) {
      const runs = es.map((e) => (e.ok
        ? `${when(e.at)} ok, ${Number.isFinite(e.txns) ? e.txns : '?'} found`
        : `${when(e.at)} ${errorName(e.errorType)}`));
      lines.push(`  ${c}: ${runs.join(' · ')}`);
      const newest = es.find((e) => e.ok && e.newest)?.newest;
      if (newest) lines.push(`    newest transaction date: ${dayOf(newest)}`);
      // Only what runLogEntry wrote (`said`, scrubbed with the login there): other text in a line is never shown.
      for (const e of es.filter((x) => !x.ok && typeof x.said === 'string').slice(0, 2)) {
        lines.push(`    ${when(e.at)} said: ${scrubPersonal(e.said)}`);
      }
      const browsers = [...new Set(es.map((e) => e.browser).filter(Boolean))];
      // A browser's version string is ours to show as it is, kept to the characters a version uses.
      if (browsers.length) lines.push(`    browser: ${browsers.map((b) => String(b).replace(/[^\w .()/-]/g, '').slice(0, 80)).join(' → ')}`);
    }
  }
  if (d.warnings?.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of d.warnings) lines.push(`  - ${w}`);
  }
  return `${lines.join('\n')}\n`;
}
