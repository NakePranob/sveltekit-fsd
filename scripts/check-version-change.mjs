#!/usr/bin/env node

// A merge into main is also a release input for this package. Keep the version
// change visible in the pull request so two commits cannot silently publish
// under the same package version.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(value) {
  const match = SEMVER.exec(value);
  if (!match) throw new Error(`"${value}" is not a valid SemVer`);

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function compareVersions(left, right) {
  const a = typeof left === "string" ? parseVersion(left) : left;
  const b = typeof right === "string" ? parseVersion(right) : right;

  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }

  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;

  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return Number(leftIdentifier) > Number(rightIdentifier) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }

  return 0;
}

export function validateVersionChange(baseVersion, headVersion, lockVersion = headVersion) {
  parseVersion(baseVersion);
  parseVersion(headVersion);

  if (compareVersions(headVersion, baseVersion) <= 0) {
    throw new Error(`package.json must increase version from ${baseVersion} to a newer release (got ${headVersion})`);
  }

  if (lockVersion !== headVersion) {
    throw new Error(`package-lock.json has ${lockVersion}, but package.json has ${headVersion}`);
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(resolve(root, file), "utf8"));
}

function readVersionAt(ref) {
  try {
    const source = execFileSync("git", ["show", `${ref}:package.json`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(source).version;
  } catch {
    throw new Error(`could not read package.json at base ref ${ref}`);
  }
}

function main() {
  const [baseRef, ...extra] = process.argv.slice(2);
  if (!baseRef || extra.length > 0) {
    throw new Error("expected one base git ref, for example the pull request base SHA");
  }

  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");
  const lockVersion = packageLock.packages?.[""]?.version;
  const baseVersion = readVersionAt(baseRef);
  validateVersionChange(baseVersion, packageJson.version, lockVersion);
  console.log(`version check passed: ${packageJson.version} is newer than ${baseVersion}`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`version check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
