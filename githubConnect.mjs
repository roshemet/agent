// `github-connect` (SINGLE_FAMILY_PLAN S5): on the computer or box that keeps a family's logins, one command sets
// up the family's own GitHub repo (private, made from the Roshemet template) to run the agent:
//   1. checks first, changing nothing: the token, the repo (private, from the template), the permissions, the app;
//   2. each login from the vault into the repo's secret LOGIN_<COMPANY>, encrypted here with the repo's own public
//      key (a libsodium sealed box, as GitHub requires: only GitHub can open it), then the app's address and the
//      account map into the variables ROSHEMET_APP and ROSHEMET_MAP;
//   3. pairs the repo with the app (the dashboard's code): the repo's own review-only token goes straight into the
//      secret ROSHEMET_TOKEN and is never shown. A repo that has one keeps it, unless a new code is given;
//   4. starts GitHub's check (days 0: no bank) and then a first run, waits for each, and says what GitHub said.
// The GitHub token is typed once, used in memory and kept nowhere.
//
// Everything that leaves this machine goes through `gh` (GitHub's API) and `pair` (the app), passed in; the
// sealed box comes from `seal`. scrape.mjs gives the real ones, the tests stand-ins.

import { loginSecretName, TOKEN_SECRET, APP_VARIABLE, MAP_VARIABLE, LOGIN_PREFIX } from './github.mjs';

export const WORKFLOW = 'agent.yml';

/** "cohen-family/roshemet-agent", from that or the repo's address. Null if it is neither. */
export function cleanRepo(raw) {
  const m = String(raw ?? '').trim().match(/^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/);
  return m && m[2] !== '.' && m[2] !== '..' ? `${m[1]}/${m[2]}` : null;
}

/** GitHub's page that makes the token, filled in: its name, 7 days, and the three permissions it needs. The person
 *  still picks the repo ("Only select repositories"): GitHub's link cannot. */
export function tokenLink(repo) {
  const [owner] = repo.split('/');
  const q = new URLSearchParams({
    name: 'roshemet-connect', description: `github-connect for ${repo}: once, then delete it`, target_name: owner,
    expires_in: '7', actions: 'write', secrets: 'write', actions_variables: 'write',
  });
  return `https://github.com/settings/personal-access-tokens/new?${q}`;
}

export function tokenSteps(repo) {
  return [
    'A GitHub token, for this once (it is kept nowhere; delete it on GitHub afterwards if you like):',
    `  1. Open this link (signed in to GitHub): ${tokenLink(repo)}`,
    `  2. Under "Repository access" choose "Only select repositories" and pick ${repo}.`,
    '  3. Press "Generate token", copy it, and paste it here.',
  ].join('\n');
}

/** A refusal from GitHub, said for a person: what is wrong and what to do. `step`: what was being asked. */
export function explainGithub(step, status, repo, body = {}) {
  const fix = (perm) => `The token cannot ${perm} in ${repo}. On GitHub: Settings → Developer settings → Fine-grained tokens → ` +
    `roshemet-connect → Repository permissions, set it to "Read and write" (or make a new token with the link above), then run github-connect again.`;
  if (status === 401) return 'GitHub does not accept this token (it expired, or was not copied whole). Make a new one with the link above.';
  if (status === 0) return `Could not reach GitHub (api.github.com): ${body.message ?? 'no answer'}. Check this machine is online, then run github-connect again.`;
  if (step === 'repo' && (status === 404 || status === 403)) {
    return `This token cannot see ${repo}. When making it, choose "Only select repositories" and pick ${repo} (or check the name: owner/repo).`;
  }
  if (step === 'workflow' && status === 404) {
    return `${repo} has no .github/workflows/${WORKFLOW}: it must be made from the Roshemet template (on GitHub: the template's page → "Use this template").`;
  }
  if (status === 403 || status === 404) {
    const perm = { secrets: 'read or write secrets ("Secrets")', variables: 'read or write variables ("Variables")', actions: 'start or read runs ("Actions")' }[step];
    if (perm) return fix(perm);
  }
  if (status === 422 && step === 'actions') return `GitHub refused to start the run: ${body.message ?? 'unprocessable'}.`;
  return `GitHub refused (${step}): HTTP ${status} ${body.message ?? ''}`.trim();
}

export class GithubRefused extends Error {}

/** The secrets to write: each login of the vault the library knows (its fields as JSON), and the companies it does not. */
export function secretsPlan(config, companies) {
  const writes = [];
  const unknown = [];
  for (const [company, creds] of Object.entries(config.logins ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!companies?.[company]) { unknown.push(company); continue; }
    const clean = Object.fromEntries(Object.entries(creds ?? {}).filter(([, v]) => typeof v === 'string' && v !== ''));
    writes.push({ company, name: loginSecretName(company), value: JSON.stringify(clean) });
  }
  return { writes, unknown };
}

/** LOGIN_* secrets the repo has and this vault does not: left as they are, and said. */
export function extraLoginSecrets(existing, writes) {
  const ours = new Set(writes.map((w) => w.name));
  return existing.filter((n) => n.startsWith(LOGIN_PREFIX) && !ours.has(n)).sort();
}

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z /;
const WORTH = /^(✓|✗|⚠|- )|: scraping \d+ days…|skipped|Sent for approval|Nothing new|Not running|Error:|No login got through|is not mapped|This repo is public/;

/** What a run's log says that a person needs: the agent's ✓/✗ lines, failures and the outcome. GitHub's log shows
 *  every masked value as ***; nothing else of the log is shown. */
export function logLines(text, max = 30) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.replace(TIMESTAMP, '').trimEnd())
    .filter((l) => l && !l.startsWith('::') && !l.startsWith('##[') && WORTH.test(l.trim()))
    .map((l) => l.trim()).slice(0, max);
}

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

/**
 * Connect `repo`: checks, logins, variables, pairing, the check on GitHub and a first run.
 * @param {object} d
 * @param {string} d.repo  owner/name
 * @param {{ endpoint: string, logins: object, map: object }} d.config  the vault's
 * @param {object} d.companies  the library's SCRAPERS
 * @param {(method: string, path: string, body?: object) => Promise<{ status: number, body: any, text?: string }>} d.gh
 * @param {(publicKeyB64: string, value: string) => string} d.seal
 * @param {() => Promise<string>} d.pair  pairs the repo with the app; the token it gave
 * @param {boolean} d.newPairing  pair even if the repo has a token (a code was given)
 * @param {(line: string) => void} d.log
 * @param {number} [d.days]  the first run's days; 0: no first run
 */
export async function connectRepo({ repo, config, companies, gh, seal, pair, newPairing = false, log, days = 45,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), waits = { start: 180_000, check: 15 * 60_000, run: 30 * 60_000 } }) {
  const ask = async (step, method, path, body, ok = [200]) => {
    const r = await gh(method, path, body);
    if (!ok.includes(r.status)) throw new GithubRefused(explainGithub(step, r.status, repo, r.body ?? {}));
    return r;
  };
  const plan = secretsPlan(config, companies);
  if (!plan.writes.length) throw new Error('This vault has no logins the agent knows: add them first (add-login), then run github-connect again.');
  if (plan.unknown.length) log(`  ⚠ Not sent (the agent does not know these companies): ${plan.unknown.join(', ')}`);

  // 1. Checks; nothing changes until all pass.
  const info = (await ask('repo', 'GET', `/repos/${repo}`)).body;
  if (info.private !== true) {
    throw new GithubRefused(`${repo} is public: anyone could read its runs' logs. Make it private first (on GitHub: Settings → General → Danger Zone → Change visibility), then run github-connect again.`);
  }
  await ask('workflow', 'GET', `/repos/${repo}/actions/workflows/${WORKFLOW}`);
  const key = (await ask('secrets', 'GET', `/repos/${repo}/actions/secrets/public-key`)).body;
  const existing = (await ask('secrets', 'GET', `/repos/${repo}/actions/secrets?per_page=100`)).body?.secrets?.map((s) => s.name) ?? [];
  const vars = (await ask('variables', 'GET', `/repos/${repo}/actions/variables?per_page=30`)).body?.variables?.map((v) => v.name) ?? [];
  // Turning the workflow on is a write that changes nothing when it is on: it proves "Actions: Read and write" now.
  await ask('actions', 'PUT', `/repos/${repo}/actions/workflows/${WORKFLOW}/enable`, undefined, [204]);
  log(`  ✓ GitHub accepts the token; ${repo} is private and made from the template.`);

  // 2. The logins (sealed here with the repo's key), then the variables.
  for (const w of plan.writes) {
    await ask('secrets', 'PUT', `/repos/${repo}/actions/secrets/${w.name}`, { encrypted_value: seal(key.key, w.value), key_id: key.key_id }, [201, 204]);
  }
  log(`  ✓ Logins in the repo's secrets, encrypted on this machine with the repo's key: ${plan.writes.map((w) => w.company).join(', ')}.`);
  const extra = extraLoginSecrets(existing, plan.writes);
  if (extra.length) log(`  ⚠ The repo also has ${extra.join(', ')}, which this vault does not: left as it is (remove it on GitHub: Settings → Secrets and variables → Actions).`);
  const setVariable = async (name, value) => {
    if (vars.includes(name)) await ask('variables', 'PATCH', `/repos/${repo}/actions/variables/${name}`, { name, value }, [204]);
    else await ask('variables', 'POST', `/repos/${repo}/actions/variables`, { name, value }, [201]);
  };
  await setVariable(APP_VARIABLE, config.endpoint);
  await setVariable(MAP_VARIABLE, JSON.stringify(config.map ?? {}));
  log(`  ✓ Your app's address and the account map (${Object.keys(config.map ?? {}).length} accounts) are in the repo's variables.`);

  // 3. The repo's own pairing with the app.
  if (newPairing || !existing.includes(TOKEN_SECRET)) {
    const token = await pair();
    await ask('secrets', 'PUT', `/repos/${repo}/actions/secrets/${TOKEN_SECRET}`, { encrypted_value: seal(key.key, token), key_id: key.key_id }, [201, 204]);
    log('  ✓ The repo is paired with your app: its own token (review only) is in the repo\'s secrets; it was never shown.');
  } else {
    log('  ✓ The repo was paired with your app before; GitHub\'s check below proves the app still accepts it.');
  }

  // 4. GitHub's check, then a first run.
  const branch = info.default_branch || 'main';
  log('\nStarting GitHub\'s check (no bank is signed in to; about two minutes)…');
  const check = await dispatchAndWait({ gh: ask, repo, branch, inputs: { days: '0' }, what: 'check', limit: waits.check, waits, sleep, now, log });
  for (const l of check.lines) log(`    ${l}`);
  if (check.run.conclusion !== 'success') {
    throw new GithubRefused(`GitHub's check did not pass (${check.run.conclusion}): the ✗ lines above say why. The run: ${check.run.html_url}`);
  }
  log('  ✓ GitHub\'s check passed.');
  if (!days) return { check: check.run, first: null };
  log(`\nStarting the first run from GitHub (it signs in to each bank, ${days} days back; a few minutes)…`);
  const first = await dispatchAndWait({ gh: ask, repo, branch, inputs: { days: String(days) }, what: 'first run', limit: waits.run, waits, sleep, now, log });
  for (const l of first.lines) log(`    ${l}`);
  if (first.run.conclusion !== 'success') {
    throw new GithubRefused(`The first run from GitHub did not pass (${first.run.conclusion}): the lines above say why. The run: ${first.run.html_url}`);
  }
  log('  ✓ The first run from GitHub reached your app.');
  return { check: check.run, first: first.run };
}

/** Start agent.yml with `inputs`, find the run it made, wait for it to finish, and read what its log says. */
export async function dispatchAndWait({ gh, repo, branch, inputs, what, limit, waits, sleep, now, log }) {
  const runsPath = `/repos/${repo}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=20`;
  const listRuns = async () => (await gh('actions', 'GET', runsPath)).body?.workflow_runs ?? [];
  const before = new Set((await listRuns()).map((r) => r.id));
  await gh('actions', 'POST', `/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, { ref: branch, inputs }, [200, 204]);
  const start = now();
  let run = null;
  while (!run) {
    if (now() - start > waits.start) throw new GithubRefused(`GitHub did not start the ${what} within ${minutes(waits.start)} minutes. See your repo's Actions tab, then run github-connect again.`);
    await sleep(3000);
    run = (await listRuns()).find((r) => !before.has(r.id));
  }
  log(`  started: ${run.html_url}`);
  let said = now();
  while (run.status !== 'completed') {
    if (now() - start > limit) throw new GithubRefused(`The ${what} has not finished after ${minutes(limit)} minutes. See ${run.html_url}`);
    await sleep(5000);
    run = (await gh('actions', 'GET', `/repos/${repo}/actions/runs/${run.id}`)).body;
    if (now() - said >= 60_000) { log(`  still running (${minutes(now() - start)} min)…`); said = now(); }
  }
  let lines = [];
  const jobs = (await gh('actions', 'GET', `/repos/${repo}/actions/runs/${run.id}/jobs`)).body?.jobs ?? [];
  if (jobs[0]?.id != null) {
    const logText = await gh('actions', 'GET', `/repos/${repo}/actions/jobs/${jobs[0].id}/logs`, undefined, [200]);
    lines = logLines(logText.text ?? '');
  }
  return { run, lines };
}
