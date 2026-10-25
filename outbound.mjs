#!/usr/bin/env node
// Where the scraper may connect, on the Linux box (household, 2026-10-04: "watch, then
// enforce a filter that lets the scraper talk only to the banks and the app").
//
// Three parts, all matching the scraper's user (finance-scraper) and nobody else:
//   - an nftables table: the scraper's DNS goes to a resolver of its own, and each new
//     connection it opens is written to the kernel log (watch) or, apart from what the
//     next two let through, dropped (enforce);
//   - that resolver (dnsmasq, run as finance-scraper-net): it logs every name the scraper
//     asks for, and when enforcing answers only names on the list;
//   - when enforcing, the hostname check (`node outbound.mjs serve`, as finance-scraper-net):
//     every HTTPS connection is handed to it, it reads the name the browser asked for (TLS
//     SNI) and passes the connection on only to a name on the list. An address alone is
//     not enough: the app sits on Cloudflare, whose addresses serve anyone's site.
//
// The banks see the same address and the same browser: this changes where the scraper
// may go, never what it sends. It is a filter on the box, not a proxy service and not a
// disguise (VM_SCRAPER_HANDOFF.md, "Hard boundaries"). Every host a bank's page was seen
// loading goes ON the list: the list never keeps a bank's own scripts from loading.
//
// Pure functions build the files and read the logs (testable anywhere); box.mjs applies
// them as root. `node outbound.mjs serve` is the hostname check; `selftest` (through
// `scrape.mjs filter-selftest`, as the scraper) proves the filter does what its mode says.

import net from 'node:net';
import tls from 'node:tls';
import { promises as dnsp } from 'node:dns';
import { readFileSync } from 'node:fs';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { BOX } from './linux.mjs';

export const OUTBOUND = Object.freeze({
  user: 'finance-scraper-net', // runs the resolver and the hostname check; never matched by the rules
  dir: '/etc/finance-scraper', // root-owned: the scraper cannot change its own list
  stateFile: '/etc/finance-scraper/outbound.json', // { mode, since }
  allowFile: '/etc/finance-scraper/outbound-allow.txt',
  nftFile: '/etc/finance-scraper/outbound.nft',
  dnsmasqFile: '/etc/finance-scraper/dnsmasq.conf',
  table: 'finance_scraper',
  dnsPort: 5053,
  sniPort: 4443,
  rulesUnit: BOX.filterUnit,
  dnsUnit: 'finance-scraper-dns.service',
  sniUnit: 'finance-scraper-sni.service',
  logOut: 'finance-scraper out: ',
  logBlocked: 'finance-scraper blocked: ',
  nft: '/usr/sbin/nft',
  dnsmasq: '/usr/sbin/dnsmasq',
});

export const MODES = Object.freeze(['off', 'watch', 'enforce']);

/** Every company's sites, each domain with every subdomain: the addresses israeli-bank-scrapers 6.12.2 itself
 *  uses (its lib/scrapers/*.js; test/scrapeOutbound checks each against them). A box may reach any bank a family
 *  has, and nothing else but the family's app. */
export const BANK_DOMAINS = Object.freeze({
  hapoalim: ['bankhapoalim.co.il'],
  leumi: ['bankleumi.co.il', 'leumi.co.il'],
  mizrahi: ['mizrahi-tefahot.co.il'],
  discount: ['telebank.co.il'],
  mercantile: ['telebank.co.il'],
  otsarHahayal: ['bankotsar.co.il'],
  max: ['max.co.il'],
  visaCal: ['cal-online.co.il'],
  isracard: ['isracard.co.il'],
  amex: ['americanexpress.co.il'],
  union: ['unionbank.co.il'],
  beinleumi: ['fibi.co.il'],
  massad: ['bankmassad.co.il'],
  yahav: ['yahav.co.il'],
  beyahadBishvilha: ['hist.org.il'],
  oneZero: ['tfd-bank.com'],
  behatsdaa: ['behatsdaa.org.il'],
  pagi: ['pagi.co.il'],
});

/** Hosts the banks' pages were seen loading during the watch, reviewed one by one (each
 *  with the page that loads it). Empty until the first watch week is read. */
export const SEEN_EXTRA = Object.freeze([]);

/** "Online.Fibi.co.il." → "online.fibi.co.il"; null for anything that is not a DNS name
 *  (an address, an empty label, a character a hostname cannot have). */
export function normalizeHost(h) {
  const s = String(h ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!s || s.length > 253 || !/^[a-z0-9.-]+$/.test(s)) return null;
  const labels = s.split('.');
  if (labels.length < 2 || labels.some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return null;
  if (!/[a-z]/.test(labels[labels.length - 1])) return null; // 1.2.3.4 is an address, not a name
  return s;
}

/** Is `host` one of the listed domains, or under one? "fibi.co.il.evil.example" and
 *  "evilfibi.co.il" are not. */
export function hostAllowed(host, list) {
  const h = normalizeHost(host);
  return Boolean(h) && list.some((d) => h === d || h.endsWith(`.${d}`));
}

/** The list: the family's app (`endpoint`), the banks, what the watch showed they need. Sorted, no repeats. */
export function allowList({ endpoint, extra = SEEN_EXTRA }) {
  let app;
  try { app = new URL(endpoint).hostname; } catch { throw new Error(`Not the app's address: ${endpoint}`); }
  const all = [app, ...Object.values(BANK_DOMAINS).flat(), ...extra].map(normalizeHost);
  if (all.includes(null)) throw new Error(`Not a hostname in the list: ${[endpoint, ...extra].join(', ')}`);
  return [...new Set(all)].sort();
}

export const allowFileText = (list) =>
  `# Where the scraper may connect (each domain with its subdomains). Written by\n` +
  `# \`sudo finance-scraper outbound\` from scripts/scrape/outbound.mjs; edit that, not this.\n${list.join('\n')}\n`;

export function readAllowFile(text) {
  return String(text ?? '').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
    .map(normalizeHost).filter(Boolean);
}

/** apt saying another apt holds its lock: Debian's own daily updates, usually. Worth waiting
 *  for, not an error to show the household. */
export function aptBusy(output) {
  return /Could not get lock|is held by process|Unable to acquire the dpkg frontend lock|Unable to lock directory/i.test(String(output ?? ''));
}

/** Run apt (`run(args)` → { status, stdout, stderr }), waiting while Debian's own updates hold
 *  its lock: every 15 s, for up to 10 minutes. Any other failure says what to do. */
export async function aptWithWaits(what, args, { run, sleep, log = console.log, stepS = 15, maxS = 600 }) {
  for (let waited = 0; ; waited += stepS) {
    const r = run(args);
    if (r.status === 0) return;
    const said = (r.stderr || r.stdout || '').trim();
    if (!aptBusy(said)) {
      throw new Error(`${what} failed:\n${said}\nCheck the VM is online (it goes out through Cloud NAT), then run the same command again.`);
    }
    if (waited >= maxS) throw new Error("Debian's own updates have been running for 10 minutes. Wait a little, then run the same command again.");
    if (!waited) log("  Debian is installing its own updates right now; waiting for it to finish…");
    await sleep(stepS * 1000);
  }
}

/** The nameservers in /etc/resolv.conf: where the resolver sends the names it may answer. */
export function nameservers(resolvConf) {
  return [...String(resolvConf ?? '').matchAll(/^\s*nameserver\s+(\S+)/gm)].map((m) => m[1]);
}

// --- what goes to the system ------------------------------------------------

/** The nftables table. IPv4 only is redirected: the VM has no IPv6, and when enforcing an
 *  IPv6 connection is simply dropped (the browser falls back to IPv4). A redirected packet
 *  still shows its original interface to the filter hook (checked under Debian 13's
 *  systemd: OUT=vbox DST=127.0.0.1), so it is let through by where it now goes. */
export function nftRules(mode, { user = BOX.user } = {}, o = OUTBOUND) {
  if (mode !== 'watch' && mode !== 'enforce') throw new Error(`No rules for mode ${mode}`);
  const enforce = mode === 'enforce';
  return `#!${o.nft} -f
# finance-scraper: where the scraper (user ${user}) may connect. Mode: ${mode}.
# Written by \`sudo finance-scraper outbound ${mode}\` from scripts/scrape/outbound.mjs.
table inet ${o.table}
delete table inet ${o.table}
table inet ${o.table} {
	chain nat_out {
		type nat hook output priority -100; policy accept;
		# its DNS, to its own resolver (which logs it${enforce ? ', and answers only names on the list' : ''})
		meta nfproto ipv4 meta skuid "${user}" meta l4proto { tcp, udp } th dport 53 redirect to :${o.dnsPort}
${enforce ? `		# its HTTPS, to the hostname check
		meta nfproto ipv4 meta skuid "${user}" oifname != "lo" tcp dport 443 redirect to :${o.sniPort}
` : ''}	}
	chain filter_out {
		type filter hook output priority 0; policy accept;
		meta skuid != "${user}" accept
		oifname "lo" accept
		# what nat_out sent to the resolver${enforce ? ' or the hostname check' : ''} (this hook still sees the original interface)
		ip daddr 127.0.0.1 meta l4proto { tcp, udp } th dport ${enforce ? `{ ${o.dnsPort}, ${o.sniPort} }` : o.dnsPort} accept
		ct state != new accept
		${enforce ? `log prefix "${o.logBlocked}" level info drop` : `log prefix "${o.logOut}" level info`}
	}
}
`;
}

/** dnsmasq's configuration. Watching: every name, through the machine's own nameservers.
 *  Enforcing: only names on the list (REFUSED for the rest), and no HTTPS records, so the
 *  browser never hides the name it asks for (ECH) from the hostname check. */
export function dnsmasqConf(mode, { list = [], upstream = [] } = {}, o = OUTBOUND) {
  const lines = [
    `# finance-scraper: the scraper's own resolver. Mode: ${mode}. Only the scraper's DNS comes here`,
    '# (outbound.nft sends it). Written by `sudo finance-scraper outbound` from scripts/scrape/outbound.mjs.',
    `port=${o.dnsPort}`, 'listen-address=127.0.0.1', 'bind-interfaces', 'no-hosts', 'pid-file=',
    'log-queries=extra', 'log-facility=-',
  ];
  if (mode === 'enforce') {
    if (!upstream.length) throw new Error('No nameserver in /etc/resolv.conf: the listed names would have nowhere to go.');
    if (!list.length) throw new Error('The list is empty.');
    lines.push('no-resolv', ...list.flatMap((d) => upstream.map((ns) => `server=/${d}/${ns}`)), 'filter-rr=HTTPS');
  } else if (mode !== 'watch') {
    throw new Error(`No resolver for mode ${mode}`);
  }
  return `${lines.join('\n')}\n`;
}

const HARDENING = [
  'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes', 'PrivateDevices=yes',
  'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectKernelLogs=yes', 'ProtectControlGroups=yes',
  'ProtectClock=yes', 'ProtectHostname=yes', 'ProtectProc=invisible', 'RestrictSUIDSGID=yes', 'RestrictRealtime=yes',
  'RestrictNamespaces=yes', 'LockPersonality=yes', 'SystemCallArchitectures=native', 'SystemCallFilter=@system-service',
  'SystemCallErrorNumber=EPERM', 'CapabilityBoundingSet=', 'UMask=0077',
].join('\n');

/** The resolver. dnsmasq needs netlink to watch the interfaces. */
export function dnsUnit(o = OUTBOUND) {
  return `[Unit]
Description=finance-cloud scraper: its own resolver (only the scraper's DNS comes here)
After=network.target

[Service]
Type=simple
User=${o.user}
Group=${o.user}
ExecStart=${o.dnsmasq} --keep-in-foreground --conf-file=${o.dnsmasqFile}
Restart=always
RestartSec=2s
${HARDENING}
MemoryDenyWriteExecute=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
`;
}

/** The hostname check. Node's JavaScript engine needs writable+executable memory. */
export function sniUnit(box = BOX, o = OUTBOUND) {
  return `[Unit]
Description=finance-cloud scraper: the hostname check (HTTPS only to the banks and the app)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${o.user}
Group=${o.user}
ExecStart=${box.node} ${box.scrapeDir}/outbound.mjs serve
Restart=always
RestartSec=2s
${HARDENING}
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
`;
}

/** Loads the table, after the resolver (and the hostname check, when enforcing) are up.
 *  nftables.service flushes every table whenever it starts, restarts or reloads, so this
 *  one comes after it and follows it: started with it (both ways), restarted with it
 *  (PartOf), reloaded with it, and stopped with it, which when enforcing stops the
 *  scraper too (checked under Debian 13's systemd). */
export function rulesUnit(mode, box = BOX, o = OUTBOUND) {
  const needs = mode === 'enforce' ? `${o.dnsUnit} ${o.sniUnit}` : o.dnsUnit;
  return `[Unit]
Description=finance-cloud scraper: where the scraper may connect (nftables; mode: ${mode})
Requires=${needs}
Wants=nftables.service
After=${needs} nftables.service
PartOf=nftables.service
ReloadPropagatedFrom=nftables.service
Before=${box.listenUnit} ${box.dailyUnit}

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${o.nft} -f ${o.nftFile}
ExecReload=${o.nft} -f ${o.nftFile}
ExecStop=-${o.nft} delete table inet ${o.table}

[Install]
WantedBy=multi-user.target nftables.service
`;
}

// --- the hostname check -------------------------------------------------------

/** What the start of a TLS connection says: { need } (wait for more), { error }, or
 *  { host, ech } (host null when the client named none). Reads the ClientHello across
 *  TLS records, and nothing else. Strict where TLS is: a second name, or a second name
 *  extension, is an error (a server might read a different one than this did). */
export function parseClientHello(buf, maxBytes = 32 * 1024) {
  const parts = [];
  let off = 0;
  for (;;) {
    if (buf.length < off + 5) return { need: true };
    if (buf[off] !== 0x16 || buf[off + 1] !== 0x03) return { error: off ? 'a TLS record that is not part of the hello' : 'not TLS' };
    const len = buf.readUInt16BE(off + 3);
    if (!len || len > 16384) return { error: 'a TLS record of an impossible length' };
    if (off + 5 + len > maxBytes) return { error: 'a TLS hello too large to be real' };
    if (buf.length < off + 5 + len) return { need: true };
    parts.push(buf.subarray(off + 5, off + 5 + len));
    off += 5 + len;
    const hs = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    if (hs.length < 4) continue;
    if (hs[0] !== 0x01) return { error: 'not a TLS ClientHello' };
    const bodyLen = hs.readUIntBE(1, 3);
    if (bodyLen + 4 > maxBytes) return { error: 'a TLS hello too large to be real' };
    if (hs.length >= bodyLen + 4) return readHello(hs.subarray(4, 4 + bodyLen));
  }
}

function readHello(b) {
  let p = 0;
  const take = (n) => { // the offset of the next n bytes, moving past them
    if (p + n > b.length) throw new Error('short');
    p += n;
    return p - n;
  };
  const u8 = () => b[take(1)];
  const u16 = () => b.readUInt16BE(take(2));
  try {
    take(2 + 32); // version, random
    take(u8()); // session id
    take(u16()); // cipher suites
    take(u8()); // compression methods
    if (p === b.length) return { host: null, ech: false }; // no extensions at all
    const end = p + 2 + b.readUInt16BE(p);
    take(2);
    if (end !== b.length) throw new Error('length mismatch');
    let host = null;
    let named = false;
    let ech = false;
    while (p < end) {
      const type = u16();
      const at = take(u16());
      if (type === 0x0000) {
        if (named) throw new Error('two name extensions');
        named = true;
        host = readServerName(b.subarray(at, p));
      } else if (type === 0xfe0d) {
        ech = true;
      }
    }
    return { host, ech };
  } catch {
    return { error: 'a malformed TLS ClientHello' };
  }
}

/** The host_name in a server_name extension (RFC 6066): at most one, a DNS name. */
function readServerName(e) {
  if (e.length < 2 || e.readUInt16BE(0) !== e.length - 2) throw new Error('bad name list');
  let p = 2;
  let name = null;
  while (p < e.length) {
    if (p + 3 > e.length) throw new Error('short');
    const type = e[p];
    const len = e.readUInt16BE(p + 1);
    p += 3;
    if (p + len > e.length) throw new Error('short');
    if (type === 0) {
      if (name !== null) throw new Error('two names');
      name = e.subarray(p, p + len).toString('latin1');
    }
    p += len;
  }
  if (name === null) return null;
  const host = normalizeHost(name);
  if (!host || host !== name.toLowerCase()) throw new Error('not a hostname');
  return host;
}

/** The hostname check: the TCP server the scraper's HTTPS is redirected to. It reads the
 *  ClientHello and connects on to the name in it only when that name is on the list;
 *  anything else is reset (the browser shows ERR_CONNECTION_RESET). The hello goes on
 *  byte for byte, so the bank sees exactly what the browser sent. `connect` and `log`
 *  are for the tests. */
export function hostnameCheck({
  list,
  connect = (host) => net.connect({ host, port: 443, allowHalfOpen: true }),
  log = (line) => console.log(line),
  helloTimeoutMs = 10_000,
  connectTimeoutMs = 30_000,
}) {
  const state = { list };
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    let buf = Buffer.alloc(0);
    let decided = false;
    client.on('error', () => {});
    const refuse = (why) => {
      decided = true;
      clearTimeout(timer);
      log(`refused ${why}`);
      client.resetAndDestroy();
    };
    const timer = setTimeout(() => refuse(`a connection that sent no TLS hello within ${helloTimeoutMs / 1000} s`), helloTimeoutMs);
    const onData = (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const r = parseClientHello(buf);
      if (r.need) return;
      client.off('data', onData);
      client.pause();
      if (r.error) return refuse(r.error);
      if (!r.host) return refuse('a TLS connection that names no host');
      if (!hostAllowed(r.host, state.list)) return refuse(`${r.host}: not on the list`);
      decided = true;
      clearTimeout(timer);
      log(`allowed ${r.host}`);
      const up = connect(r.host);
      up.setTimeout(connectTimeoutMs, () => up.destroy(new Error('no answer')));
      up.on('error', (err) => {
        log(`could not reach ${r.host}: ${err.code ?? err.message}`);
        client.resetAndDestroy();
      });
      up.once('connect', () => {
        up.setTimeout(0);
        up.setKeepAlive(true, 60_000);
        client.setKeepAlive(true, 60_000);
        up.write(buf);
        // pipeline: either side failing destroys both; a clean end is passed on (half-close).
        pipeline(client, up, (err) => { if (err) up.destroy(); });
        pipeline(up, client, (err) => { if (err) client.destroy(); });
      });
    };
    client.on('data', onData);
    client.once('close', () => { if (!decided) clearTimeout(timer); });
  });
  server.setList = (newList) => { state.list = newList; };
  server.maxConnections = 1024;
  return server;
}

// --- the self-test (run as the scraper) --------------------------------------

/** Each check, what it expects in this mode, and what happened. Run as the scraper (so the
 *  rules apply): `sudo finance-scraper outbound …` does, before saying the filter is on.
 *  A refusal must be the filter's own (REFUSED from its resolver, a reset from the check,
 *  silence from the rules), not just any failure: Cloudflare turning away a name it does
 *  not know would look like a refusal too. */
export async function selftest(mode, {
  app, // the family's app's hostname (scrape.mjs gives it, from the vault)
  outsider = 'example.com',
  resolve4 = (h) => dnsp.resolve4(h),
  handshake = tlsHandshake,
  tcpOpen = tcpConnect,
} = {}) {
  if (!app) throw new Error('The self-test needs the app\'s hostname.');
  const enforce = mode === 'enforce';
  const results = [];
  const check = async (what, expect, fn) => {
    let got;
    let detail = '';
    try {
      detail = String((await fn()) ?? '');
      got = 'ok';
    } catch (err) {
      got = err.code ?? 'error';
      detail = err.code ? '' : String(err.message ?? err);
    }
    const said = got === 'ok' ? 'went through' : `stopped: ${got}`;
    results.push({ what, pass: got === expect, detail: `${said}${detail ? ` (${detail})` : ''}${got === expect ? '' : `; expected ${expect === 'ok' ? 'to go through' : expect}`}` });
  };
  let appIp = null;
  await check(`the app's name (${app})`, 'ok', async () => { appIp = (await resolve4(app))[0]; return appIp; });
  await check('HTTPS to the app', 'ok', () => handshake(app, app));
  await check(`a name not on the list (${outsider})`, enforce ? 'EREFUSED' : 'ok', async () => (await resolve4(outsider))[0]);
  if (enforce && appIp) {
    // The app's own address, asking for another site: Cloudflare would serve it; the check must not.
    await check(`HTTPS to the app's address, asking for ${outsider}`, 'ECONNRESET', () => handshake(appIp, outsider));
    await check("another port at the app's address (tcp/80)", 'TIMEOUT', () => tcpOpen(appIp, 80));
  }
  return results;
}

function tlsHandshake(host, servername, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername, timeout: timeoutMs }, () => { s.end(); resolve(s.getProtocol()); });
    s.on('timeout', () => s.destroy(Object.assign(new Error('no answer'), { code: 'TIMEOUT' })));
    s.on('error', reject);
  });
}

function tcpConnect(host, port, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port, timeout: timeoutMs }, () => { s.end(); resolve(''); });
    s.on('timeout', () => s.destroy(Object.assign(new Error('no answer'), { code: 'TIMEOUT' })));
    s.on('error', reject);
  });
}

/** When enforcing, a name not on the list must not resolve. If it does, the filter is not
 *  in place (its table was flushed, say). */
export async function filterInPlace(resolve4 = (h) => dnsp.resolve4(h), outsider = 'example.com') {
  try {
    await resolve4(outsider);
  } catch {
    return true;
  }
  return false;
}

const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };

/** Before any bank login: null to go ahead, or why not. Only when enforcing, so a box
 *  without the filter (or the Windows PC) is never stopped by it. */
export async function filterGuard({ stateText = readText(OUTBOUND.stateFile), resolve4 } = {}) {
  if (readState(stateText).mode !== 'enforce') return null;
  if (await filterInPlace(resolve4)) return null;
  return 'The outbound filter is not in place (a name not on its list resolved), so no bank login was opened. ' +
    'Put it back with: sudo finance-scraper outbound enforce';
}

// --- what the logs say ----------------------------------------------------------

/** { mode, since } from outbound.json; off when there is none. */
export function readState(text) {
  try {
    const s = JSON.parse(text);
    if (MODES.includes(s?.mode)) return { mode: s.mode, since: typeof s.since === 'string' ? s.since : null };
  } catch { /* none yet */ }
  return { mode: 'off', since: null };
}

const bump = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);

/** The three logs (journalctl -o cat), read into counts:
 *  dns: dnsmasq with log-queries=extra ("<serial> <client> query[A] <name> from …",
 *  "… reply <name> is <address>", "… config error is REFUSED"); kernel: this table's log
 *  lines; sni: the hostname check's "allowed …" / "refused …". */
export function readLogs({ dns = '', kernel = '', sni = '' } = {}) {
  const asked = new Map();
  const refusedNames = new Map();
  const addressNames = new Map();
  const question = new Map();
  for (const raw of dns.split('\n')) {
    const line = raw.replace(/^dnsmasq\[\d+\]:\s*/, '').trim();
    const m = line.match(/^(\d+) \S+ (query\[[\w-]+\]|reply|cached|config) (\S+)(?: (?:is|from) (.+))?$/);
    if (!m) continue;
    const [, serial, kind, name, rest = ''] = m;
    if (kind.startsWith('query')) {
      const host = normalizeHost(name) ?? name.toLowerCase();
      question.set(serial, host);
      if (/^query\[(A|AAAA)\]$/.test(kind)) bump(asked, host);
      continue;
    }
    const q = question.get(serial);
    if (!q) continue;
    // "config … is REFUSED" is this resolver's own refusal; "reply … is REFUSED" came from upstream.
    if (kind === 'config' && /^REFUSED\b/.test(rest)) bump(refusedNames, q);
    else if (net.isIP(rest)) {
      if (!addressNames.has(rest)) addressNames.set(rest, new Set());
      addressNames.get(rest).add(q);
    }
  }
  const flows = new Map();
  for (const line of kernel.split('\n')) {
    const m = line.match(/finance-scraper (out|blocked): .*?\bDST=(\S+).*?\bPROTO=(\w+)(?:.*?\bDPT=(\d+))?/);
    if (!m) continue;
    const [, verb, dst, proto, port] = m;
    const key = `${dst} ${proto.toLowerCase()}${port ? `/${port}` : ''}`;
    if (!flows.has(key)) flows.set(key, { dst, proto: proto.toLowerCase(), port: port ? Number(port) : null, out: 0, blocked: 0 });
    flows.get(key)[verb === 'out' ? 'out' : 'blocked']++;
  }
  const allowed = new Map();
  const refused = new Map();
  for (const line of sni.split('\n')) {
    let m = line.match(/^allowed (\S+)$/);
    if (m) { bump(allowed, m[1]); continue; }
    m = line.match(/^refused (.+?)(?:: not on the list)?$/);
    if (m) bump(refused, m[1]);
  }
  return { asked, refusedNames, addressNames, flows, allowed, refused };
}

const top = (map, n = 30) => [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
const more = (map, n = 30) => (map.size > n ? ` … and ${map.size - n} more` : '');

/** What `sudo finance-scraper outbound` prints: the names and connections, those not on
 *  the list first. Plain enough to paste into a message. */
export function formatReport(logs, { list, mode, since }) {
  const on = (h) => hostAllowed(h, list);
  const out = [];
  const what = { watch: 'watching (nothing is blocked)', enforce: 'blocking everything not on the list', off: 'off' }[mode];
  out.push(`Outbound filter: ${what}${since ? ` since ${since.slice(0, 16).replace('T', ' ')} UTC` : ''}.`);
  out.push(`On the list: ${list.join(', ')}`);

  const offList = new Map([...logs.asked].filter(([h]) => !on(h)));
  const onList = new Map([...logs.asked].filter(([h]) => on(h)));
  out.push('', `Names the scraper looked up: ${logs.asked.size} (${onList.size} on the list).`);
  if (offList.size) {
    out.push(mode === 'enforce' ? '  Not on the list (refused):' : '  NOT on the list (would be refused):');
    for (const [h, n] of top(offList)) out.push(`    ${h}  ×${n}`);
    if (more(offList)) out.push(`   ${more(offList)}`);
  }
  if (onList.size) out.push(`  On the list: ${top(onList, 12).map(([h, n]) => `${h} ×${n}`).join(', ')}${more(onList, 12)}`);

  const flowName = (f) => [...(logs.addressNames.get(f.dst) ?? [])];
  const noName = [];
  const notListed = [];
  const notHttps = [];
  const local = [];
  let listed = 0;
  for (const f of logs.flows.values()) {
    const names = flowName(f);
    const n = f.out + f.blocked;
    const label = `${names.length ? names.join(' / ') : f.dst} ${f.proto}${f.port ? `/${f.port}` : ''}  ×${n}${f.blocked ? ' (blocked)' : ''}`;
    if (/^(22[4-9]|23\d)\./.test(f.dst) || /^ff/i.test(f.dst)) local.push([label, n]); // multicast: mDNS, IGMP
    else if (!names.length) noName.push([label, n]);
    else if (!names.some(on)) notListed.push([label, n]);
    else if (!(f.proto === 'tcp' && f.port === 443)) notHttps.push([label, n]);
    else listed += n;
  }
  const section = (title, rows) => {
    if (!rows.length) return;
    out.push(`  ${title}:`);
    for (const [label] of rows.sort((a, b) => b[1] - a[1]).slice(0, 30)) out.push(`    ${label}`);
    if (rows.length > 30) out.push(`    … and ${rows.length - 30} more`);
  };
  out.push('', mode === 'enforce'
    ? `Connections the rules dropped (every try counts, retries too): ${logs.flows.size} destinations.`
    : `Connections it opened: ${logs.flows.size} destinations (${listed} connections to names on the list).`);
  section('To an address it never looked up', noName);
  section('To names NOT on the list', notListed);
  section('On the list, but not HTTPS', notHttps);
  section('Announcements to the local network (multicast; they never leave the machine\'s network)', local);

  if (logs.allowed.size || logs.refused.size) {
    out.push('', `The hostname check: ${[...logs.allowed.values()].reduce((a, b) => a + b, 0)} let through, ` +
      `${[...logs.refused.values()].reduce((a, b) => a + b, 0)} refused.`);
    for (const [why, n] of top(logs.refused)) out.push(`    refused ${why}  ×${n}`);
  }
  if (!logs.asked.size && !logs.flows.size) out.push('', 'Nothing in the logs yet: no scrape has run since the filter started.');
  return out.join('\n');
}

// --- command line (on the box) ----------------------------------------------------

async function main(cmd, args) {
  if (cmd === 'serve') {
    const read = () => readAllowFile(readFileSync(OUTBOUND.allowFile, 'utf8'));
    const list = read();
    const server = hostnameCheck({ list });
    process.on('SIGHUP', () => {
      const next = read();
      server.setList(next);
      console.log(`Reloaded the list: ${next.length} domains.`);
    });
    server.listen(OUTBOUND.sniPort, '127.0.0.1', () =>
      console.log(`The hostname check is on 127.0.0.1:${OUTBOUND.sniPort}; ${list.length} domains on the list.`));
    return;
  }
  throw new Error('Usage: node outbound.mjs serve   (the hostname check; finance-scraper-sni.service runs it)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2], process.argv.slice(3)).catch((err) => {
    console.error(`Error: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
