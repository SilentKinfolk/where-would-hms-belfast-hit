// Patch vulnerable transitive dependencies that Dependabot structurally cannot
// reach, and prove the result still works before it goes anywhere.
//
// Dependabot updates what package.json declares. When a vulnerable package
// arrives through a dependency that pins it exactly, there is no declaration to
// bump and no upstream release to wait for, so the alert stays open forever.
// That is what happened with sharp: staticmaps 1.13.1 pins "sharp": "0.33.2",
// its latest release still does, and GHSA-f88m-g3jw-g9cj sat open from
// 2026-07-21 until it was forced by hand.
//
// The forcing move is a direct dependency at a clean version plus an override
// pointing at it:
//
//     "dependencies": { "sharp": "^0.35.3" }
//     "overrides":    { "sharp": "$sharp" }
//
// The direct entry is what keeps it autonomous afterwards. Dependabot tracks
// direct dependencies, "$sharp" makes the override follow whatever Dependabot
// bumps that entry to, and dependabot-automerge.yml lands it. So each package
// needs forcing once, and stays maintained by the normal machinery from then on.
//
// This script finds the next such package on its own. It is deliberately
// conservative: it declines majors, it reverts anything that fails the tests or
// the build, and it treats a package it cannot clear as a package to leave
// alone rather than one to force harder.
//
//   node scripts/auto-patch-security.mjs --dry-run   # report, touch nothing
//   node scripts/auto-patch-security.mjs             # patch, verify, revert on failure
//
// Run in CI by .github/workflows/security-autopatch.yml.

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
const LOCK_PATH = fileURLToPath(new URL('../package-lock.json', import.meta.url));

const DRY_RUN = process.argv.includes('--dry-run');

// Below this, forcing a resolution costs more than it buys. Dependabot's own
// scheduled updates carry low-severity drift soon enough.
const SEVERITIES = new Set(['moderate', 'high', 'critical']);

async function npm(args, opts = {}) {
  try {
    const { stdout } = await run('npm', args, {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
      ...opts
    });
    return { ok: true, stdout };
  } catch (err) {
    // npm audit exits non-zero when it finds anything, so stdout still matters.
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err) };
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Vulnerable packages worth acting on, split by whether package.json declares them. */
async function audit() {
  const { stdout } = await npm(['audit', '--json']);
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error(`Could not parse npm audit output (${stdout.slice(0, 200)}…)`);
  }
  const vulns = report.vulnerabilities ?? {};
  return Object.values(vulns)
    .filter((v) => SEVERITIES.has(v.severity))
    .map((v) => ({ name: v.name, severity: v.severity, isDirect: Boolean(v.isDirect) }));
}

/**
 * Dev-only or runtime? package-lock marks dev-only installs, which is exact and
 * saves shelling out to resolve the tree a second time.
 */
async function dependencySection(name) {
  const lock = await readJson(LOCK_PATH);
  const entry = lock.packages?.[`node_modules/${name}`];
  return entry?.dev === true ? 'devDependencies' : 'dependencies';
}

async function latestVersion(name) {
  const { ok, stdout } = await npm(['view', name, 'version']);
  if (!ok) return null;
  const v = stdout.trim();
  return /^\d+\.\d+\.\d+/.test(v) ? v : null;
}

/**
 * The installed version, hoisted or not. A package that is only reachable
 * nested — which is the shape a pinning dependant produces — still has to be
 * reported accurately, since this figure ends up in the commit message.
 */
async function installedVersion(name) {
  const lock = await readJson(LOCK_PATH);
  const packages = lock.packages ?? {};
  const hoisted = packages[`node_modules/${name}`]?.version;
  if (hoisted) return hoisted;
  const nested = Object.entries(packages)
    .filter(([path]) => path.endsWith(`/node_modules/${name}`))
    .map(([, entry]) => entry.version)
    .filter(Boolean)
    .sort();
  return nested[0] ?? null;
}

/** Add the direct dependency + self-referencing override that defeat the pin. */
async function forceResolution(name, version, section) {
  const pkg = await readJson(PKG_PATH);
  pkg[section] = pkg[section] ?? {};
  pkg[section][name] = `^${version}`;
  pkg[section] = Object.fromEntries(Object.entries(pkg[section]).sort(([a], [b]) => a.localeCompare(b)));
  pkg.overrides = pkg.overrides ?? {};
  pkg.overrides[name] = `$${name}`;
  pkg.overrides = Object.fromEntries(Object.entries(pkg.overrides).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
}

async function gitCheckout(paths) {
  await run('git', ['checkout', '--', ...paths], { cwd: ROOT }).catch(() => {});
}

async function main() {
  const findings = await audit();
  if (findings.length === 0) {
    console.log('npm audit is clean at moderate and above — nothing to force.');
    return { patched: [], skipped: [] };
  }

  for (const f of findings) {
    console.log(`  ${f.severity.padEnd(8)} ${f.name}${f.isDirect ? '  (direct)' : '  (transitive)'}`);
  }

  // Direct dependencies are Dependabot's job; it opens a PR, CI gates it and
  // dependabot-automerge.yml lands it. Forcing them here would race that.
  const targets = findings.filter((f) => !f.isDirect);
  if (targets.length === 0) {
    console.log('\nAll of them are direct dependencies — leaving those to Dependabot.');
    return { patched: [], skipped: [] };
  }

  const patched = [];
  const skipped = [];

  for (const { name, severity } of targets) {
    console.log(`\n=== ${name} (${severity}, transitive) ===`);
    const current = await installedVersion(name);
    const latest = await latestVersion(name);
    if (!latest) {
      skipped.push({ name, why: 'could not resolve a published version' });
      continue;
    }
    if (current === latest) {
      // Already newest; the advisory has no published fix yet.
      skipped.push({ name, why: `already at ${latest}, no fixed release published` });
      continue;
    }

    // Decline majors. A major forced into a dependant that never asked for it is
    // how the image pipeline breaks at 3am; that one earns a human.
    const majorOf = (v) => Number(v.split('.')[0]);
    if (current && majorOf(latest) > majorOf(current) && majorOf(latest) > 0) {
      skipped.push({ name, why: `${current} -> ${latest} crosses a major` });
      continue;
    }

    const section = await dependencySection(name);
    console.log(`  forcing ${current ?? '?'} -> ^${latest} via ${section} + $${name} override`);
    if (DRY_RUN) {
      patched.push({ name, from: current, to: latest, section });
      continue;
    }

    await forceResolution(name, latest, section);
    const install = await npm(['install', '--no-audit', '--no-fund']);
    if (!install.ok) {
      console.log(`  install failed — reverting ${name}`);
      await gitCheckout(['package.json', 'package-lock.json']);
      skipped.push({ name, why: 'npm install failed under the override' });
      continue;
    }

    const resolved = await installedVersion(name);
    if (resolved !== latest) {
      console.log(`  override did not bite (still ${resolved}) — reverting`);
      await gitCheckout(['package.json', 'package-lock.json']);
      skipped.push({ name, why: `override did not take effect (stayed ${resolved})` });
      continue;
    }

    patched.push({ name, from: current, to: latest, section });
    console.log(`  resolved to ${resolved}`);
  }

  if (patched.length === 0 || DRY_RUN) return { patched, skipped };

  // One verification pass over the whole batch. Anything red reverts everything;
  // bisecting which override broke the build is not worth the machinery when the
  // next scheduled run will retry them one at a time as the others land.
  console.log('\n=== verifying ===');
  for (const [label, args] of [
    ['tests', ['test']],
    ['build', ['run', 'build']]
  ]) {
    const res = await npm(args);
    if (!res.ok) {
      console.log(`  ${label} FAILED — reverting the whole batch`);
      console.log((res.stderr || res.stdout).slice(-2000));
      await gitCheckout(['package.json', 'package-lock.json']);
      await npm(['ci']);
      return { patched: [], skipped: [...skipped, ...patched.map((p) => ({ name: p.name, why: `${label} failed` }))] };
    }
    console.log(`  ${label} passed`);
  }

  return { patched, skipped };
}

main()
  .then(({ patched, skipped }) => {
    console.log('');
    for (const s of skipped) console.log(`Left alone: ${s.name} — ${s.why}`);
    if (patched.length === 0) {
      console.log('No changes.');
    } else {
      console.log(`Patched: ${patched.map((p) => `${p.name}@${p.to}`).join(', ')}`);
    }
    // The workflow reads this to decide whether to commit.
    if (process.env.GITHUB_OUTPUT) {
      const summary = patched.map((p) => `${p.name} ${p.from ?? '?'} -> ${p.to}`).join('; ');
      return writeFile(
        process.env.GITHUB_OUTPUT,
        `patched=${patched.length > 0}\nsummary=${summary}\n`,
        { flag: 'a' }
      );
    }
    return undefined;
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
