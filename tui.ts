"use strict";

import path from "node:path";
import type { TuiPluginContext } from "@opencode-ai/plugin/tui";
import { TextAttributes } from "@opentui/core";
import {
  createComponent,
  createElement,
  createTextNode,
  effect,
  insert,
  insertNode,
  setProp,
  use
} from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show
} from "solid-js";
import {
  listBackups,
  computeUnifiedDiff,
  restoreBackupFile,
  openBackupFile,
  openBackupDiff,
  pruneOldBackups,
  readBackupSettings,
  writeBackupSettings
} from "./index.js";

interface BackupEntry {
  id: string;
  snapshotId: string;
  root: string;
  slug: string;
  tool: string;
  timeMs: number;
  relativePath: string;
  fileName: string;
  backupPath: string;
  originalPath: string;
  size: number;
}

interface DialogProps {
  context: TuiPluginContext;
  workspaceDir: string;
  initialQuery: string;
  close: () => void;
}

type ToolFilter = "all" | "edit" | "write" | "patch" | "pre-restore";
type DateFilter = "all" | "24h" | "7d" | "30d";

const TOOL_CYCLE: ToolFilter[] = ["all", "edit", "write", "patch", "pre-restore"];
const DATE_CYCLE: DateFilter[] = ["all", "24h", "7d", "30d"];
const RETENTION_PRESETS = [30, 14, 7, 5, 0];

function formatAge(timeMs: number): string {
  if (!timeMs) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - timeMs) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatParentBackupPath(entry: BackupEntry): string {
  const parentDir = path.dirname(entry.backupPath);
  const rootParent = path.dirname(entry.root);
  const relFromParent = path.relative(rootParent, parentDir);
  if (relFromParent && !relFromParent.startsWith("..")) {
    return relFromParent.replace(/\\/g, "/");
  }
  return parentDir.replace(/\\/g, "/");
}

function splitHighlightedText(
  text: string,
  term: string
): Array<{ text: string; match: boolean }> {
  const words = term
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (!words.length) {
    return [{ text, match: false }];
  }
  const parts: Array<{ text: string; match: boolean }> = [];
  const lower = text.toLowerCase();
  let cursor = 0;

  while (cursor < text.length) {
    let bestIdx = -1;
    let bestLen = 0;
    for (const w of words) {
      const idx = lower.indexOf(w, cursor);
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx || (idx === bestIdx && w.length > bestLen))) {
        bestIdx = idx;
        bestLen = w.length;
      }
    }
    if (bestIdx === -1) {
      parts.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (bestIdx > cursor) {
      parts.push({ text: text.slice(cursor, bestIdx), match: false });
    }
    parts.push({ text: text.slice(bestIdx, bestIdx + bestLen), match: true });
    cursor = bestIdx + bestLen;
  }
  return parts.length ? parts : [{ text, match: false }];
}

function createTuiRenderer() {
  function el(
    tag: string,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ) {
    const node = createElement(tag);
    if (props) {
      for (const [key, val] of Object.entries(props)) {
        if (val === undefined) continue;
        if (key === "ref" && typeof val === "function") {
          use(val as (e: unknown) => void, node, undefined);
        } else if (
          typeof val === "function" &&
          !key.startsWith("on") &&
          key !== "renderBefore"
        ) {
          effect((prev: unknown) => setProp(node, key, (val as () => unknown)(), prev));
        } else {
          setProp(node, key, val);
        }
      }
    }
    for (const child of children) {
      if (child === undefined || child === null || child === false) continue;
      if (typeof child === "string") {
        insertNode(node, createTextNode(child));
      } else {
        insert(node, child);
      }
    }
    return node;
  }

  function AutoBackupDialog(props: DialogProps) {
    const [query, setQuery] = createSignal(props.initialQuery || "");
    const [toolFilter, setToolFilter] = createSignal<ToolFilter>("all");
    const [dateFilter, setDateFilter] = createSignal<DateFilter>("all");
    const [focusPane, setFocusPane] = createSignal<"search" | "list" | "preview">("search");
    const [selectedIndex, setSelectedIndex] = createSignal(0);
    const [statusMsg, setStatusMsg] = createSignal("");
    const [refreshTick, setRefreshTick] = createSignal(0);
    const [retentionDays, setRetentionDays] = createSignal(
      readBackupSettings().retentionDays
    );
    const [actionPopupOpen, setActionPopupOpen] = createSignal(false);
    const [actionChoice, setActionChoice] = createSignal<0 | 1 | 2>(0); // 0 = Restore, 1 = Open file, 2 = Open diff in editor

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rootRef: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let listScrollRef: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let previewScrollRef: any;

    // Expand OpenCode's modal container to configured width (defaults to 80% terminal width)
    const resolveDialogWidth = (): string | number => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts = (props.context as any)?.options;
      const raw =
        opts?.dialogWidth ??
        opts?.width ??
        process.env.OPENCODE_BACKUP_DIALOG_WIDTH ??
        process.env.OPENCODE_DIALOG_WIDTH ??
        (readBackupSettings() as { dialogWidth?: string | number }).dialogWidth ??
        "80%";
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        return raw <= 100 ? `${Math.round(raw)}%` : Math.round(raw);
      }
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (/^\d+(\.\d+)?%$/.test(trimmed)) return trimmed;
        const num = Number(trimmed);
        if (Number.isFinite(num) && num > 0) {
          return num <= 100 ? `${Math.round(num)}%` : Math.round(num);
        }
      }
      return "80%";
    };

    const applyDialogWidth = () => {
      if (!rootRef) return;
      try {
        const targetWidth = resolveDialogWidth();
        let cursor = rootRef;
        let dialogBox = rootRef;
        while (cursor.parent && cursor.parent._positionType !== "absolute") {
          cursor = cursor.parent;
          dialogBox = cursor;
        }
        dialogBox.width = targetWidth;
        dialogBox.maxWidth = targetWidth;
        dialogBox.minWidth = 76;

        let inner = rootRef;
        while (inner && inner !== dialogBox) {
          inner.width = "100%";
          inner.maxWidth = "100%";
          inner = inner.parent;
        }
        rootRef.requestRender?.();
      } catch {
        // ignore layout mutation errors
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const theme = (): any => props.context.theme.surface("dialog");

    const allEntries = createMemo<BackupEntry[]>(() => {
      refreshTick();
      return listBackups(props.workspaceDir, {
        includeSubprojects: true
      });
    });

    const filtered = createMemo<BackupEntry[]>(() => {
      const q = query().trim().toLowerCase();
      const terms = q ? q.split(/\s+/).filter(Boolean) : [];
      const tFilter = toolFilter();
      const dFilter = dateFilter();
      const now = Date.now();
      const maxAgeMs =
        dFilter === "24h"
          ? 24 * 60 * 60 * 1000
          : dFilter === "7d"
            ? 7 * 24 * 60 * 60 * 1000
            : dFilter === "30d"
              ? 30 * 24 * 60 * 60 * 1000
              : 0;

      return allEntries().filter((item) => {
        if (tFilter !== "all") {
          const itemTool = (item.tool || "").toLowerCase();
          const itemSlug = (item.slug || "").toLowerCase();
          if (tFilter === "pre-restore") {
            if (!itemSlug.includes("pre-restore") && itemTool !== "restore") return false;
          } else if (tFilter === "patch") {
            if (!itemTool.includes("patch") && !itemSlug.includes("patch")) return false;
          } else if (itemTool !== tFilter && !itemSlug.includes(tFilter)) {
            return false;
          }
        }
        if (maxAgeMs > 0 && item.timeMs && now - item.timeMs > maxAgeMs) {
          return false;
        }
        if (!terms.length) return true;
        const haystack = `${item.relativePath} ${item.backupPath} ${item.originalPath} ${item.root} ${item.snapshotId} ${item.slug}`.toLowerCase();
        return terms.every((t) => haystack.includes(t));
      });
    });

    createEffect(() => {
      query();
      toolFilter();
      dateFilter();
      setSelectedIndex(0);
      queueMicrotask(() => listScrollRef?.scrollTo?.(0));
    });

    const selectedEntry = createMemo<BackupEntry | null>(() => {
      const list = filtered();
      if (!list.length) return null;
      const idx = Math.min(selectedIndex(), list.length - 1);
      return list[idx] || null;
    });

    const diffPreview = createMemo(() => {
      const sel = selectedEntry();
      if (!sel) return null;
      return computeUnifiedDiff(sel.backupPath, sel.originalPath, 42);
    });

    function moveSelection(delta: number) {
      const len = filtered().length;
      if (len === 0) return;
      const next = Math.max(0, Math.min(len - 1, selectedIndex() + delta));
      setSelectedIndex(next);
      queueMicrotask(() => {
        listScrollRef?.scrollChildIntoView?.(`backup-row-${next}`);
        previewScrollRef?.scrollTo?.(0);
      });
    }

    function cycleToolFilter() {
      setToolFilter(
        (prev) => TOOL_CYCLE[(TOOL_CYCLE.indexOf(prev) + 1) % TOOL_CYCLE.length]
      );
    }

    function cycleDateFilter() {
      setDateFilter(
        (prev) => DATE_CYCLE[(DATE_CYCLE.indexOf(prev) + 1) % DATE_CYCLE.length]
      );
    }

    function executeRestore(sel: BackupEntry) {
      try {
        restoreBackupFile(sel);
        setActionPopupOpen(false);
        setStatusMsg(`Restored ${sel.relativePath} from ${sel.snapshotId}`);
        setRefreshTick((t) => t + 1);
        props.context.ui.toast.show({
          title: "Backup Restored",
          message: `${sel.relativePath} (${formatAge(sel.timeMs)})`,
          variant: "success"
        });
      } catch (err) {
        setActionPopupOpen(false);
        setStatusMsg(
          `Restore failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    function executeOpenFile(sel: BackupEntry) {
      try {
        const res = openBackupFile(sel.backupPath);
        setActionPopupOpen(false);
        setStatusMsg(`Opened backup in ${res.launcher}: ${sel.backupPath}`);
        props.context.ui.toast.show({
          title: "Opened Backup File",
          message: sel.backupPath,
          variant: "info"
        });
      } catch (err) {
        setActionPopupOpen(false);
        setStatusMsg(
          `Open failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    function executeOpenDiff(sel: BackupEntry) {
      try {
        const res = openBackupDiff(sel.backupPath, sel.originalPath);
        setActionPopupOpen(false);
        setStatusMsg(`Opened diff (${res.launcher}): ${sel.relativePath}`);
        props.context.ui.toast.show({
          title: "Opened Backup Diff",
          message: `${sel.relativePath} (${sel.snapshotId} vs disk)`,
          variant: "info"
        });
      } catch (err) {
        setActionPopupOpen(false);
        setStatusMsg(
          `Diff failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    function handlePrune() {
      const days = retentionDays();
      if (days <= 0) {
        setStatusMsg(
          "Auto-prune is set to 0 (Never). Press Ctrl+R to change retention days first."
        );
        return;
      }
      const sel = selectedEntry();
      const targetRoot = sel ? sel.root : props.workspaceDir;
      const res = pruneOldBackups(targetRoot, days);
      setStatusMsg(
        `Pruned ${res.removed} snapshot(s) >${days}d in ${path.basename(targetRoot)}`
      );
      setRefreshTick((t) => t + 1);
    }

    function handleCycleRetention() {
      const cur = retentionDays();
      const idx = RETENTION_PRESETS.indexOf(cur);
      const next =
        idx === -1 ? 30 : RETENTION_PRESETS[(idx + 1) % RETENTION_PRESETS.length];
      const saved = writeBackupSettings({ retentionDays: next });
      setRetentionDays(saved.settings.retentionDays);
      const label = next === 0 ? "Never (0 days)" : `${next} days`;
      setStatusMsg(`Auto-prune retention saved: ${label}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleKeyPress = (evt: any) => {
      if (!evt) return;
      const name = String(evt.name || "").toLowerCase();

      // When the 3-option Action Popup is open, route keys to it
      if (actionPopupOpen()) {
        if (name === "escape" || name === "q") {
          evt.preventDefault?.();
          evt.stopPropagation?.();
          setActionPopupOpen(false);
          return;
        }
        if (
          name === "up" ||
          name === "left" ||
          (evt.ctrl && (name === "k" || name === "p"))
        ) {
          evt.preventDefault?.();
          evt.stopPropagation?.();
          setActionChoice((c) => ((c + 2) % 3) as 0 | 1 | 2);
          return;
        }
        if (
          name === "down" ||
          name === "right" ||
          name === "tab" ||
          (evt.ctrl && (name === "j" || name === "n"))
        ) {
          evt.preventDefault?.();
          evt.stopPropagation?.();
          setActionChoice((c) => ((c + 1) % 3) as 0 | 1 | 2);
          return;
        }
        if (name === "1" || name === "r") {
          evt.preventDefault?.();
          evt.stopPropagation?.();
          const sel = selectedEntry();
          if (sel) executeRestore(sel);
          return;
        }
        if (name === "2" || name === "o") {
          evt.preventDefault?.();
          evt.stopPropagation?.();
          const sel = selectedEntry();
          if (sel) executeOpenFile(sel);
          return;
        }
        if (name === "3" || name === "d") {
          evt.preventDefault?.();
          evt.stopPropagation?.();
          const sel = selectedEntry();
          if (sel) executeOpenDiff(sel);
          return;
        }
        if (name === "return" || name === "enter") {
          evt.preventDefault?.();
          evt.stopPropagation?.();
          const sel = selectedEntry();
          if (!sel) {
            setActionPopupOpen(false);
            return;
          }
          if (actionChoice() === 0) {
            executeRestore(sel);
          } else if (actionChoice() === 1) {
            executeOpenFile(sel);
          } else {
            executeOpenDiff(sel);
          }
          return;
        }
        return;
      }

      if (name === "escape") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        props.close();
        return;
      }

      if (name === "tab") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        const order: Array<"search" | "list" | "preview"> = ["search", "list", "preview"];
        const idx = order.indexOf(focusPane());
        const next = order[(idx + (evt.shift ? -1 : 1) + order.length) % order.length];
        setFocusPane(next);
        return;
      }

      if (
        name === "up" ||
        (evt.ctrl && (name === "k" || name === "p")) ||
        ((focusPane() === "list" || focusPane() === "preview") && !evt.ctrl && name === "k")
      ) {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        if (focusPane() === "preview") {
          previewScrollRef?.scrollBy?.(-2);
        } else {
          moveSelection(-1);
        }
        return;
      }

      if (
        name === "down" ||
        (evt.ctrl && (name === "j" || name === "n")) ||
        ((focusPane() === "list" || focusPane() === "preview") && !evt.ctrl && name === "j")
      ) {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        if (focusPane() === "preview") {
          previewScrollRef?.scrollBy?.(2);
        } else {
          moveSelection(1);
        }
        return;
      }

      if (name === "pageup") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        if (focusPane() === "preview") {
          previewScrollRef?.scrollBy?.(-8);
        } else {
          moveSelection(-6);
        }
        return;
      }

      if (name === "pagedown") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        if (focusPane() === "preview") {
          previewScrollRef?.scrollBy?.(8);
        } else {
          moveSelection(6);
        }
        return;
      }

      if (evt.ctrl && name === "u") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        setQuery("");
        setToolFilter("all");
        setDateFilter("all");
        setSelectedIndex(0);
        listScrollRef?.scrollTo?.(0);
        return;
      }

      if (name === "return" || name === "enter") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        if (selectedEntry()) {
          setActionChoice(0);
          setActionPopupOpen(true);
        }
        return;
      }

      if (evt.ctrl && name === "t") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        cycleToolFilter();
        return;
      }

      if (evt.ctrl && name === "g") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        cycleDateFilter();
        return;
      }

      if (evt.ctrl && name === "r") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        handleCycleRetention();
        return;
      }

      if (evt.ctrl && name === "d") {
        evt.preventDefault?.();
        evt.stopPropagation?.();
        handlePrune();
        return;
      }
    };

    onMount(() => {
      props.context.renderer.keyInput.prependListener("keypress", handleKeyPress);
      applyDialogWidth();
      queueMicrotask(() => {
        applyDialogWidth();
      });
    });

    onCleanup(() => {
      props.context.renderer.keyInput.removeListener("keypress", handleKeyPress);
    });

    const Pill = (pillProps: {
      label: () => string;
      shortcut?: string;
      active: () => boolean;
      onClick: () => void;
    }) =>
      el(
        "box",
        {
          flexDirection: "row",
          flexShrink: 0,
          paddingX: 1,
          backgroundColor: () =>
            pillProps.active()
              ? theme().background.action.primary.focused
              : theme().background.raised.base,
          onMouseUp: pillProps.onClick
        },
        el(
          "text",
          {
            fg: () =>
              pillProps.active()
                ? theme().text.action.primary.focused
                : theme().text.base,
            attributes: () => (pillProps.active() ? TextAttributes.BOLD : undefined)
          },
          pillProps.label
        ),
        pillProps.shortcut
          ? el(
              "text",
              {
                fg: () =>
                  pillProps.active()
                    ? theme().text.action.primary.focused
                    : theme().text.muted
              },
              ` ${pillProps.shortcut}`
            )
          : null
      );

    return el(
      "box",
      {
        ref: (r: unknown) => {
          rootRef = r;
          queueMicrotask(applyDialogWidth);
        },
        width: "100%",
        height: 28,
        flexDirection: "column",
        backgroundColor: () => theme().background.base
      },
      // 1. Header Bar
      el(
        "box",
        {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingX: 2,
          paddingTop: 1,
          flexShrink: 0
        },
        el(
          "box",
          { flexDirection: "row", gap: 2, alignItems: "center" },
          el(
            "text",
            {
              fg: () => theme().text.base,
              attributes: TextAttributes.BOLD
            },
            "Auto-Backup Snapshots"
          ),
          el(
            "text",
            { fg: () => theme().text.muted },
            () =>
              statusMsg() ||
              `${filtered().length} of ${allEntries().length} snapshots`
          )
        ),
        el(
          "box",
          { flexDirection: "row", gap: 2, alignItems: "center" },
          el(
            "text",
            { fg: () => theme().text.muted },
            () => props.context.ui.format.path(props.workspaceDir)
          ),
          el(
            "box",
            { paddingX: 1, onMouseUp: () => props.close() },
            el("text", { fg: () => theme().text.muted }, "esc")
          )
        )
      ),

      // 2. Search Input + Colored Filter Pills Bar (matching session-search & local-memory)
      el(
        "box",
        {
          flexDirection: "column",
          paddingX: 2,
          paddingY: 1,
          gap: 1,
          flexShrink: 0,
          border: ["bottom"],
          borderColor: () => theme().border.base
        },
        el(
          "box",
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 1
          },
          el(
            "text",
            {
              fg: () =>
                focusPane() === "search" && !actionPopupOpen()
                  ? theme().text.action.primary.base
                  : theme().text.muted,
              attributes: TextAttributes.BOLD
            },
            "›"
          ),
          el("input", {
            id: "auto-backup-search-input",
            flexGrow: 1,
            value: () => query(),
            focused: () => focusPane() === "search" && !actionPopupOpen(),
            maxLength: Number.POSITIVE_INFINITY,
            placeholder:
              "Filter backups by file path, parent folder, or snapshot slug... (0 tokens)",
            placeholderColor: () => theme().text.muted,
            textColor: () => theme().text.base,
            focusedTextColor: () => theme().text.formfield.focused,
            cursorColor: () => theme().text.formfield.focused,
            backgroundColor: () => theme().background.base,
            focusedBackgroundColor: () => theme().background.formfield.focused,
            onMouseDown: () => setFocusPane("search"),
            onInput: (val: string) => {
              setQuery(typeof val === "string" ? val : "");
            }
          })
        ),
        // Colored Filter Pills Row
        el(
          "box",
          {
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 1,
            alignItems: "center"
          },
          Pill({
            label: () => `tool:${toolFilter()}`,
            shortcut: "^t",
            active: () => toolFilter() !== "all",
            onClick: cycleToolFilter
          }),
          Pill({
            label: () => `date:${dateFilter()}`,
            shortcut: "^g",
            active: () => dateFilter() !== "all",
            onClick: cycleDateFilter
          }),
          Pill({
            label: () =>
              `prune:${
                retentionDays() === 0 ? "never (0d)" : `${retentionDays()}d`
              }`,
            shortcut: "^r",
            active: () => retentionDays() !== 30,
            onClick: handleCycleRetention
          }),
          Pill({
            label: () => "prune now",
            shortcut: "^d",
            active: () => false,
            onClick: handlePrune
          })
        )
      ),

      // 3. Action Confirmation Sub-Popup (wrapped in its own container so @opentui/solid Show cleanup never clears rootRef siblings)
      el(
        "box",
        { flexDirection: "column", flexShrink: 0 },
        createComponent(Show, {
          get when() {
            return actionPopupOpen() && Boolean(selectedEntry());
          },
          get children() {
            return el(
              "box",
              {
                flexDirection: "column",
                marginX: 2,
                marginTop: 1,
                paddingX: 2,
                paddingY: 1,
                gap: 1,
                border: ["top", "bottom", "left", "right"],
                borderColor: () => theme().text.action.primary.base,
                backgroundColor: () => theme().background.raised.base,
                flexShrink: 0
              },
              el(
                "box",
                { flexDirection: "row", justifyContent: "space-between" },
                el(
                  "text",
                  {
                    fg: () => theme().text.action.primary.base,
                    attributes: TextAttributes.BOLD
                  },
                  () => `Action for: ${selectedEntry()?.relativePath ?? ""}`
                ),
                el(
                  "text",
                  { fg: () => theme().text.muted },
                  "↑/↓ or 1/2/3 choose · Enter confirm · Esc cancel"
                )
              ),
              el(
                "text",
                { fg: () => theme().text.muted, wrapMode: "none", truncate: true },
                () => `Backup file: ${selectedEntry()?.backupPath ?? ""}`
              ),
              el(
                "box",
                { flexDirection: "row", flexWrap: "wrap", gap: 2, marginTop: 0 },
                // Option 1: Restore
                el(
                  "box",
                  {
                    paddingX: 2,
                    paddingY: 0,
                    backgroundColor: () =>
                      actionChoice() === 0
                        ? theme().background.action.primary.focused
                        : theme().background.base,
                    onMouseUp: () => {
                      const sel = selectedEntry();
                      if (sel) executeRestore(sel);
                    }
                  },
                  el(
                    "text",
                    {
                      fg: () =>
                        actionChoice() === 0
                          ? theme().text.action.primary.focused
                          : theme().text.base,
                      attributes: () =>
                        actionChoice() === 0 ? TextAttributes.BOLD : undefined
                    },
                    () =>
                      `${actionChoice() === 0 ? "› " : "  "}[1] Restore file`
                  )
                ),
                // Option 2: Open File
                el(
                  "box",
                  {
                    paddingX: 2,
                    paddingY: 0,
                    backgroundColor: () =>
                      actionChoice() === 1
                        ? theme().background.action.primary.focused
                        : theme().background.base,
                    onMouseUp: () => {
                      const sel = selectedEntry();
                      if (sel) executeOpenFile(sel);
                    }
                  },
                  el(
                    "text",
                    {
                      fg: () =>
                        actionChoice() === 1
                          ? theme().text.action.primary.focused
                          : theme().text.base,
                      attributes: () =>
                        actionChoice() === 1 ? TextAttributes.BOLD : undefined
                    },
                    () =>
                      `${actionChoice() === 1 ? "› " : "  "}[2] Open backup file`
                  )
                ),
                // Option 3: Open Side-by-Side Diff in Editor
                el(
                  "box",
                  {
                    paddingX: 2,
                    paddingY: 0,
                    backgroundColor: () =>
                      actionChoice() === 2
                        ? theme().background.action.primary.focused
                        : theme().background.base,
                    onMouseUp: () => {
                      const sel = selectedEntry();
                      if (sel) executeOpenDiff(sel);
                    }
                  },
                  el(
                    "text",
                    {
                      fg: () =>
                        actionChoice() === 2
                          ? theme().text.action.primary.focused
                          : theme().text.base,
                      attributes: () =>
                        actionChoice() === 2 ? TextAttributes.BOLD : undefined
                    },
                    () =>
                      `${actionChoice() === 2 ? "› " : "  "}[3] Open diff in editor (backup vs current)`
                  )
                )
              )
            );
          }
        })
      ),

      // 4. Main Split View (Left: Two-line Snapshot List with Parent Folder, Right: Full Paths + Colored Diff)
      el(
        "box",
        {
          flexDirection: "row",
          flexGrow: 1,
          minHeight: 0
        },
        // Left Pane: Snapshot List (44% width, matching session-search & local-memory)
        el(
          "scrollbox",
          {
            id: "auto-backup-list",
            ref: (r: unknown) => {
              listScrollRef = r;
            },
            width: "44%",
            height: "100%",
            flexShrink: 0,
            border: ["right"],
            borderColor: () =>
              focusPane() === "list" ? theme().text.base : theme().border.base,
            scrollbarOptions: { visible: false },
            onMouseDown: () => setFocusPane("list")
          },
          createComponent(Show, {
            get when() {
              return filtered().length > 0;
            },
            get fallback() {
              return el(
                "box",
                { paddingX: 2, paddingY: 1 },
                el(
                  "text",
                  { fg: () => theme().text.muted },
                  "No matching backup snapshots found."
                )
              );
            },
            get children() {
              return createComponent(For, {
                get each() {
                  return filtered();
                },
                children: (item: BackupEntry, idx: () => number) => {
                  const isSel = () => idx() === selectedIndex();
                  return el(
                    "box",
                    {
                      id: () => `backup-row-${idx()}`,
                      flexDirection: "column",
                      paddingX: 1,
                      paddingY: 0,
                      marginBottom: 1,
                      flexShrink: 0,
                      backgroundColor: () =>
                        isSel()
                          ? theme().background.action.primary.focused
                          : undefined,
                      onMouseUp: () => {
                        setSelectedIndex(idx());
                        setActionChoice(0);
                        setActionPopupOpen(true);
                      },
                      onMouseOver: () => {
                        setSelectedIndex(idx());
                      }
                    },
                    // Line 1: Backed-up file relative path + [tool] badge + age
                    el(
                      "box",
                      {
                        flexDirection: "row",
                        justifyContent: "space-between",
                        width: "100%"
                      },
                      el(
                        "text",
                        {
                          wrapMode: "none",
                          truncate: true,
                          flexShrink: 1,
                          minWidth: 0,
                          fg: () =>
                            isSel()
                              ? theme().text.action.primary.focused
                              : theme().text.base,
                          attributes: () =>
                            isSel() ? TextAttributes.BOLD : undefined
                        },
                        () => `${isSel() ? "› " : "  "}${item.relativePath}`
                      ),
                      el(
                        "text",
                        {
                          wrapMode: "none",
                          flexShrink: 0,
                          fg: () =>
                            isSel()
                              ? theme().text.action.primary.focused
                              : theme().text.action.primary.base
                        },
                        () =>
                          ` [${item.tool || "auto"}] ${formatAge(item.timeMs)}`
                      )
                    ),
                    // Line 2: Parent backup folder directly underneath
                    el(
                      "text",
                      {
                        wrapMode: "none",
                        truncate: true,
                        fg: () =>
                          isSel()
                            ? theme().text.action.primary.focused
                            : theme().text.muted
                      },
                      () => `  ↳ ${formatParentBackupPath(item)}`
                    )
                  );
                }
              });
            }
          })
        ),

        // Right Pane: Full Paths + Unified Diff Preview (56% width)
        el(
          "scrollbox",
          {
            id: "auto-backup-preview",
            ref: (r: unknown) => {
              previewScrollRef = r;
            },
            flexGrow: 1,
            minWidth: 0,
            minHeight: 0,
            paddingX: 2,
            paddingY: 1,
            focused: () => focusPane() === "preview",
            onMouseDown: () => setFocusPane("preview")
          },
          createComponent(Show, {
            get when() {
              return Boolean(selectedEntry() && diffPreview());
            },
            get fallback() {
              return el(
                "text",
                { fg: () => theme().text.muted },
                "Select a snapshot on the left to inspect its full path and diff."
              );
            },
            get children() {
              return el(
                "box",
                { flexDirection: "column", gap: 1 },
                // Colored left-border header card
                el(
                  "box",
                  {
                    flexDirection: "column",
                    paddingLeft: 1,
                    border: ["left"],
                    borderColor: () => theme().text.action.primary.base
                  },
                  el(
                    "box",
                    {
                      flexDirection: "row",
                      justifyContent: "space-between",
                      width: "100%"
                    },
                    el(
                      "text",
                      {
                        fg: () => theme().text.base,
                        attributes: TextAttributes.BOLD
                      },
                      () => selectedEntry()?.relativePath ?? ""
                    ),
                    el(
                      "text",
                      {
                        fg: () => theme().text.action.primary.base,
                        attributes: TextAttributes.BOLD
                      },
                      () =>
                        `[${(selectedEntry()?.tool || "auto").toUpperCase()} · ${formatBytes(selectedEntry()?.size ?? 0)} · ${formatAge(selectedEntry()?.timeMs ?? 0)}]`
                    )
                  ),
                  el(
                    "text",
                    { fg: () => theme().text.muted },
                    () => `Snapshot: ${selectedEntry()?.snapshotId ?? ""}`
                  ),
                  el(
                    "text",
                    { fg: () => theme().text.base, wrapMode: "word" },
                    () => `Original: ${selectedEntry()?.originalPath ?? ""}`
                  ),
                  el(
                    "text",
                    { fg: () => theme().text.muted, wrapMode: "word" },
                    () => `Backup:   ${selectedEntry()?.backupPath ?? ""}`
                  )
                ),

                // Diff section header
                el(
                  "text",
                  {
                    fg: () => theme().text.action.primary.base,
                    attributes: TextAttributes.BOLD,
                    marginTop: 1
                  },
                  () => diffPreview()?.summary ?? ""
                ),

                // Colored diff lines inside a subtle left-bordered block
                el(
                  "box",
                  {
                    flexDirection: "column",
                    paddingLeft: 1,
                    border: ["left"],
                    borderColor: () => theme().border.base
                  },
                  createComponent(For, {
                    get each() {
                      return diffPreview()?.lines ?? [];
                    },
                    children: (line: { type: string; text: string }) =>
                      el(
                        "text",
                        {
                          fg: () =>
                            line.type === "add"
                              ? theme().text.feedback?.success?.base ??
                                theme().text.action.primary.base
                              : line.type === "del"
                                ? theme().text.feedback?.error?.base ??
                                  "#f87171"
                                : line.text.startsWith("@@")
                                  ? theme().text.action.primary.base
                                  : theme().text.muted,
                          attributes: () =>
                            line.type === "add" || line.type === "del"
                              ? TextAttributes.BOLD
                              : undefined,
                          wrapMode: "none",
                          truncate: true
                        },
                        createComponent(For, {
                          get each() {
                            return splitHighlightedText(line.text, query());
                          },
                          children: (seg: { text: string; match: boolean }) =>
                            el(
                              "span",
                              {
                                fg: () =>
                                  seg.match
                                    ? theme().text.action.primary.base
                                    : undefined,
                                attributes: () =>
                                  seg.match ? TextAttributes.BOLD : undefined
                              },
                              seg.text
                            )
                        })
                      )
                  })
                )
              );
            }
          })
        )
      ),

      // 5. Footer Shortcut Bar
      el(
        "box",
        {
          flexDirection: "row",
          justifyContent: "space-between",
          gap: 2,
          paddingX: 2,
          paddingY: 1,
          flexShrink: 0,
          border: ["top"],
          borderColor: () => theme().border.base
        },
        el(
          "text",
          {
            fg: () => theme().text.muted,
            flexShrink: 1,
            minWidth: 0,
            wrapMode: "none",
            truncate: true
          },
          "enter actions (restore / open) · ↑/↓ or ^j/^k move · ^t tool · ^g date · ^r retention · ^d prune · tab pane"
        ),
        el(
          "text",
          { fg: () => theme().text.muted, flexShrink: 0, wrapMode: "none" },
          "0 tokens"
        )
      )
    );
  }

  return (props: DialogProps) => createComponent(AutoBackupDialog, props);
}

async function openFallbackSelectDialog(
  context: TuiPluginContext,
  workspaceDir: string,
  initialQuery: string
) {
  const all = listBackups(workspaceDir, { includeSubprojects: true });
  const q = initialQuery.trim().toLowerCase();
  const entries = q
    ? all.filter(
        (item: BackupEntry) =>
          item.relativePath.toLowerCase().includes(q) ||
          item.backupPath.toLowerCase().includes(q) ||
          item.snapshotId.toLowerCase().includes(q)
      )
    : all;

  if (!entries.length) {
    context.ui.toast.show({
      title: "Auto-Backup",
      message: "No backup snapshots found.",
      variant: "warning"
    });
    return;
  }

  const selectedId = await context.ui.dialog.select<string>({
    title: "Auto-Backup Snapshots (0 tokens)",
    placeholder: "Filter backups...",
    options: entries.map((e: BackupEntry) => ({
      title: `${e.relativePath} (${formatAge(e.timeMs)})`,
      value: e.id,
      description: `Backup: ${e.backupPath}`,
      footer: `Original: ${e.originalPath} · ${formatBytes(e.size)}`
    }))
  });

  if (!selectedId) return;
  const chosen = entries.find((e: BackupEntry) => e.id === selectedId);
  if (!chosen) return;

  const action = await context.ui.dialog.select<string>({
    title: `Action for ${chosen.relativePath}`,
    placeholder: "Choose action...",
    options: [
      {
        title: "Restore file",
        value: "restore",
        description: `Revert ${chosen.originalPath} to this snapshot (creates safety backup first)`
      },
      {
        title: "Open backup file",
        value: "open",
        description: `Open ${chosen.backupPath} in your default system editor`
      }
    ]
  });

  if (action === "restore") {
    restoreBackupFile(chosen);
    context.ui.toast.show({
      title: "Backup Restored",
      message: `${chosen.relativePath} restored from ${chosen.snapshotId}`,
      variant: "success"
    });
  } else if (action === "open") {
    openBackupFile(chosen.backupPath);
    context.ui.toast.show({
      title: "Opened Backup File",
      message: chosen.backupPath,
      variant: "info"
    });
  }
}

export default {
  id: "opencode-local-backup",
  async setup(context: TuiPluginContext) {
    if (!context?.ui) {
      return;
    }
    const workspaceDir = context.location?.directory ?? process.cwd();
    const renderDialog = createTuiRenderer();

    const openBackupsPopup = async (rawArgs?: unknown) => {
      const initialQuery =
        typeof rawArgs === "string"
          ? rawArgs.trim()
          : typeof (rawArgs as { arguments?: unknown } | undefined)?.arguments === "string"
            ? ((rawArgs as { arguments: string }).arguments).trim()
            : "";

      try {
        context.ui.dialog.show(() =>
          renderDialog({
            context,
            workspaceDir,
            initialQuery,
            close: () => context.ui.dialog.clear()
          })
        );
        context.ui.dialog.set({
          size: "xlarge",
          centered: true
        });
      } catch {
        await openFallbackSelectDialog(context, workspaceDir, initialQuery);
      }
    };

    let layerRegistered = false;
    context.ui.slot({
      append: "app",
      render() {
        if (!layerRegistered) {
          layerRegistered = true;
          context.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: "auto.backup.browse",
                title: "Browse & restore file backups (0 tokens)...",
                description:
                  "Interactive zero-token popup to browse .backups/ snapshots, preview diffs, restore files, or open backup files",
                category: "Backup",
                palette: true,
                slash: {
                  name: "backups",
                  arguments: true
                },
                run: (input) => {
                  void openBackupsPopup(input);
                }
              },
              {
                id: "auto.backup.browse.alias.backup",
                title: "Browse & restore file backups (/backup)",
                category: "Backup",
                palette: false,
                slash: {
                  name: "backup",
                  arguments: true
                },
                run: (input) => {
                  void openBackupsPopup(input);
                }
              },
              {
                id: "auto.backup.browse.alias.restore",
                title: "Browse & restore file backups (/restore)",
                category: "Backup",
                palette: false,
                slash: {
                  name: "restore",
                  arguments: true
                },
                run: (input) => {
                  void openBackupsPopup(input);
                }
              },
              {
                id: "auto.backup.browse.alias.snapshots",
                title: "Browse & restore file backups (/snapshots)",
                category: "Backup",
                palette: false,
                slash: {
                  name: "snapshots",
                  arguments: true
                },
                run: (input) => {
                  void openBackupsPopup(input);
                }
              }
            ]
          }));
        }
        return null;
      }
    });
  }
};
