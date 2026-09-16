import assert from "node:assert/strict";
import test from "node:test";

const { compareVersions, parseVersion, validateVersionChange } = await import(
  new URL("../scripts/check-version-change.mjs", import.meta.url)
);

test("version comparison follows release precedence", () => {
  assert.equal(compareVersions("0.1.2", "0.1.1"), 1);
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0+build.2"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
});

test("invalid versions are rejected", () => {
  assert.throws(() => parseVersion("1.0"), /not a valid SemVer/);
  assert.throws(() => parseVersion("01.0.0"), /not a valid SemVer/);
});

test("a release must increase the package and lockfile versions together", () => {
  assert.doesNotThrow(() => validateVersionChange("0.1.1", "0.1.2", "0.1.2"));
  assert.throws(() => validateVersionChange("0.1.1", "0.1.1"), /must increase/);
  assert.throws(() => validateVersionChange("0.1.1", "0.1.0"), /must increase/);
  assert.throws(() => validateVersionChange("0.1.1", "0.1.2", "0.1.1"), /package-lock/);
});
