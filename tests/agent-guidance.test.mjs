import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (file) => pathToFileURL(path.join(repo, "dist", "utils", file)).href;
const { agentSkillName, writeAgentSkill } = await import(dist("project.js"));

function tempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfd-agent-guidance-"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "web"));
  return root;
}

test("agent skill names are package-scoped in a monorepo", () => {
  const root = tempTree();
  try {
    assert.equal(agentSkillName(root), "sveltekit-fsd");
    assert.equal(agentSkillName(path.join(root, "web")), "sveltekit-fsd-web");
    assert.match(agentSkillName(path.join(root, "เว็บ")), /^sveltekit-fsd-[a-f0-9]{8}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nested packages write the real skill at the repository root", () => {
  const root = tempTree();
  try {
    const web = path.join(root, "web");
    writeAgentSkill(web, "sveltekit-fsd-web", { "SKILL.md": "# Skill\n" });

    assert.equal(
      fs.readFileSync(path.join(root, ".agents/skills/sveltekit-fsd-web/SKILL.md"), "utf8"),
      "# Skill\n"
    );
    const link = path.join(root, ".claude/skills/sveltekit-fsd-web");
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readlinkSync(link), "../../.agents/skills/sveltekit-fsd-web");
    assert.ok(!fs.existsSync(path.join(web, ".agents")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a different skill with the same name is rejected", () => {
  const root = tempTree();
  try {
    const web = path.join(root, "web");
    writeAgentSkill(web, "sveltekit-fsd-web", { "SKILL.md": "# First\n" });
    assert.throws(
      () => writeAgentSkill(web, "sveltekit-fsd-web", { "SKILL.md": "# Different\n" }),
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
    writeAgentSkill(web, "sveltekit-fsd-web", { "SKILL.md": "# Same\n" });
    const link = path.join(root, ".claude/skills/sveltekit-fsd-web");
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(link, { recursive: true });
    fs.writeFileSync(path.join(link, "SKILL.md"), "# Stale\n");

    writeAgentSkill(web, "sveltekit-fsd-web", { "SKILL.md": "# Same\n" });
    assert.equal(fs.readFileSync(path.join(link, "SKILL.md"), "utf8"), "# Same\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
