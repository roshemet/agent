// The agent on a family's own computer, Windows or Mac (SINGLE_FAMILY_PLAN S4). What the Linux box does
// with its TPM and systemd (linux.mjs), a computer does with:
//
//   - Windows: DPAPI (a file only this Windows account can open; lib.mjs protectKey) for the vault key,
//     Task Scheduler for the daily run, and the Startup folder plus a 15-minute task for the 🏦 listener;
//   - Mac: the Keychain (`security`) for the vault key, and launchd for both (two LaunchAgents in
//     ~/Library/LaunchAgents).
//
// The vault key is random (setup makes it), so nobody types or keeps a passphrase. It never goes on a
// command line, which other processes can read: it reaches `security` and PowerShell through stdin.
// Pure builders, plus a few functions that take the program runner, so tests drive them anywhere.

import { createHash } from 'node:crypto';

export const AGENT = Object.freeze({
  name: 'roshemet-agent',
  dailyTask: 'roshemet-agent-daily', // Windows Task Scheduler: the daily run
  listenTask: 'roshemet-agent-listen', // Windows: restarts the listener every 15 minutes if it stopped
  startupLauncher: 'roshemet-agent-listen.vbs', // Windows: starts the listener at logon
  dailyLabel: 'org.roshemet.agent.daily', // Mac launchd
  listenLabel: 'org.roshemet.agent.listen',
  keychainService: 'roshemet-agent',
  dailyAt: '09:00', // the box's hour too (linux.mjs); the app's missed-run alarm counts on the morning
});

// --- the vault key on a Mac: the Keychain -------------------------------------

/** The Keychain item for one vault (one per vault file, so two vaults never share a key). */
export function keychainAccount(vaultPath) {
  return `vault-${createHash('sha256').update(String(vaultPath)).digest('hex').slice(0, 16)}`;
}

/** The key setup makes: randomBytes(32).toString('base64url'). Nothing else is ever stored. */
const RANDOM_KEY = /^[A-Za-z0-9_-]{32,}$/;

/** What `security -i` reads on stdin to store the key, so it is never on a command line. */
export function keychainAddInput(secret, vaultPath, o = AGENT) {
  if (!RANDOM_KEY.test(String(secret ?? ''))) throw new Error('Refusing to store anything but a random vault key in the Keychain.');
  return `add-generic-password -U -s ${o.keychainService} -a ${keychainAccount(vaultPath)} ` +
    `-l "Roshemet agent - the key to the bank logins vault" -w ${secret}\n`;
}
export const keychainFindArgs = (vaultPath, o = AGENT) => ['find-generic-password', '-s', o.keychainService, '-a', keychainAccount(vaultPath), '-w'];
export const keychainDeleteArgs = (vaultPath, o = AGENT) => ['delete-generic-password', '-s', o.keychainService, '-a', keychainAccount(vaultPath)];

/** What a failed `security` call means, and what to do. */
export function explainKeychain(r) {
  const text = `${r?.stderr ?? ''}${r?.stdout ?? ''}`;
  if (r?.status === 127 || /ENOENT/.test(text)) return 'The Mac\'s `security` program was not found: this command is for macOS.';
  if (r?.status === 44 || /could not be found/i.test(text)) {
    return 'The Keychain has no key for this vault (it was removed, or this is another Mac user). ' +
      'Run setup again; if the key is gone, the vault cannot be opened and the logins must be added again.';
  }
  if (r?.status === 36 || /interaction is not allowed|locked/i.test(text)) {
    return 'The Mac\'s Keychain is locked. Log in to the Mac (or unlock "login" in Keychain Access) and run it again.';
  }
  return `The Keychain refused (exit ${r?.status ?? '?'}): ${text.trim().split('\n')[0] || 'no message'}`;
}

/** The key, back from the Keychain. `run(program, args, { input })` → { status, stdout, stderr }. */
export function keychainLoad(vaultPath, run, o = AGENT) {
  const r = run('security', keychainFindArgs(vaultPath, o), {});
  if (r.status !== 0) throw new Error(explainKeychain(r));
  return String(r.stdout).replace(/\r?\n$/, '');
}

/** Store the key and prove it comes back unchanged; on any failure the item is removed again. */
export function keychainSave(secret, vaultPath, run, o = AGENT) {
  run('security', ['-i'], { input: keychainAddInput(secret, vaultPath, o) }); // `-i` answers on stdout, errors too: the read below decides
  let back;
  try {
    back = keychainLoad(vaultPath, run, o);
  } catch (err) {
    run('security', keychainDeleteArgs(vaultPath, o), {});
    throw err;
  }
  if (back !== secret) {
    run('security', keychainDeleteArgs(vaultPath, o), {});
    throw new Error('The Keychain did not give the key back unchanged, so nothing was kept. Run setup again.');
  }
}

export function keychainRemove(vaultPath, run, o = AGENT) {
  const r = run('security', keychainDeleteArgs(vaultPath, o), {});
  return r.status === 0;
}

// --- the daily run and the listener on a Mac: launchd ---------------------------

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dirOf = (p) => String(p).replace(/[\\/][^\\/]*$/, '') || '/';

function plist(label, { programArgs, logPath, workDir, extra }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(workDir)}</string>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
${extra}
</dict>
</plist>
`;
}

const timeOf = (at) => {
  const m = String(at ?? '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) throw new Error('The time must be HH:MM (24-hour), for example 09:00.');
  return { hour: Number(m[1]), minute: Number(m[2]) };
};

/** The daily run, at `at` local time. It skips Shabbat and Yom Tov itself (run --auto); a Mac asleep at that
 *  hour runs it when it wakes. */
export function dailyPlist({ node, script, vault, logPath }, at = AGENT.dailyAt, o = AGENT) {
  const { hour, minute } = timeOf(at);
  return plist(o.dailyLabel, {
    programArgs: [node, script, 'run', '--auto', '--daily', '--vault', vault], logPath, workDir: dirOf(vault),
    extra: `  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`,
  });
}

/** The 🏦 listener: starts at login, sleeps through Shabbat and Yom Tov itself, and is started again 15 minutes
 *  after anything but a requested stop ends it (a refused token, a crash), as on the box. */
export function listenPlist({ node, script, vault, logPath }, o = AGENT) {
  return plist(o.listenLabel, {
    programArgs: [node, script, 'poll', '--vault', vault], logPath, workDir: dirOf(vault),
    extra: `  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>900</integer>`,
  });
}

export const launchctlArgs = Object.freeze({
  bootstrap: (uid, plistPath) => ['bootstrap', `gui/${uid}`, plistPath],
  bootout: (uid, label) => ['bootout', `gui/${uid}/${label}`],
  print: (uid, label) => ['print', `gui/${uid}/${label}`],
});

/** "running", "waiting" … from `launchctl print` (only the state: its other lines name the user's folders). */
export function launchdState(printOut) {
  return String(printOut ?? '').match(/^\s*state = (\S+)/m)?.[1] ?? null;
}

// --- the daily run on Windows: Task Scheduler ------------------------------------

/** The .cmd the daily task starts (through a hidden launcher, so no window opens). */
export function dailyCmd({ nodePath, scriptPath, vaultPath, logPath }) {
  return ['@echo off', `"${nodePath}" "${scriptPath}" run --auto --daily --vault "${vaultPath}" >> "${logPath}" 2>&1`, ''].join('\r\n');
}

/** Every day at `at`; the run skips Shabbat and Yom Tov itself. Starts the hidden launcher (`vbsPath`). */
export function schtasksDailyArgs(vbsPath, at = AGENT.dailyAt, o = AGENT) {
  timeOf(at);
  const target = /\s/.test(vbsPath) ? `"${vbsPath}"` : vbsPath;
  return ['/Create', '/F', '/TN', o.dailyTask, '/SC', 'DAILY', '/ST', at, '/TR', `wscript.exe //B //Nologo ${target}`];
}

export const schtasksQueryArgs = (name) => ['/Query', '/TN', name, '/FO', 'CSV', '/NH'];

/** From `schtasksQueryArgs`: "\name","next run","status", the same columns in every Windows language. Only
 *  these two (the verbose listing names the Windows user). */
export function schtasksState(csvOut) {
  const line = String(csvOut ?? '').split(/\r?\n/).find((l) => l.trim());
  const cells = line ? [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')) : [];
  return cells.length >= 3 ? { next: cells[1] || null, status: cells[2] || null } : { next: null, status: null };
}
