#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliName = "open" + "code";

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "composer.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  ".opencode",
  "opencode.jsonc",
  "opencode.json",
  "AGENTS.md"
];

const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);
const lastFileBackupMap = new Map();
const lastRootPruneMap = new Map();
const MAX_TRACKED_FILES = 1000;
const MAX_TRACKED_ROOTS = 256;
const PRUNE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_DIFF_FILE_BYTES = 512 * 1024; // 512 KB cap for synchronous TUI diff
let cachedSettingsPath = "";
let cachedSettingsMtime = -1;
let cachedSettingsValue = null;

// Config & Installer

function resolveConfigDir(customConfigDir) {
  if (customConfigDir) {
    if (customConfigDir.startsWith("~")) {
      return path.join(os.homedir(), customConfigDir.slice(1));
    }
    return path.resolve(customConfigDir);
  }
  if (process.env.OPENCODE_CONFIG_DIR) {
    return path.resolve(process.env.OPENCODE_CONFIG_DIR);
  }
  const configBase = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(configBase, cliName);
}

function getSettingsFilePath(customConfigDir) {
  return path.join(resolveConfigDir(customConfigDir), "auto-backup.json");
}

function readBackupSettings(customConfigDir) {
  const filePath = getSettingsFilePath(customConfigDir);
  const defaults = { retentionDays: 30, debounceMs: 0, rootDir: "", dialogWidth: "80%" };
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return defaults;
  }
  if (cachedSettingsValue && cachedSettingsPath === filePath && cachedSettingsMtime === st.mtimeMs) {
    return cachedSettingsValue;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const result = {
      retentionDays: typeof parsed.retentionDays === "number" && !Number.isNaN(parsed.retentionDays)
        ? Math.max(0, Math.floor(parsed.retentionDays))
        : 30,
      debounceMs: typeof parsed.debounceMs === "number" && !Number.isNaN(parsed.debounceMs)
        ? Math.max(0, Math.floor(parsed.debounceMs))
        : 0,
      rootDir: typeof parsed.rootDir === "string" ? parsed.rootDir.trim() : "",
      dialogWidth: typeof parsed.dialogWidth === "string" && parsed.dialogWidth.trim()
        ? parsed.dialogWidth.trim()
        : typeof parsed.dialogWidth === "number" && Number.isFinite(parsed.dialogWidth) && parsed.dialogWidth > 0
          ? (parsed.dialogWidth <= 100 ? Math.round(parsed.dialogWidth) + "%" : String(Math.round(parsed.dialogWidth)))
          : "80%"
    };
    cachedSettingsPath = filePath;
    cachedSettingsMtime = st.mtimeMs;
    cachedSettingsValue = result;
    return result;
  } catch {
    return defaults;
  }
}

function writeBackupSettings(patch, customConfigDir) {
  const configDir = resolveConfigDir(customConfigDir);
  fs.mkdirSync(configDir, { recursive: true });
  const current = readBackupSettings(customConfigDir);
  const next = {
    retentionDays: patch && typeof patch.retentionDays === "number" && !Number.isNaN(patch.retentionDays)
      ? Math.max(0, Math.floor(patch.retentionDays))
      : current.retentionDays,
    debounceMs: patch && typeof patch.debounceMs === "number" && !Number.isNaN(patch.debounceMs)
      ? Math.max(0, Math.floor(patch.debounceMs))
      : current.debounceMs,
    rootDir: patch && typeof patch.rootDir === "string"
      ? patch.rootDir.trim()
      : current.rootDir,
    dialogWidth: patch && typeof patch.dialogWidth === "string" && patch.dialogWidth.trim()
      ? patch.dialogWidth.trim()
      : patch && typeof patch.dialogWidth === "number" && Number.isFinite(patch.dialogWidth) && patch.dialogWidth > 0
        ? (patch.dialogWidth <= 100 ? Math.round(patch.dialogWidth) + "%" : String(Math.round(patch.dialogWidth)))
        : current.dialogWidth
  };
  const filePath = path.join(configDir, "auto-backup.json");
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + "\n", "utf8");
  cachedSettingsPath = "";
  cachedSettingsMtime = -1;
  cachedSettingsValue = null;
  return { filePath: filePath, settings: next };
}

function resolveRetentionDays(explicitValue, customConfigDir) {
  if (typeof explicitValue === "number" && !Number.isNaN(explicitValue)) {
    return Math.max(0, Math.floor(explicitValue));
  }
  if (process.env.OPENCODE_BACKUP_RETENTION_DAYS !== undefined && process.env.OPENCODE_BACKUP_RETENTION_DAYS !== "") {
    const envNum = Number(process.env.OPENCODE_BACKUP_RETENTION_DAYS);
    if (!Number.isNaN(envNum)) return Math.max(0, Math.floor(envNum));
  }
  return readBackupSettings(customConfigDir).retentionDays;
}

function findPluginsArraySpan(raw) {
  const keyRe = /"plugins"\s*:\s*\[/g;
  const match = keyRe.exec(raw);
  if (!match) return null;
  const openBracketIdx = match.index + match[0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openBracketIdx; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      const nl = raw.indexOf("\n", i + 2);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      const endComment = raw.indexOf("*/", i + 2);
      if (endComment === -1) break;
      i = endComment + 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        return {
          start: match.index,
          openEnd: openBracketIdx + 1,
          closeStart: i,
          end: i + 1
        };
      }
    }
  }
  return null;
}

function findLastCodeCharIndex(str) {
  let lastIdx = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      lastIdx = i;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === "/" && str[i + 1] === "/") {
      const nl = str.indexOf("\n", i + 2);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === "/" && str[i + 1] === "*") {
      const endComment = str.indexOf("*/", i + 2);
      if (endComment === -1) break;
      i = endComment + 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      lastIdx = i;
      continue;
    }
    if (!/\s/.test(ch)) {
      lastIdx = i;
    }
  }
  return lastIdx;
}

function addPluginToJsoncFile(filePath, schemaUrl, pluginEntryStr, pkgName) {
  if (!fs.existsSync(filePath)) {
    const content = [
      "{",
      '  "$schema": "' + schemaUrl + '",',
      '  "plugins": [',
      "    " + pluginEntryStr,
      "  ]",
      "}",
      ""
    ].join("\n");
    fs.writeFileSync(filePath, content, "utf8");
    return "created";
  }

  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.includes(pkgName)) {
    return "already-present";
  }

  const span = findPluginsArraySpan(raw);
  if (span) {
    const open = raw.slice(span.start, span.openEnd);
    const body = raw.slice(span.openEnd, span.closeStart);
    const close = raw.slice(span.closeStart, span.end);
    const lastCodeIdx = findLastCodeCharIndex(body);
    let replacement;
    if (lastCodeIdx === -1) {
      replacement = open + "\n    " + pluginEntryStr + "\n  " + close;
    } else {
      const needsComma = body[lastCodeIdx] !== ",";
      const withComma = needsComma
        ? body.slice(0, lastCodeIdx + 1) + "," + body.slice(lastCodeIdx + 1)
        : body;
      const trimmedBody = withComma.replace(/\s*$/, "");
      replacement = open + trimmedBody + "\n    " + pluginEntryStr + "\n  " + close;
    }
    const updated = raw.slice(0, span.start) + replacement + raw.slice(span.end);
    fs.writeFileSync(filePath, updated, "utf8");
    return "updated";
  }

  const lastBraceIdx = raw.lastIndexOf("}");
  if (lastBraceIdx !== -1) {
    const beforeSlice = raw.slice(0, lastBraceIdx);
    const lastCodeIdx = findLastCodeCharIndex(beforeSlice);
    const lastChar = lastCodeIdx !== -1 ? beforeSlice[lastCodeIdx] : "{";
    const needsComma = lastChar !== "{" && lastChar !== ",";
    const withComma = (needsComma && lastCodeIdx !== -1)
      ? beforeSlice.slice(0, lastCodeIdx + 1) + "," + beforeSlice.slice(lastCodeIdx + 1)
      : beforeSlice;
    const before = withComma.replace(/\s*$/, "");
    const updated =
      before +
      '\n  "plugins": [\n    ' +
      pluginEntryStr +
      "\n  ]\n}\n";
    fs.writeFileSync(filePath, updated, "utf8");
    return "updated";
  }

  return "skipped";
}

async function installPlugin(options) {
  const opts = options || {};
  const configDir = resolveConfigDir(opts.configDir);
  fs.mkdirSync(configDir, { recursive: true });

  const pkgName = "@nandoblanco/opencode-local-backup";
  const matchKey = "opencode-local-backup";
  const entryStr = opts.retentionDays
    ? '["' + pkgName + '", { "retentionDays": ' + Number(opts.retentionDays) + " }]"
    : '"' + pkgName + '"';

  const jsoncPath = path.join(configDir, cliName + ".jsonc");
  const jsonPath = path.join(configDir, cliName + ".json");
  const serverConfigFile = fs.existsSync(jsoncPath)
    ? jsoncPath
    : fs.existsSync(jsonPath)
      ? jsonPath
      : jsoncPath;

  const cliConfigFile = path.join(configDir, "cli.json");

  const serverStatus = addPluginToJsoncFile(
    serverConfigFile,
    "https://" + cliName + ".ai/config.json",
    entryStr,
    matchKey
  );
  const cliStatus = addPluginToJsoncFile(
    cliConfigFile,
    "https://" + cliName + ".ai/v2/cli.json",
    entryStr,
    matchKey
  );

  return {
    configDir: configDir,
    serverConfigFile: serverConfigFile,
    serverStatus: serverStatus,
    cliConfigFile: cliConfigFile,
    cliStatus: cliStatus
  };
}

// Path & Project Root Resolution

function normalizeSlashes(p) {
  return String(p || "").replace(/\\/g, "/");
}

function isSubPath(parentDir, childPath) {
  const rel = path.relative(parentDir, childPath);
  return Boolean(rel && !rel.startsWith("..") && !path.isAbsolute(rel)) || path.resolve(parentDir) === path.resolve(childPath);
}

function resolveProjectRoot(filePath, workspaceDir) {
  const absFile = path.resolve(filePath);
  const startDir = fs.existsSync(absFile) && fs.statSync(absFile).isDirectory()
    ? absFile
    : path.dirname(absFile);

  const absWorkspace = workspaceDir ? path.resolve(workspaceDir) : "";
  let current = startDir;

  while (true) {
    for (const marker of PROJECT_MARKERS) {
      if (fs.existsSync(path.join(current, marker))) {
        return current;
      }
    }
    if (absWorkspace && path.resolve(current) === absWorkspace) {
      return absWorkspace;
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) {
      break;
    }
    if (absWorkspace && !isSubPath(absWorkspace, parent)) {
      return absWorkspace;
    }
    current = parent;
  }

  if (absWorkspace && isSubPath(absWorkspace, startDir)) {
    return absWorkspace;
  }
  return startDir;
}

function extractPatchedPaths(patchText) {
  if (typeof patchText !== "string" || !patchText) return [];
  const results = [];
  const seen = new Set();
  const re = /^\*\*\*\s+(?:Update|Delete|Move)\s+File:\s*(.+)$/gm;
  let match;
  while ((match = re.exec(patchText)) !== null) {
    const raw = match[1].trim();
    if (raw && !seen.has(raw)) {
      seen.add(raw);
      results.push(raw);
    }
  }
  return results;
}

function extractTargetFiles(toolName, input, baseDir) {
  if (!input || typeof input !== "object") return [];
  const rawPaths = [];

  if (typeof input.filePath === "string" && input.filePath.trim()) {
    rawPaths.push(input.filePath.trim());
  }
  if (typeof input.path === "string" && input.path.trim()) {
    rawPaths.push(input.path.trim());
  }
  if (typeof input.patchText === "string") {
    const patched = extractPatchedPaths(input.patchText);
    for (const p of patched) rawPaths.push(p);
  }
  if (typeof input.patch === "string") {
    const patched = extractPatchedPaths(input.patch);
    for (const p of patched) rawPaths.push(p);
  }
  if (Array.isArray(input.files)) {
    for (const f of input.files) {
      if (typeof f === "string" && f.trim()) rawPaths.push(f.trim());
      else if (f && typeof f.filePath === "string") rawPaths.push(f.filePath.trim());
      else if (f && typeof f.path === "string") rawPaths.push(f.path.trim());
    }
  }
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (e && typeof e.filePath === "string") rawPaths.push(e.filePath.trim());
      else if (e && typeof e.path === "string") rawPaths.push(e.path.trim());
    }
  }

  const resolved = [];
  const seen = new Set();
  for (const raw of rawPaths) {
    const abs = baseDir && !path.isAbsolute(raw)
      ? path.resolve(baseDir, raw)
      : path.resolve(raw);
    if (!seen.has(abs)) {
      seen.add(abs);
      resolved.push(abs);
    }
  }
  return resolved;
}

// Snapshot Creation & Pruning

function formatTimestamp(date) {
  const d = date instanceof Date ? date : new Date();
  const pad = function (n) { return String(n).padStart(2, "0"); };
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "_" +
    pad(d.getHours()) +
    "-" +
    pad(d.getMinutes()) +
    "-" +
    pad(d.getSeconds())
  );
}

function sanitizeSlug(name) {
  const clean = String(name || "auto-backup")
    .replace(/[^a-zA-Z0-9\-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return clean || "auto-backup";
}

function parseFolderTimestamp(folderName) {
  const m = String(folderName || "").match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_(.+)$/);
  if (!m) return null;
  const dt = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6])
  );
  return {
    timeMs: dt.getTime(),
    iso: dt.toISOString(),
    slug: m[7]
  };
}

function pruneOldBackups(rootDir, retentionDays) {
  const days = resolveRetentionDays(retentionDays);
  const backupsDir = path.join(path.resolve(rootDir), ".backups");
  if (days <= 0) {
    return { removed: 0, disabled: true, retentionDays: 0, backupsDir: backupsDir };
  }
  if (!fs.existsSync(backupsDir)) {
    return { removed: 0, disabled: false, retentionDays: days, backupsDir: backupsDir };
  }

  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  const entries = fs.readdirSync(backupsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullDir = path.join(backupsDir, entry.name);
    let folderTimeMs = 0;
    const parsed = parseFolderTimestamp(entry.name);
    if (parsed && !Number.isNaN(parsed.timeMs)) {
      folderTimeMs = parsed.timeMs;
    } else {
      try {
        folderTimeMs = fs.statSync(fullDir).mtimeMs;
      } catch {
        continue;
      }
    }

    if (folderTimeMs > 0 && folderTimeMs < cutoffMs) {
      try {
        fs.rmSync(fullDir, { recursive: true, force: true });
        removed++;
      } catch {
        // Ignore locked folders
      }
    }
  }

  return { removed: removed, disabled: false, retentionDays: days, backupsDir: backupsDir };
}

function createBackupSnapshot(options) {
  const opts = options || {};
  const rawFiles = Array.isArray(opts.files) ? opts.files : [];
  const workspaceDir = opts.workspaceDir || "";
  const explicitRoot = opts.root ? path.resolve(opts.root) : "";
  const slug = sanitizeSlug(opts.name || opts.slug || "auto-backup");
  const toolName = String(opts.tool || "manual");
  const debounceMs = typeof opts.debounceMs === "number" ? opts.debounceMs : 0;
  const retentionDays = resolveRetentionDays(opts.retentionDays);
  const now = Date.now();

  const existingFiles = [];
  for (const f of rawFiles) {
    const abs = explicitRoot && !path.isAbsolute(f)
      ? path.resolve(explicitRoot, f)
      : path.resolve(f);
    let st;
    try {
      st = fs.statSync(abs);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    if (debounceMs > 0 && !opts.force) {
      const prev = lastFileBackupMap.get(abs) || 0;
      if (now - prev < debounceMs) continue;
    }
    existingFiles.push({ abs: abs, size: st.size, mtimeMs: st.mtimeMs });
  }

  if (existingFiles.length === 0) {
    return null;
  }

  const rootDir = explicitRoot || resolveProjectRoot(existingFiles[0].abs, workspaceDir);
  const stamp = formatTimestamp(new Date(now));
  const snapshotId = stamp + "_" + slug;
  const backupsBase = path.join(rootDir, ".backups");
  let snapshotDir = path.join(backupsBase, snapshotId);

  let suffix = 2;
  while (fs.existsSync(snapshotDir)) {
    snapshotDir = path.join(backupsBase, snapshotId + "-" + suffix);
    suffix++;
  }

  const backedUpFiles = [];
  for (const item of existingFiles) {
    const absFile = item.abs;
    let relPath = path.relative(rootDir, absFile);
    if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
      relPath = path.basename(absFile);
    }
    const targetPath = path.join(snapshotDir, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(absFile, targetPath);
    if (lastFileBackupMap.size >= MAX_TRACKED_FILES && !lastFileBackupMap.has(absFile)) {
      const oldestKey = lastFileBackupMap.keys().next().value;
      if (oldestKey !== undefined) lastFileBackupMap.delete(oldestKey);
    }
    lastFileBackupMap.set(absFile, now);
    backedUpFiles.push({
      relativePath: normalizeSlashes(relPath),
      originalPath: absFile,
      backupPath: targetPath,
      size: item.size,
      mtimeMs: item.mtimeMs
    });
  }

  const meta = {
    id: path.basename(snapshotDir),
    timestamp: new Date(now).toISOString(),
    timeMs: now,
    slug: slug,
    tool: toolName,
    root: rootDir,
    files: backedUpFiles.map(function (f) {
      return {
        relativePath: f.relativePath,
        originalPath: f.originalPath,
        size: f.size,
        mtimeMs: f.mtimeMs
      };
    })
  };

  try {
    fs.writeFileSync(path.join(snapshotDir, ".backup-meta.json"), JSON.stringify(meta, null, 2), "utf8");
  } catch {
    // Non-fatal if metadata write fails
  }

  const lastPrune = lastRootPruneMap.get(rootDir) || 0;
  if (retentionDays > 0 && (opts.pruneNow || now - lastPrune >= PRUNE_INTERVAL_MS)) {
    if (lastRootPruneMap.size >= MAX_TRACKED_ROOTS && !lastRootPruneMap.has(rootDir)) {
      const oldestRoot = lastRootPruneMap.keys().next().value;
      if (oldestRoot !== undefined) lastRootPruneMap.delete(oldestRoot);
    }
    lastRootPruneMap.set(rootDir, now);
    pruneOldBackups(rootDir, retentionDays);
  }

  return {
    id: meta.id,
    root: rootDir,
    snapshotDir: snapshotDir,
    slug: slug,
    tool: toolName,
    timeMs: now,
    files: backedUpFiles
  };
}

// Listing, Diffing & Restoring Backups

function walkSnapshotFiles(dir, baseDir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".backup-meta.json") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSnapshotFiles(full, baseDir, out);
    } else if (entry.isFile()) {
      const rel = normalizeSlashes(path.relative(baseDir, full));
      const st = fs.statSync(full);
      out.push({
        relativePath: rel,
        backupPath: full,
        size: st.size,
        mtimeMs: st.mtimeMs
      });
    }
  }
}

const SKIP_SCAN_DIRS = new Set([
  "node_modules",
  ".git",
  ".screenshots",
  "xampp",
  "vendor",
  ".next",
  "dist",
  "build",
  ".cache",
  "bower_components"
]);

function resolveTopWorkspaceRoot(startDir) {
  let current = path.resolve(startDir || process.cwd());
  let topCandidate = current;

  while (true) {
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    // Do not climb into filesystem root (e.g. C:\ or /) or OS home directory
    const grandParent = path.dirname(parent);
    if (!grandParent || grandParent === parent || parent.toLowerCase() === os.homedir().toLowerCase()) {
      break;
    }
    if (
      fs.existsSync(path.join(parent, ".backups")) ||
      fs.existsSync(path.join(parent, "AGENTS.md")) ||
      fs.existsSync(path.join(parent, ".opencode"))
    ) {
      topCandidate = parent;
    }
    current = parent;
  }

  return topCandidate;
}

function resolveScanRootDir(startDir, customConfigDir) {
  if (process.env.OPENCODE_BACKUP_ROOT_DIR && process.env.OPENCODE_BACKUP_ROOT_DIR.trim()) {
    return path.resolve(process.env.OPENCODE_BACKUP_ROOT_DIR.trim());
  }
  const settings = readBackupSettings(customConfigDir);
  if (settings.rootDir && fs.existsSync(settings.rootDir)) {
    return path.resolve(settings.rootDir);
  }
  return resolveTopWorkspaceRoot(startDir);
}

function collectBackupRoots(startDir, includeSubprojects, maxDepth) {
  const base = path.resolve(startDir || process.cwd());
  const depthLimit = typeof maxDepth === "number" && maxDepth > 0 ? maxDepth : Infinity;
  const roots = new Set();

  const projectRoot = resolveProjectRoot(base, base);
  if (fs.existsSync(path.join(projectRoot, ".backups"))) {
    roots.add(projectRoot);
  }
  if (fs.existsSync(path.join(base, ".backups"))) {
    roots.add(base);
  }

  const scanRoot = includeSubprojects ? resolveScanRootDir(base) : base;
  if (fs.existsSync(path.join(scanRoot, ".backups"))) {
    roots.add(scanRoot);
  }
  if (includeSubprojects && fs.existsSync(scanRoot)) {
    const scanDir = function (dir, depth) {
      if (depth > depthLimit) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SKIP_SCAN_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.name === ".backups") {
          roots.add(dir);
          continue;
        }
        if (!entry.name.startsWith(".")) {
          scanDir(full, depth + 1);
        }
      }
    };
    scanDir(scanRoot, 0);
  }

  if (roots.size === 0) {
    roots.add(projectRoot);
  }
  return Array.from(roots);
}

function listBackups(rootDir, options) {
  const opts = options || {};
  const roots = collectBackupRoots(rootDir, Boolean(opts.includeSubprojects), opts.maxDepth);
  const items = [];

  for (const r of roots) {
    const backupsDir = path.join(r, ".backups");
    if (!fs.existsSync(backupsDir)) continue;

    let dirs = [];
    try {
      dirs = fs.readdirSync(backupsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const snapDir = path.join(backupsDir, d.name);
      const metaPath = path.join(snapDir, ".backup-meta.json");
      const parsed = parseFolderTimestamp(d.name);
      let timeMs = parsed ? parsed.timeMs : 0;
      let slug = parsed ? parsed.slug : d.name;
      let tool = "auto";

      if (!timeMs) {
        try {
          timeMs = fs.statSync(snapDir).mtimeMs;
        } catch {
          timeMs = Date.now();
        }
      }

      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          if (meta.timeMs) timeMs = meta.timeMs;
          if (meta.slug) slug = meta.slug;
          if (meta.tool) tool = meta.tool;
          if (Array.isArray(meta.files)) {
            for (const f of meta.files) {
              if (!f || typeof f.relativePath !== "string" || !f.relativePath) continue;
              const bPath = path.resolve(snapDir, f.relativePath);
              if (bPath === path.resolve(snapDir) || !isSubPath(snapDir, bPath)) continue;
              if (!fs.existsSync(bPath)) continue;
              const origPath = f.originalPath
                ? path.resolve(String(f.originalPath))
                : path.resolve(r, f.relativePath);
              if (!isSubPath(r, origPath) || isSubPath(backupsDir, origPath)) continue;
              items.push({
                id: d.name + "::" + f.relativePath,
                snapshotId: d.name,
                root: r,
                slug: slug,
                tool: tool,
                timeMs: timeMs,
                relativePath: normalizeSlashes(path.relative(snapDir, bPath)),
                fileName: path.basename(bPath),
                backupPath: bPath,
                originalPath: origPath,
                size: typeof f.size === "number" ? f.size : fs.statSync(bPath).size
              });
            }
            continue;
          }
        } catch {
          // Fall back to directory walk
        }
      }

      const walked = [];
      try {
        walkSnapshotFiles(snapDir, snapDir, walked);
      } catch {
        continue;
      }
      for (const f of walked) {
        const origPath = path.join(r, f.relativePath);
        items.push({
          id: d.name + "::" + f.relativePath,
          snapshotId: d.name,
          root: r,
          slug: slug,
          tool: tool,
          timeMs: timeMs,
          relativePath: f.relativePath,
          fileName: path.basename(f.relativePath),
          backupPath: f.backupPath,
          originalPath: origPath,
          size: f.size
        });
      }
    }
  }

  items.sort(function (a, b) {
    return b.timeMs - a.timeMs;
  });

  if (typeof opts.limit === "number" && opts.limit > 0) {
    return items.slice(0, opts.limit);
  }
  return items;
}

function readTextSafeForDiff(filePath) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return { status: "missing" };
  }
  if (!st.isFile()) {
    return { status: "binary" };
  }
  if (st.size > MAX_DIFF_FILE_BYTES) {
    return { status: "too-large", size: st.size };
  }
  try {
    const buf = fs.readFileSync(filePath);
    const probeLen = Math.min(buf.length, 4096);
    for (let i = 0; i < probeLen; i++) {
      if (buf[i] === 0) {
        return { status: "binary" };
      }
    }
    return { status: "ok", text: buf.toString("utf8") };
  } catch {
    return { status: "binary" };
  }
}

function computeUnifiedDiff(backupFilePath, currentFilePath, maxLines) {
  const limit = typeof maxLines === "number" && maxLines > 0 ? maxLines : 160;
  const backupRead = readTextSafeForDiff(backupFilePath);
  if (backupRead.status === "missing") {
    return { status: "missing-backup", summary: "Backup file missing", lines: [] };
  }
  if (backupRead.status === "too-large") {
    return { status: "binary", summary: "File too large for inline diff (" + Math.round(backupRead.size / 1024) + " KB)", lines: [] };
  }
  if (backupRead.status !== "ok") {
    return { status: "binary", summary: "Binary or unreadable file", lines: [] };
  }
  const backupText = backupRead.text;

  const currentRead = readTextSafeForDiff(currentFilePath);
  if (currentRead.status === "missing") {
    const bLines = backupText.split(/\r?\n/);
    return {
      status: "deleted",
      summary: "File was deleted on disk (restoring will recreate it)",
      lines: bLines.slice(0, limit).map(function (l) {
        return { type: "add", text: "+ " + l };
      })
    };
  }
  if (currentRead.status === "too-large") {
    return { status: "binary", summary: "File too large for inline diff (" + Math.round(currentRead.size / 1024) + " KB)", lines: [] };
  }
  if (currentRead.status !== "ok") {
    return { status: "binary", summary: "Binary or unreadable file", lines: [] };
  }
  const currentText = currentRead.text;

  if (backupText === currentText) {
    const sameLines = backupText.split(/\r?\n/).slice(0, 40);
    return {
      status: "identical",
      summary: "Identical to current file on disk",
      lines: sameLines.map(function (l) {
        return { type: "context", text: "  " + l };
      })
    };
  }

  const oldLines = currentText.split(/\r?\n/);
  const newLines = backupText.split(/\r?\n/);
  const rawOps = [];
  let added = 0;
  let removed = 0;

  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      rawOps.push({
        type: "context",
        oldLine: i + 1,
        newLine: j + 1,
        text: "  " + String(i + 1).padStart(4, " ") + " │ " + oldLines[i]
      });
      i++;
      j++;
      continue;
    }

    let foundMatch = false;
    for (let look = 1; look <= 25; look++) {
      if (i + look < oldLines.length && oldLines[i + look] === newLines[j]) {
        for (let k = 0; k < look; k++) {
          removed++;
          rawOps.push({
            type: "del",
            oldLine: i + k + 1,
            newLine: j + 1,
            text: "- " + String(i + k + 1).padStart(4, " ") + " │ " + oldLines[i + k]
          });
        }
        i += look;
        foundMatch = true;
        break;
      }
      if (j + look < newLines.length && oldLines[i] === newLines[j + look]) {
        for (let k = 0; k < look; k++) {
          added++;
          rawOps.push({
            type: "add",
            oldLine: i + 1,
            newLine: j + k + 1,
            text: "+ " + String(j + k + 1).padStart(4, " ") + " │ " + newLines[j + k]
          });
        }
        j += look;
        foundMatch = true;
        break;
      }
    }

    if (!foundMatch) {
      if (i < oldLines.length) {
        removed++;
        rawOps.push({
          type: "del",
          oldLine: i + 1,
          newLine: j + 1,
          text: "- " + String(i + 1).padStart(4, " ") + " │ " + oldLines[i]
        });
        i++;
      }
      if (j < newLines.length) {
        added++;
        rawOps.push({
          type: "add",
          oldLine: i + 1,
          newLine: j + 1,
          text: "+ " + String(j + 1).padStart(4, " ") + " │ " + newLines[j]
        });
        j++;
      }
    }
  }

  // Keep only changed lines plus 3 lines of context around each change (hunks)
  const CONTEXT_RADIUS = 3;
  const includeIdx = new Uint8Array(rawOps.length);
  for (let idx = 0; idx < rawOps.length; idx++) {
    if (rawOps[idx].type !== "context") {
      const start = Math.max(0, idx - CONTEXT_RADIUS);
      const end = Math.min(rawOps.length - 1, idx + CONTEXT_RADIUS);
      for (let c = start; c <= end; c++) {
        includeIdx[c] = 1;
      }
    }
  }

  const diffLines = [];
  let lastIncluded = -1;
  for (let idx = 0; idx < rawOps.length; idx++) {
    if (!includeIdx[idx]) continue;
    if (diffLines.length >= limit) break;
    if (lastIncluded === -1 || idx > lastIncluded + 1) {
      const op = rawOps[idx];
      diffLines.push({
        type: "hunk",
        text: "@@ current line " + op.oldLine + " / backup line " + op.newLine + " @@"
      });
      if (diffLines.length >= limit) break;
    }
    diffLines.push({
      type: rawOps[idx].type,
      text: rawOps[idx].text
    });
    lastIncluded = idx;
  }

  return {
    status: "modified",
    summary: "Restoring will revert current file (+" + added + " / -" + removed + " lines)",
    lines: diffLines
  };
}

function restoreBackupFile(entry, options) {
  const opts = options || {};
  if (!entry || !entry.backupPath || !fs.existsSync(entry.backupPath)) {
    throw new Error("Backup snapshot file not found: " + (entry ? entry.backupPath : "unknown"));
  }
  const absBackupPath = path.resolve(entry.backupPath);
  const rootDir = entry.root ? path.resolve(entry.root) : "";
  const rawTarget = entry.originalPath || (rootDir && entry.relativePath ? path.join(rootDir, entry.relativePath) : "");
  if (!rawTarget) {
    throw new Error("Invalid restore target path");
  }
  const targetPath = path.resolve(rawTarget);
  if (rootDir) {
    const backupsBase = path.join(rootDir, ".backups");
    if (!isSubPath(backupsBase, absBackupPath) || absBackupPath === backupsBase) {
      throw new Error("Refusing to restore from path outside project .backups directory: " + absBackupPath);
    }
    if (!isSubPath(rootDir, targetPath) || targetPath === rootDir || isSubPath(backupsBase, targetPath)) {
      throw new Error("Refusing to restore file outside project root: " + targetPath);
    }
  }

  let safetySnapshot = null;
  if (!opts.skipSafetyBackup && fs.existsSync(targetPath)) {
    safetySnapshot = createBackupSnapshot({
      root: rootDir || entry.root,
      name: "pre-restore",
      tool: "restore",
      files: [targetPath],
      force: true
    });
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(absBackupPath, targetPath);

  return {
    restoredPath: targetPath,
    fromSnapshot: entry.snapshotId,
    safetySnapshot: safetySnapshot ? safetySnapshot.snapshotDir : null
  };
}

function assertSafeWinShellPaths(paths) {
  if (process.platform !== "win32") return;
  for (const p of paths) {
    if (/[&|<>^%\r\n\0]/.test(p)) {
      throw new Error("Unsafe characters in file path for Windows shell launcher: " + p);
    }
  }
}

function openBackupFile(filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error("File not found: " + absPath);
  }

  const customEditor = process.env.OPENCODE_BACKUP_EDITOR || process.env.VISUAL || process.env.EDITOR || "";
  if (customEditor) {
    assertSafeWinShellPaths([absPath]);
    const child = spawn(customEditor, [absPath], {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32"
    });
    child.on("error", function () {});
    child.unref();
    return { openedPath: absPath, launcher: customEditor };
  }

  if (process.platform === "win32") {
    const child = spawn("explorer.exe", [absPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", function () {});
    child.unref();
    return { openedPath: absPath, launcher: "system-default (explorer.exe)" };
  }

  const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(openCmd, [absPath], {
    detached: true,
    stdio: "ignore"
  });
  child.on("error", function () {});
  child.unref();
  return { openedPath: absPath, launcher: openCmd };
}

function openBackupDiff(backupFilePath, currentFilePath) {
  const absBackup = path.resolve(backupFilePath);
  const absCurrent = path.resolve(currentFilePath);
  if (!fs.existsSync(absBackup)) {
    throw new Error("Backup file not found: " + absBackup);
  }
  if (!fs.existsSync(absCurrent)) {
    throw new Error("Current file on disk not found: " + absCurrent);
  }

  assertSafeWinShellPaths([absBackup, absCurrent]);
  const diffCmd = process.env.OPENCODE_BACKUP_DIFF_CMD || "code";
  const args = diffCmd === "code" ? ["--diff", absBackup, absCurrent] : [absBackup, absCurrent];
  const child = spawn(diffCmd, args, {
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32",
    windowsHide: true
  });
  child.on("error", function () {});
  child.unref();
  return { backupPath: absBackup, currentPath: absCurrent, launcher: diffCmd + " --diff" };
}

// OpenCode Server Plugin

function createPluginDefinition() {
  return {
    id: "opencode-local-backup",
    async setup(ctx) {
      const opts = (ctx && ctx.options) || {};
      const customRoot = opts.backupRoot || process.env.OPENCODE_BACKUP_ROOT || "";
      const workspaceDir = (ctx && ctx.location && ctx.location.directory) ? ctx.location.directory : process.cwd();

      const registrations = [];

      if (ctx && ctx.tool && typeof ctx.tool.hook === "function") {
        const hookReg = await ctx.tool.hook("execute.before", function (event) {
          const toolName = String(event && event.tool ? event.tool : "");
          if (!EDIT_TOOLS.has(toolName)) return;

          const targets = extractTargetFiles(toolName, event.input, workspaceDir);
          if (targets.length === 0) return;

          const savedSettings = readBackupSettings();
          const debounceMs = typeof opts.debounceMs === "number"
            ? opts.debounceMs
            : process.env.OPENCODE_BACKUP_DEBOUNCE_MS !== undefined
              ? Number(process.env.OPENCODE_BACKUP_DEBOUNCE_MS)
              : savedSettings.debounceMs;
          const retentionDays = resolveRetentionDays(opts.retentionDays);

          const byRoot = new Map();
          for (const absFile of targets) {
            if (!fs.existsSync(absFile)) continue;
            const root = customRoot
              ? path.resolve(customRoot)
              : resolveProjectRoot(absFile, workspaceDir);
            if (!byRoot.has(root)) byRoot.set(root, []);
            byRoot.get(root).push(absFile);
          }

          for (const [root, files] of byRoot.entries()) {
            const firstBase = path.basename(files[0], path.extname(files[0]));
            const slug = files.length === 1
              ? sanitizeSlug("auto-" + toolName + "-" + firstBase)
              : sanitizeSlug("auto-" + toolName + "-" + files.length + "-files");

            try {
              const snap = createBackupSnapshot({
                root: root,
                workspaceDir: workspaceDir,
                name: slug,
                tool: toolName,
                files: files,
                debounceMs: debounceMs,
                retentionDays: retentionDays
              });
              if (snap && typeof opts.onBackup === "function") {
                opts.onBackup(snap);
              }
            } catch {
              // Never block tool execution if backup encounters a transient filesystem lock
            }
          }
        });
        if (hookReg) registrations.push(hookReg);
      }

      if (ctx && ctx.tool && typeof ctx.tool.register === "function") {
        const toolReg = await ctx.tool.register(function (editor) {
          editor.add({
            name: "backup_list",
            description: "List recent automatic and manual file backup snapshots in .backups/ for the current project.",
            input: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "Optional filename or slug filter"
                },
                limit: {
                  type: "number",
                  description: "Maximum entries to return (default: 20)"
                }
              },
              additionalProperties: false
            },
            execute: async function (input) {
              const all = listBackups(workspaceDir, { includeSubprojects: true });
              const q = String((input && input.query) || "").trim().toLowerCase();
              const filtered = q
                ? all.filter(function (item) {
                    return (
                      item.relativePath.toLowerCase().includes(q) ||
                      item.snapshotId.toLowerCase().includes(q) ||
                      item.slug.toLowerCase().includes(q)
                    );
                  })
                : all;
              const top = filtered.slice(0, (input && input.limit) || 20);
              if (top.length === 0) {
                return { content: "No backup snapshots found." };
              }
              const lines = top.map(function (item) {
                return (
                  "[" +
                  item.snapshotId +
                  "] " +
                  item.relativePath +
                  " (" +
                  item.size +
                  " bytes, root: " +
                  item.root +
                  ")"
                );
              });
              return { content: lines.join("\n") };
            }
          });

          editor.add({
            name: "backup_restore",
            description: "Restore a file from a .backups/ snapshot back to its original path (creates a pre-restore safety backup first).",
            input: {
              type: "object",
              properties: {
                snapshotId: {
                  type: "string",
                  description: "Snapshot folder name (e.g. 2026-10-25_12-30-00_auto-edit-index)"
                },
                relativePath: {
                  type: "string",
                  description: "Relative file path inside the snapshot"
                }
              },
              required: ["snapshotId"],
              additionalProperties: false
            },
            execute: async function (input) {
              const all = listBackups(workspaceDir, { includeSubprojects: true });
              const match = all.find(function (item) {
                if (item.snapshotId !== input.snapshotId) return false;
                if (input.relativePath && normalizeSlashes(input.relativePath) !== item.relativePath) return false;
                return true;
              });
              if (!match) {
                return { content: "Snapshot entry not found: " + input.snapshotId };
              }
              const res = restoreBackupFile(match);
              return {
                content:
                  "Restored " +
                  res.restoredPath +
                  " from " +
                  res.fromSnapshot +
                  (res.safetySnapshot ? " (safety backup: " + res.safetySnapshot + ")" : "")
              };
            }
          });
        });
        if (toolReg) registrations.push(toolReg);
      }

      return async function () {
        for (const reg of registrations) {
          if (reg && typeof reg.dispose === "function") {
            await reg.dispose();
          }
        }
      };
    }
  };
}

const server = createPluginDefinition();
export default server;
export {
  server,
  resolveConfigDir,
  getSettingsFilePath,
  readBackupSettings,
  writeBackupSettings,
  resolveRetentionDays,
  resolveScanRootDir,
  installPlugin,
  resolveProjectRoot,
  extractPatchedPaths,
  extractTargetFiles,
  formatTimestamp,
  sanitizeSlug,
  parseFolderTimestamp,
  pruneOldBackups,
  createBackupSnapshot,
  listBackups,
  computeUnifiedDiff,
  restoreBackupFile,
  openBackupFile,
  openBackupDiff
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const cmd = process.argv[2] || "install";

  if (cmd === "install" || cmd === "init" || cmd === "setup") {
    let customConfigDir = "";
    for (let i = 3; i < process.argv.length; i++) {
      if ((process.argv[i] === "--dir" || process.argv[i] === "-d") && process.argv[i + 1]) {
        customConfigDir = process.argv[i + 1];
        i++;
      }
    }
    installPlugin({ configDir: customConfigDir || undefined }).then(function (res) {
      const settingsInfo = writeBackupSettings({}, customConfigDir || undefined);
      console.log("opencode-local-backup installed:");
      console.log("  Server config:   " + res.serverConfigFile + " (" + res.serverStatus + ")");
      console.log("  TUI config:      " + res.cliConfigFile + " (" + res.cliStatus + ")");
      console.log("  Settings file:   " + settingsInfo.filePath + " (retentionDays=" + settingsInfo.settings.retentionDays + ")");
    }).catch(function (err) {
      console.error("Install failed:", err);
      process.exit(1);
    });
  } else if (cmd === "retention" || cmd === "config") {
    const rawDays = process.argv[3];
    if (rawDays === undefined) {
      const s = readBackupSettings();
      const label = s.retentionDays === 0 ? "0 (never auto-prune)" : s.retentionDays + " days";
      console.log("Current auto-prune retention: " + label + " (" + getSettingsFilePath() + ")");
    } else {
      const days = Math.max(0, Math.floor(Number(rawDays)));
      if (Number.isNaN(days)) {
        console.error("Invalid number of days: " + rawDays);
        process.exit(1);
      }
      const res = writeBackupSettings({ retentionDays: days });
      const label = res.settings.retentionDays === 0 ? "0 (never auto-prune)" : res.settings.retentionDays + " days";
      console.log("Updated auto-prune retention to " + label + " in " + res.filePath);
    }
  } else if (cmd === "root") {
    const rawRoot = process.argv[3];
    if (rawRoot === undefined) {
      const s = readBackupSettings();
      const label = s.rootDir ? s.rootDir : "(auto-detect workspace root)";
      console.log("Current backup scan rootDir: " + label + " (" + getSettingsFilePath() + ")");
    } else if (rawRoot === "--clear" || rawRoot === "auto") {
      const res = writeBackupSettings({ rootDir: "" });
      console.log("Cleared rootDir (using auto-detect) in " + res.filePath);
    } else {
      const resolved = path.resolve(rawRoot);
      const res = writeBackupSettings({ rootDir: resolved });
      console.log("Updated backup scan rootDir to " + res.settings.rootDir + " in " + res.filePath);
    }
  } else if (cmd === "list") {
    const dir = process.argv[3] || process.cwd();
    const entries = listBackups(dir, { includeSubprojects: true, limit: 30 });
    if (entries.length === 0) {
      console.log("No backups found in " + dir);
    } else {
      for (const e of entries) {
        console.log("[" + e.snapshotId + "]  " + e.relativePath + "  (" + e.size + " B)");
      }
    }
  } else if (cmd === "backup") {
    const slug = process.argv[3] || "manual";
    const files = process.argv.slice(4);
    const snap = createBackupSnapshot({
      name: slug,
      tool: "cli",
      files: files,
      force: true
    });
    if (snap) {
      console.log("Backed up " + snap.files.length + " file(s) to " + snap.snapshotDir);
    } else {
      console.log("No existing files matched to back up.");
    }
  } else if (cmd === "prune") {
    const dir = process.argv[3] || process.cwd();
    const rawDays = process.argv[4];
    const days = rawDays !== undefined ? Number(rawDays) : resolveRetentionDays();
    const res = pruneOldBackups(dir, days);
    if (res.disabled) {
      console.log("Auto-prune is disabled (retentionDays = 0). Pass an explicit day count to prune manually.");
    } else {
      console.log("Pruned " + res.removed + " snapshot(s) older than " + res.retentionDays + " days in " + res.backupsDir);
    }
  }
}
