"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import server, {
  resolveProjectRoot,
  extractPatchedPaths,
  extractTargetFiles,
  createBackupSnapshot,
  listBackups,
  computeUnifiedDiff,
  restoreBackupFile,
  pruneOldBackups,
  readBackupSettings,
  writeBackupSettings,
  installPlugin
} from "../index.js";

function makeTempProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-local-backup-test-"));
  fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo-app"}', "utf8");
  fs.mkdirSync(path.join(tmpDir, "src", "nested"), { recursive: true });
  return tmpDir;
}

test("resolveProjectRoot walks up to project root instead of polluting nested subfolders", function () {
  const root = makeTempProject();
  try {
    const deepFile = path.join(root, "src", "nested", "widget.js");
    fs.writeFileSync(deepFile, "const x = 1;\n", "utf8");

    const resolved = resolveProjectRoot(deepFile, root);
    assert.equal(resolved, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extractPatchedPaths and extractTargetFiles extract all files from multi-file patches", function () {
  const root = makeTempProject();
  try {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/a.js",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "*** Delete File: src/nested/b.js",
      "*** Move File: src/c.js",
      "*** End Patch"
    ].join("\n");

    const patched = extractPatchedPaths(patchText);
    assert.deepEqual(patched, ["src/a.js", "src/nested/b.js", "src/c.js"]);

    const targets = extractTargetFiles("apply_patch", { patchText: patchText }, root);
    assert.equal(targets.length, 3);
    assert.equal(targets[0], path.join(root, "src", "a.js"));
    assert.equal(targets[1], path.join(root, "src", "nested", "b.js"));
    assert.equal(targets[2], path.join(root, "src", "c.js"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createBackupSnapshot preserves relative structure, writes metadata, and respects debounce", function () {
  const root = makeTempProject();
  try {
    const fileA = path.join(root, "src", "nested", "app.js");
    fs.writeFileSync(fileA, "console.log('v1');\n", "utf8");

    const snap1 = createBackupSnapshot({
      root: root,
      name: "auto-edit-app",
      tool: "edit",
      files: [fileA],
      debounceMs: 60000
    });

    assert.ok(snap1);
    assert.equal(snap1.root, root);
    assert.equal(snap1.files.length, 1);
    assert.equal(snap1.files[0].relativePath, "src/nested/app.js");
    assert.ok(fs.existsSync(path.join(snap1.snapshotDir, "src", "nested", "app.js")));
    assert.ok(fs.existsSync(path.join(snap1.snapshotDir, ".backup-meta.json")));

    // Second immediate call within debounce window should return null
    const snapDebounced = createBackupSnapshot({
      root: root,
      name: "auto-edit-app",
      tool: "edit",
      files: [fileA],
      debounceMs: 60000
    });
    assert.equal(snapDebounced, null);

    // Forced snapshot bypasses debounce
    const snapForced = createBackupSnapshot({
      root: root,
      name: "manual-checkpoint",
      tool: "manual",
      files: [fileA],
      debounceMs: 60000,
      force: true
    });
    assert.ok(snapForced);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listBackups, computeUnifiedDiff, and restoreBackupFile round-trip with safety backup", function () {
  const root = makeTempProject();
  try {
    const fileA = path.join(root, "src", "nested", "config.js");
    fs.writeFileSync(fileA, "export const port = 3000;\nexport const host = 'localhost';\n", "utf8");

    const snap = createBackupSnapshot({
      root: root,
      name: "auto-edit-config",
      tool: "edit",
      files: [fileA],
      force: true
    });
    assert.ok(snap);

    // Modify file on disk
    fs.writeFileSync(fileA, "export const port = 8080;\nexport const host = '0.0.0.0';\n", "utf8");

    const entries = listBackups(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].relativePath, "src/nested/config.js");

    const diff = computeUnifiedDiff(entries[0].backupPath, entries[0].originalPath);
    assert.equal(diff.status, "modified");
    assert.ok(diff.lines.some((l) => l.type === "add" && l.text.includes("3000")));
    assert.ok(diff.lines.some((l) => l.type === "del" && l.text.includes("8080")));

    // Restore from snapshot
    const restored = restoreBackupFile(entries[0]);
    assert.equal(restored.restoredPath, fileA);
    assert.ok(restored.safetySnapshot);
    assert.equal(
      fs.readFileSync(fileA, "utf8"),
      "export const port = 3000;\nexport const host = 'localhost';\n"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pruneOldBackups deletes snapshot directories older than retentionDays and respects 0 as never prune", function () {
  const root = makeTempProject();
  try {
    const oldDir = path.join(root, ".backups", "2020-01-01_12-00-00_old-edit");
    const recentDir = path.join(root, ".backups", "2099-01-01_12-00-00_recent-edit");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(recentDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "a.txt"), "old", "utf8");
    fs.writeFileSync(path.join(recentDir, "a.txt"), "new", "utf8");

    // 0 means never auto-prune
    const resNever = pruneOldBackups(root, 0);
    assert.equal(resNever.disabled, true);
    assert.equal(resNever.removed, 0);
    assert.equal(fs.existsSync(oldDir), true);

    // 30 days prunes the 2020 folder
    const res = pruneOldBackups(root, 30);
    assert.equal(res.disabled, false);
    assert.equal(res.removed, 1);
    assert.equal(fs.existsSync(oldDir), false);
    assert.equal(fs.existsSync(recentDir), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readBackupSettings and writeBackupSettings persist retentionDays (including 0 for never)", function () {
  const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-local-backup-settings-"));
  try {
    const def = readBackupSettings(tmpConfig);
    assert.equal(def.retentionDays, 30);
    assert.equal(def.debounceMs, 0);

    writeBackupSettings({ retentionDays: 5 }, tmpConfig);
    assert.equal(readBackupSettings(tmpConfig).retentionDays, 5);

    writeBackupSettings({ retentionDays: 0 }, tmpConfig);
    assert.equal(readBackupSettings(tmpConfig).retentionDays, 0);
  } finally {
    fs.rmSync(tmpConfig, { recursive: true, force: true });
  }
});

test("OpenCode server plugin hooks execute.before and backs up edited files automatically", async function () {
  const root = makeTempProject();
  try {
    const targetFile = path.join(root, "src", "index.js");
    fs.writeFileSync(targetFile, "const v = 1;\n", "utf8");

    let hookHandler = null;
    const mockCtx = {
      options: { debounceMs: 0 },
      location: { directory: root },
      tool: {
        hook: async function (eventName, fn) {
          if (eventName === "execute.before") hookHandler = fn;
          return { dispose: async function () {} };
        }
      }
    };

    await server.setup(mockCtx);
    assert.equal(typeof hookHandler, "function");

    hookHandler({
      tool: "edit",
      input: { filePath: targetFile }
    });

    const backups = listBackups(root);
    assert.equal(backups.length, 1);
    assert.equal(backups[0].relativePath, "src/index.js");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installPlugin writes plugin entry into opencode.jsonc and cli.json", async function () {
  const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-local-backup-cfg-"));
  try {
    const res1 = await installPlugin({ configDir: tmpConfig });
    assert.equal(res1.serverStatus, "created");
    assert.equal(res1.cliStatus, "created");

    const cliHost = ["open", "code"].join("") + ".ai";
    const serverJson = JSON.parse(fs.readFileSync(res1.serverConfigFile, "utf8"));
    const cliJson = JSON.parse(fs.readFileSync(res1.cliConfigFile, "utf8"));
    assert.equal(serverJson.$schema, "https://" + cliHost + "/config.json");
    assert.equal(cliJson.$schema, "https://" + cliHost + "/v2/cli.json");

    const res2 = await installPlugin({ configDir: tmpConfig });
    assert.equal(res2.serverStatus, "already-present");
    assert.equal(res2.cliStatus, "already-present");
  } finally {
    fs.rmSync(tmpConfig, { recursive: true, force: true });
  }
});
