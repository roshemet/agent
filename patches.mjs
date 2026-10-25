// Local fixes to israeli-bank-scrapers, applied to the installed copy before a
// run. Each patch is an exact text replacement tied to ONE library version: if
// the version or the text differs, nothing is touched and the run says so. After
// bumping the library, re-check every patch here (upstream may have fixed it).

export const PATCHES = [
  {
    id: 'fibi-optional-balance',
    company: 'beinleumi',
    version: '6.12.2',
    file: 'lib/scrapers/base-beinleumi-group.js',
    why: 'Fibi no longer always shows `.main_balance`; 6.12.2 waits 10 s for it and fails the whole scrape ' +
      '(GENERIC "Waiting for selector `.main_balance` failed"). The transactions matter more: without the balance the ' +
      'scrape goes on, and the app checks the ledger against the balance only when Fibi shows it.',
    original:
      'async function getCurrentBalance(page) {\n' +
      '  // Wait for the balance element to appear and be visible\n' +
      '  await (0, _elementsInteractions.waitUntilElementFound)(page, CURRENT_BALANCE, true, ELEMENT_RENDER_TIMEOUT_MS);\n',
    patched:
      'async function getCurrentBalance(page) {\n' +
      '  // finance-cloud patch fibi-optional-balance: a missing balance must not fail the scrape.\n' +
      '  try {\n' +
      '    await (0, _elementsInteractions.waitUntilElementFound)(page, CURRENT_BALANCE, true, ELEMENT_RENDER_TIMEOUT_MS);\n' +
      '  } catch (e) {\n' +
      '    return undefined;\n' +
      '  }\n',
  },
];

/** Pure: apply one patch to a file's text. */
export function applyPatch(text, patch, installedVersion) {
  if (text.includes(patch.patched)) return { status: 'already', text };
  if (installedVersion !== patch.version) return { status: 'version', text };
  const n = text.split(patch.original).length - 1;
  if (n !== 1) return { status: 'mismatch', text };
  return { status: 'applied', text: text.replace(patch.original, patch.patched) };
}

/** Patch the installed library in place. Returns one line per patch for the log.
 *  On a Linux box the library is root-owned and read-only to the scraper: setup and
 *  `finance-scraper update` patch it as root, and a run only finds the patches in
 *  place. If one is missing there, the run says so and goes on, as for a version
 *  mismatch. (`writeFile` is injectable for tests, which run as root.) */
export async function ensurePatched(libDir, { writeFile } = {}) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const write = writeFile ?? writeFileSync;
  const version = JSON.parse(readFileSync(join(libDir, 'package.json'), 'utf8')).version;
  const out = [];
  for (const p of PATCHES) {
    const path = join(libDir, p.file);
    const r = applyPatch(readFileSync(path, 'utf8'), p, version);
    if (r.status === 'applied') {
      try {
        write(path, r.text);
      } catch (e) {
        if (!['EACCES', 'EPERM', 'EROFS'].includes(e?.code)) throw e;
        out.push(`Patch ${p.id} is not applied and the library is read-only here: ${p.company} may fail as before. ` +
          'On the box, run: sudo finance-scraper update');
      }
    }
    if (r.status === 'version' || r.status === 'mismatch') {
      out.push(`Patch ${p.id} NOT applied (library ${version}, patch is for ${p.version}${r.status === 'mismatch' ? ', text differs' : ''}): ` +
        `${p.company} may fail as before. Re-check scripts/scrape/patches.mjs.`);
    }
  }
  return out;
}
