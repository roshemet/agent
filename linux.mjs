// The scraper as an unattended Linux box (Debian 13: a Google Cloud VM, or a mini-PC at
// home). What the household's Windows PC did with DPAPI, Task
// Scheduler and the Startup folder is done here with systemd:
//
//   - the vault opens with a random key that setup SEALS to this machine's TPM
//     (systemd-creds). systemd hands it to the scraper's services only; a copy of
//     the disk or a snapshot cannot open it. Root on the running machine can, as
//     anyone logged in as the household could with DPAPI;
//   - finance-scraper-listen.service is the 🏦 listener, -daily.timer the daily run;
//   - every command typed on the box goes through `sudo finance-scraper …`, which
//     runs the scraper exactly as the services do (same user, same sealed key, same
//     limits), so the key never passes through anyone's shell.
//
// Pure functions that build file contents and command lines, testable anywhere;
// box.mjs (run as root on the box) applies them. Nothing here touches the system.

export const BOX = Object.freeze({
  user: 'finance-scraper',
  repoDir: '/opt/finance-scraper', // a git checkout, root-owned: read-only to the scraper
  scrapeDir: '/opt/finance-scraper/scripts/scrape',
  stateDir: '/var/lib/finance-scraper', // the vault, logs and locks (systemd StateDirectory)
  vault: '/var/lib/finance-scraper/scraper-vault.json',
  credName: 'vault-key',
  credFile: '/etc/credstore.encrypted/finance-scraper.vault-key',
  node: '/opt/node/bin/node',
  npm: '/opt/node/bin/npm',
  chromium: '/usr/bin/chromium', // Debian's, kept patched by the daily security updates
  wrapper: '/usr/local/sbin/finance-scraper',
  unitDir: '/etc/systemd/system',
  listenUnit: 'finance-scraper-listen.service',
  dailyUnit: 'finance-scraper-daily.service',
  dailyTimer: 'finance-scraper-daily.timer',
  dailyAt: '09:00', // Israel time; the Worker's missed-run alarm assumes this hour
  sysctlFile: '/etc/sysctl.d/60-finance-scraper.conf',
  deployKey: '/root/.ssh/finance-cloud-deploy',
  // The family's app address, kept by root for the outbound filter's list (setup, set-endpoint; a box set up
  // before this file existed reads it from its own vault once). No address is built in.
  appFile: '/etc/finance-scraper/app.json',
  filterUnit: 'finance-scraper-outbound.service', // the outbound filter's rules (outbound.mjs)
});

/** systemd properties shared by both services AND every `sudo finance-scraper` command,
 *  so a command typed on the box runs exactly as the service does. Each hardening line
 *  was checked to keep Chrome's own sandbox working (VM_SCRAPER_HANDOFF.md); setup runs
 *  Chromium under exactly this list before anything else and stops if it fails.
 *  `filtered` (the outbound filter is on): names are looked up only through DNS, which
 *  the filter sends to the scraper's own resolver, not through systemd-resolved's socket
 *  or the system bus, which would ask the machine's resolver directly. */
export function serviceProperties(box = BOX, { filtered = false } = {}) {
  const filter = filtered ? [
    ['InaccessiblePaths', '-/run/systemd/resolve/io.systemd.Resolve'],
    ['InaccessiblePaths', '-/run/systemd/resolve/io.systemd.Resolve.Monitor'],
    ['InaccessiblePaths', '-/run/dbus/system_bus_socket'],
  ] : [];
  return [
    ['User', box.user],
    ['Group', box.user],
    ['LoadCredentialEncrypted', `${box.credName}:${box.credFile}`],
    ['Environment', `HOME=${box.stateDir}`],
    ['Environment', `FINANCE_SCRAPER_CHROME=${box.chromium}`],
    ['Environment', 'PUPPETEER_SKIP_DOWNLOAD=1'],
    ['StateDirectory', 'finance-scraper'],
    ['StateDirectoryMode', '0700'],
    ['WorkingDirectory', box.stateDir],
    ['UMask', '0077'],
    ['NoNewPrivileges', 'yes'],
    ['ProtectSystem', 'strict'],
    ['ProtectHome', 'yes'],
    ['PrivateTmp', 'yes'], // Chrome's profile lives in /tmp: private to the run, gone after
    ['ProtectKernelTunables', 'yes'],
    ['ProtectKernelModules', 'yes'],
    ['ProtectKernelLogs', 'yes'],
    ['ProtectControlGroups', 'yes'],
    ['ProtectClock', 'yes'],
    ['ProtectHostname', 'yes'],
    ['ProtectProc', 'invisible'],
    ['RestrictSUIDSGID', 'yes'],
    ['RestrictRealtime', 'yes'],
    ['LockPersonality', 'yes'],
    // Chrome's sandbox makes user, pid and net namespaces; RestrictNamespaces=yes kills it.
    ['RestrictNamespaces', 'user pid net'],
    ['SystemCallArchitectures', 'native'],
    // @system-service alone kills Chrome: its sandbox needs chroot, and Chrome 148+ uses
    // memory protection keys. EPERM, not SIGSYS, if anything else is ever refused.
    ['SystemCallFilter', '@system-service chroot @pkey'],
    ['SystemCallErrorNumber', 'EPERM'],
    ['CapabilityBoundingSet', ''],
    ['LimitCORE', '0'], // a core dump would hold the logins
    // Not MemoryDenyWriteExecute: it kills Node's (and Chrome's) JavaScript engine.
    ...filter,
  ];
}

const propLines = (box, mode) => serviceProperties(box, { filtered: mode !== 'off' }).map(([k, v]) => `${k}=${v}`).join('\n');

/** [Unit] lines for the outbound filter (`mode`: off | watch | enforce). Enforcing, the
 *  scraper does not start without the filter's rules; watching, it only waits for them. */
export function filterDeps(mode, box = BOX) {
  if (mode === 'enforce') return `Requires=${box.filterUnit}\nAfter=${box.filterUnit}\n`;
  if (mode === 'watch') return `Wants=${box.filterUnit}\nAfter=${box.filterUnit}\n`;
  return '';
}
const scrapeCmd = (box, ...args) => [box.node, `${box.scrapeDir}/scrape.mjs`, ...args, '--vault', box.vault].join(' ');

/** The 🏦 listener. It sleeps through Shabbat and Yom Tov itself; systemd restarts it
 *  15 minutes after anything else stops it (a refused token, a crash), for ever. */
export function listenUnit(box = BOX, mode = 'off') {
  return `[Unit]
Description=finance-cloud scraper: listens for scrape requests from the group
Wants=network-online.target time-sync.target
After=network-online.target time-sync.target
StartLimitIntervalSec=0
${filterDeps(mode, box)}
[Service]
Type=simple
ExecStart=${scrapeCmd(box, 'poll')}
Restart=always
RestartSec=15min
${propLines(box, mode)}

[Install]
WantedBy=multi-user.target
`;
}

/** The daily scrape, sent for approval. Skips Shabbat and Yom Tov itself (run --auto). */
export function dailyUnit(box = BOX, mode = 'off') {
  return `[Unit]
Description=finance-cloud scraper: the daily scrape (sent for approval)
Wants=network-online.target time-sync.target
After=network-online.target time-sync.target
${filterDeps(mode, box)}
[Service]
Type=oneshot
ExecStart=${scrapeCmd(box, 'run', '--auto', '--daily')}
TimeoutStartSec=1h
${propLines(box, mode)}
`;
}

export function dailyTimer(box = BOX) {
  return `[Unit]
Description=finance-cloud scraper: every day at ${box.dailyAt} Israel time (not on Shabbat or Yom Tov)

[Timer]
OnCalendar=*-*-* ${box.dailyAt}:00 Asia/Jerusalem
Persistent=true

[Install]
WantedBy=timers.target
`;
}

/** /usr/local/sbin/finance-scraper. */
export function wrapperScript(box = BOX) {
  return `#!/bin/sh
# finance-scraper: the bank scraper on this box. Run as: sudo finance-scraper <command>
# (setup, pair, add-login, map, run, start, stop, status, update; see scripts/scrape/README.md)
exec ${box.node} ${box.scrapeDir}/box.mjs "$@"
`;
}

/** systemd-run arguments that run `scrape.mjs <args>` as the services do. With a
 *  terminal (`tty`), prompts work (hidden ones too); without one, input is piped. */
export function runArgs(args, { tty, filtered = false }, box = BOX) {
  const props = serviceProperties(box, { filtered }).flatMap(([k, v]) => ['-p', `${k}=${v}`]);
  return ['--quiet', '--wait', '--collect', '--service-type=exec', tty ? '--pty' : '--pipe', ...props,
    box.node, `${box.scrapeDir}/scrape.mjs`, ...args, '--vault', box.vault];
}

/** `systemd-creds encrypt` arguments. The key goes in on stdin ('-'), never on a command
 *  line (other processes can read those). Explicitly host+tpm2: 'auto' quietly falls
 *  back to the host key alone when Debian's TPM libraries are missing, and a host-key
 *  credential opens from any copy of the disk. No PCRs: a kernel or firmware update
 *  must not lock the box out (on Google Cloud, Secure Boot state adds little anyway). */
export function sealArgs(credFile = BOX.credFile, box = BOX) {
  return ['encrypt', '--with-key=host+tpm2', '--tpm2-pcrs=', `--name=${box.credName}`, '-', credFile];
}

/** systemd-run arguments that read a sealed credential back exactly as the services
 *  will: same user, same LoadCredentialEncrypted line. Prints the key to OUR pipe only. */
export function unsealCheckArgs(credFile = BOX.credFile, box = BOX) {
  return ['--quiet', '--wait', '--collect', '--pipe', '-p', `User=${box.user}`,
    '-p', `LoadCredentialEncrypted=${box.credName}:${credFile}`,
    '/usr/bin/systemd-creds', 'cat', '--newline=no', box.credName];
}

// Debian 13's systemd 257 explains TPM trouble in ways that mislead (checked against
// its own binary). Each line: what the household should read instead, and what to do.
const CRED_HINTS = [
  [/AES-128-CFB missing|TPM2 support not installed/i,
    'The TPM libraries are not installed (Debian only suggests them). Run the setup again: ' +
    'sudo bash /opt/finance-scraper/scripts/scrape/linux/setup-debian.sh'],
  [/TCTI driver not available/i,
    'One TPM library is missing (libtss2-tcti-device). Run the setup again: ' +
    'sudo bash /opt/finance-scraper/scripts/scrape/linux/setup-debian.sh'],
  [/State not recoverable|Failed to open specified TCTI device file|tpmrm0|TPM device not found|No TPM2/i,
    'This machine has no usable TPM. On Google Cloud: stop the VM, turn on vTPM ' +
    '(gcloud compute instances update finance-scraper --zone=me-west1-a --shielded-vtpm), start it, ' +
    'and run the setup again. On a mini-PC: turn on the TPM ("PTT") in the BIOS.'],
  [/Embedded credential name .* does not match/i,
    'The sealed key carries a different name than the services expect. Run: sudo finance-scraper setup --new-key'],
  [/Failed to determine local credential key|credential\.secret|machine-id/i,
    'This machine\'s identity changed (re-imaged, cloned, or a new machine-id), so the sealed key cannot be ' +
    'opened any more. Run: sudo finance-scraper setup --new-key, then pair again and type the logins again.'],
  [/time passed/i, 'The sealed key has expired. Run: sudo finance-scraper setup --new-key'],
];

/** A sentence for a systemd-creds / systemd-run failure: the cause and what to do. */
export function explainCredError(text) {
  const raw = String(text ?? '').trim();
  const first = raw.split('\n').find((l) => l.trim()) ?? '(no message)';
  const hint = CRED_HINTS.find(([re]) => re.test(raw))?.[1] ??
    'The sealed vault key could not be used. Run: sudo finance-scraper status (it checks each part).';
  return `${hint}\n(systemd said: ${first.trim()})`;
}

/** Seal `key` into `credFile` and prove the services can read it back unchanged.
 *  `run(cmd, args, { input })` → { status, stdout, stderr } (spawnSync; injected for
 *  tests). On any failure the half-made credential is removed and nothing else changes. */
export function sealAndVerify(key, { run, removeFile, credFile = BOX.credFile }, box = BOX) {
  if (!key || String(key).length < 32) throw new Error('Refusing to seal a key shorter than 32 characters.');
  const enc = run('systemd-creds', sealArgs(credFile, box), { input: key });
  if (enc.status !== 0) {
    removeFile(credFile);
    throw new Error(explainCredError(enc.stderr || enc.stdout));
  }
  const back = run('systemd-run', unsealCheckArgs(credFile, box), {});
  if (back.status !== 0 || back.stdout !== key) {
    removeFile(credFile);
    throw new Error(back.status !== 0 ? explainCredError(back.stderr || back.stdout)
      : 'The sealed key did not come back unchanged through systemd, so nothing was kept. Run the setup again.');
  }
}

/** The TPM libraries systemd loads at run time (Debian only suggests their packages).
 *  `systemd-analyze has-tpm2` does not notice the last one missing, so check by name. */
export const TPM_LIBS = ['libtss2-esys.so.0', 'libtss2-rc.so.0', 'libtss2-mu.so.0', 'libtss2-tcti-device.so.0'];

/** Which TPM libraries `ldconfig -p` does not list. */
export function missingTpmLibs(ldconfigP) {
  return TPM_LIBS.filter((lib) => !String(ldconfigP ?? '').includes(lib));
}

/** Is Node `version` ("22.22.0" or "v24.21.0") older than `min`? */
export function nodeTooOld(version, min = '22.22.2') {
  const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  const [a, b] = [parse(version), parse(min)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** sysctl drop-in. Debian ships Yama switched off, which lets any process read the
 *  memory of others running as the same user: Chrome could read the scraper's. */
export const SYSCTL_CONF = '# finance-scraper: a process may only read the memory of its own children\nkernel.yama.ptrace_scope = 1\n';

/** Set `key = value` lines inside `[section]` of an INI text, adding the section if needed. */
export function setIni(text, section, values) {
  const lines = String(text ?? '').trim() ? String(text).split('\n') : [];
  let start = lines.findIndex((l) => l.trim().toLowerCase() === `[${section.toLowerCase()}]`);
  if (start < 0) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`[${section}]`);
    start = lines.length - 1;
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  while (end > start + 1 && lines[end - 1].trim() === '') end--; // new keys go before blank lines
  for (const [k, v] of Object.entries(values)) {
    const i = lines.findIndex((l, j) => j > start && j < end && new RegExp(`^\\s*${k}\\s*=`, 'i').test(l));
    if (i >= 0) lines[i] = `${k} = ${v}`;
    else { lines.splice(end, 0, `${k} = ${v}`); end++; }
  }
  return lines.join('\n').replace(/\n*$/, '\n');
}

/** Google's guest agent runs "startup/shutdown scripts" from the VM's metadata as root:
 *  anyone who can edit that metadata could run code as root here. Switch that off. */
export function hardenGuestAgent(instanceConfigsText) {
  return setIni(instanceConfigsText, 'MetadataScripts', { startup: 'false', shutdown: 'false' });
}

/** A warning if the machine has swap: the scraper's memory (the logins, while scraping)
 *  could be written to disk. Google Cloud's Debian images have none. */
export function swapWarning(procSwaps) {
  const devices = String(procSwaps ?? '').trim().split('\n').slice(1).filter((l) => l.trim());
  if (!devices.length) return null;
  return `This machine has swap (${devices.map((l) => l.split(/\s+/)[0]).join(', ')}): the scraper's memory could be written ` +
    'to disk. Turn swap off, or keep it inside the encrypted disk (a mini-PC).';
}
