import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (file) => pathToFileURL(path.join(repo, "dist", "utils", file)).href;
const { writeAgentSkill } = await import(dist("project.js"));

function tempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfd-agent-guidance-"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "web"));
  fs.mkdirSync(path.join(root, "admin"));
  return root;
}

test("nested packages share one generic skill at the repository root", () => {
  const root = tempTree();
  try {
    const web = path.join(root, "web");
    const admin = path.join(root, "admin");
    writeAgentSkill(web, "sveltekit-fsd", { "SKILL.md": "# Generic\n" });
    writeAgentSkill(admin, "sveltekit-fsd", { "SKILL.md": "# Generic\n" });

    assert.equal(
      fs.readFileSync(path.join(root, ".agents/skills/sveltekit-fsd/SKILL.md"), "utf8"),
      "# Generic\n"
    );
    const link = path.join(root, ".claude/skills/sveltekit-fsd");
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readlinkSync(link).split(path.sep).join("/"), "../../.agents/skills/sveltekit-fsd");
    assert.ok(!fs.existsSync(path.join(web, ".agents")));
    assert.ok(!fs.existsSync(path.join(admin, ".agents")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("different content with the same generic name is rejected", () => {
  const root = tempTree();
  try {
    const web = path.join(root, "web");
    writeAgentSkill(web, "sveltekit-fsd", { "SKILL.md": "# First\n" });
    assert.throws(
      () => writeAgentSkill(web, "sveltekit-fsd", { "SKILL.md": "# Different\n" }),
      /already exists.*different content/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a stale real .claude copy is refreshed from .agents", () => {
  const root = tempTree();
  try {
    const web = path.join(root, "web");
    writeAgentSkill(web, "sveltekit-fsd", { "SKILL.md": "# Same\n" });
    const link = path.join(root, ".claude/skills/sveltekit-fsd");
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(link, { recursive: true });
    fs.writeFileSync(path.join(link, "SKILL.md"), "# Stale\n");

    writeAgentSkill(web, "sveltekit-fsd", { "SKILL.md": "# Same\n" });
    assert.equal(fs.readFileSync(path.join(link, "SKILL.md"), "utf8"), "# Same\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
