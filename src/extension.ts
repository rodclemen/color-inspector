import * as vscode from "vscode";

/**
 * Color Inspector — extension.ts
 *
 * Manual scan by default.
 * Optional auto-scan interval via setting: colorInspector.autoScanMinutes (0–10).
 */

type HitRange = {
  line: number; // 1-based
  startCol: number; // 0-based
  endCol: number; // 0-based
};

type UsageHit = {
  file: string; // workspace-relative
  line: number; // 1-based
  scope: string; // ".pair-card", "div", etc.
  prop: string; // "border", "background", "filter", etc.
  sample: string; // trimmed line/sample
};

type ColorHit =
  | {
      kind: "var";
      name: string; // --border
      value: string; // #aabbcc / rgba(...)
      file: string;
      range: HitRange;
      usages: UsageHit[];
    }
  | {
      kind: "literal";
      value: string; // #aabbcc / rgba(...)
      file: string;
      range: HitRange;
      usages: UsageHit[];
    };

const WS_KEY_ALLOW_SPACE = "colorInspector.allowAutoSpaceForHex";

async function confirmAutoSpaceIfNeeded(
  workspaceState: vscode.Memento,
  beforeLine: string,
  afterLine: string
): Promise<"allowOnce" | "allowAlways" | "deny"> {
  const saved = workspaceState.get<boolean | undefined>(WS_KEY_ALLOW_SPACE);

  if (saved === true) {
    return "allowAlways";
  }
  if (saved === false) {
    return "deny";
  }

  const arrow = "↓";
  const message = `Even hex codes need personal space.\nLets fix that!\n\n${beforeLine}\n${arrow}\n${afterLine}`;

  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    "Fix that",
    "Always allow in this workspace",
    "Cancel"
  );

  if (choice === "Fix that") {
    return "allowOnce";
  }

  if (choice === "Always allow in this workspace") {
    await workspaceState.update(WS_KEY_ALLOW_SPACE, true);
    return "allowAlways";
  }

  return "deny";
}

class ColorInspectorViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "colorInspector.view";
  private view?: vscode.WebviewView;

  // Manual-first UX
  private hasScanned = false;

  // Autoscan
  private autoScanTimer: NodeJS.Timeout | undefined;

  // Last scan info for header + import list
  private lastRootRel = "";
  private lastTotalColors = 0;
  private lastImportCount = 0;
  private lastImportFiles: { file: string; colors: number }[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg.type !== "string") {
        return;
      }

      if (msg.type === "copy" && typeof msg.value === "string") {
        await vscode.env.clipboard.writeText(msg.value);
        vscode.window.showInformationMessage(`${msg.value} copied`);
        return;
      }

      if (msg.type === "open" && typeof msg.file === "string" && typeof msg.line === "number") {
        await openFileAtLine(msg.file, msg.line);
        return;
      }

      if (
        msg.type === "pickVscode" &&
        typeof msg.file === "string" &&
        typeof msg.line === "number" &&
        typeof msg.startCol === "number" &&
        typeof msg.endCol === "number"
      ) {
        await openFileSelectRangeAndPickVscode(
          this.context.workspaceState,
          msg.file,
          msg.line,
          msg.startCol,
          msg.endCol
        );
        return;
      }

      if (msg.type === "refresh") {
        this.hasScanned = true;
        await this.render();
        return;
      }

      if (msg.type === "toggleImports") {
        // Purely UI-side; no action needed.
        return;
      }

      if (msg.type === "openSettings") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "@ext:rodclemen.color-inspector"
        );
        return;
      }
    });

    // Initial idle UI (NO auto-scan on open)
    webviewView.webview.html = this.htmlIdle();

    // Start auto-scan timer if enabled
    this.restartAutoScanFromSettings();

    // Restart timer when setting changes
    const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("colorInspector.autoScanMinutes")) {
        this.restartAutoScanFromSettings();
      }
    });

    // Cleanup
    webviewView.onDidDispose(() => {
      this.stopAutoScan();
      cfgSub.dispose();
    });
  }

  private stopAutoScan() {
    if (this.autoScanTimer) {
      clearInterval(this.autoScanTimer);
      this.autoScanTimer = undefined;
    }
  }

  private restartAutoScanFromSettings() {
    this.stopAutoScan();

    const mins = vscode.workspace.getConfiguration().get<number>("colorInspector.autoScanMinutes", 0);
    if (!mins || mins <= 0) {
      return;
    }
    const clamped = Math.max(1, Math.min(10, Math.floor(mins)));
    const ms = clamped * 60 * 1000;

    this.autoScanTimer = setInterval(() => {
      // Only scan if we have an active editor and the view exists
      if (!this.view) {
        return;
      }
      if (!vscode.window.activeTextEditor) {
        return;
      }
      // Only auto-scan after the user has scanned at least once (avoids surprise work)
      if (!this.hasScanned) {
        return;
      }
      void this.render();
    }, ms);
  }

  public async render() {
    if (!this.view) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.view.webview.html = this.htmlIdle("No active editor. Open a file, then press Scan.");
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.view.webview.html = this.htmlIdle("No workspace folder open.");
      return;
    }
    const wsRoot = folders[0].uri;

    const rootDoc = editor.document;
    const rootUri = rootDoc.uri;

    // Hard stop: follow ONLY explicit imports
    const uris = await collectImportGraph(rootUri, wsRoot, 160);

    // Scan all files
    const allHits: ColorHit[] = [];
    const perFileColorCounts = new Map<string, number>();

    for (const uri of uris) {
      let text = "";
      try {
        text = await readUriText(uri);
      } catch {
        continue;
      }

      const fileLabel = vscode.workspace.asRelativePath(uri, false);
      const lineStarts = buildLineStartIndex(text);

      const hits = scanTextForColorsAndUsages(text, lineStarts, fileLabel);
      allHits.push(...hits);

      perFileColorCounts.set(fileLabel, (perFileColorCounts.get(fileLabel) ?? 0) + hits.length);
    }

    // De-dupe across files:
    const varSeen = new Set<string>();
    const litSeen = new Set<string>();
    const merged: ColorHit[] = [];

    for (const h of allHits) {
      const normVal = normalizeColorKey(h.value);
      if (h.kind === "var") {
        const key = `${h.file}|${h.name}=${normVal}`.toLowerCase();
        if (!varSeen.has(key)) {
          varSeen.add(key);
          merged.push(h);
        }
      } else {
        const key = `${h.file}|${normVal}`.toLowerCase();
        if (!litSeen.has(key)) {
          litSeen.add(key);
          merged.push(h);
        }
      }
    }

    // Group by file (in UI)
    merged.sort((a, b) => {
      const f = a.file.localeCompare(b.file);
      if (f !== 0) {
        return f;
      }
      if (a.kind !== b.kind) {
        return a.kind === "var" ? -1 : 1;
      }
      if (a.kind === "var" && b.kind === "var") {
        const n = a.name.localeCompare(b.name);
        if (n !== 0) {
          return n;
        }
      }
      const v = a.value.localeCompare(b.value);
      if (v !== 0) {
        return v;
      }
      return a.range.line - b.range.line;
    });

    // Header: workingfolder/path | xx colors | +N Import(s)
    const rootRel = vscode.workspace.asRelativePath(rootDoc.uri, false);
    const totalColors = merged.length;
    const importCount = Math.max(0, uris.length - 1);

    const importFiles: { file: string; colors: number }[] = [];
    for (const uri of uris) {
      const fileLabel = vscode.workspace.asRelativePath(uri, false);
      if (fileLabel === rootRel) {
        continue;
      }
      importFiles.push({ file: fileLabel, colors: perFileColorCounts.get(fileLabel) ?? 0 });
    }

    this.lastRootRel = rootRel;
    this.lastTotalColors = totalColors;
    this.lastImportCount = importCount;
    this.lastImportFiles = importFiles;

    this.view.webview.html = this.htmlMain(merged);
  }

  private htmlIdle(message?: string): string {
    const msg = message ?? "Ready. Press Scan to start.";
    return this.htmlShell({
      headerLeft: escapeHtml(`Color Inspector`),
      headerMid: escapeHtml(msg),
      headerRight: "",
      imports: [],
      groups: [],
      buttonLabel: "Scan",
      showImportsToggle: false,
      autoScanMinutes: vscode.workspace.getConfiguration().get<number>("colorInspector.autoScanMinutes", 0),
    });
  }

  private htmlMain(colors: ColorHit[]): string {
    const importCount = this.lastImportCount;
    const importLabel = importCount === 1 ? "Import" : "Imports";
    const importsClickable = importCount > 0;

    const headerLeft = escapeHtml(this.lastRootRel);
    const headerMid = escapeHtml(`${this.lastTotalColors} colors`);
    const headerRight = importCount > 0 ? escapeHtml(`+${importCount} ${importLabel}`) : escapeHtml(`+0 Imports`);

    // Group by file
    const byFile = new Map<string, ColorHit[]>();
    for (const c of colors) {
      const arr = byFile.get(c.file) ?? [];
      arr.push(c);
      byFile.set(c.file, arr);
    }

    const groups = Array.from(byFile.entries()).map(([file, hits]) => {
      // Sort within group: vars first, then literals, then line
      hits.sort((a, b) => {
        if (a.kind !== b.kind) {
          return a.kind === "var" ? -1 : 1;
        }
        if (a.kind === "var" && b.kind === "var") {
          const n = a.name.localeCompare(b.name);
          if (n !== 0) {
            return n;
          }
        }
        const v = a.value.localeCompare(b.value);
        if (v !== 0) {
          return v;
        }
        return a.range.line - b.range.line;
      });

      return {
        file,
        count: hits.length,
        hits,
      };
    });

    // Root file group first
    groups.sort((a, b) => {
      if (a.file === this.lastRootRel) return -1;
      if (b.file === this.lastRootRel) return 1;
      return a.file.localeCompare(b.file);
    });

    const imports = this.lastImportFiles;

    const buttonLabel = this.hasScanned ? "Refresh" : "Scan";
    const autoScanMinutes = vscode.workspace.getConfiguration().get<number>("colorInspector.autoScanMinutes", 0);

    return this.htmlShell({
      headerLeft,
      headerMid,
      headerRight,
      imports,
      groups,
      buttonLabel,
      showImportsToggle: importsClickable,
      autoScanMinutes,
    });
  }

  private htmlShell(args: {
    headerLeft: string;
    headerMid: string;
    headerRight: string;
    imports: { file: string; colors: number }[];
    groups: { file: string; count: number; hits: ColorHit[] }[];
    buttonLabel: string;
    showImportsToggle: boolean;
    autoScanMinutes: number;
  }): string {
    const importsRows =
      args.imports.length === 0
        ? ""
        : args.imports
            .map((i) => `<div class="importRow">${escapeHtml(i.file)} <span class="muted">(${i.colors})</span></div>`)
            .join("");

    const groupsHtml =
      args.groups.length === 0
        ? `<div class="empty">No colors found.</div>`
        : args.groups
            .map((g) => {
              const rows = g.hits.map((c, idx) => this.renderColorRow(c, `${g.file}::${idx}`)).join("");
              return `
<div class="group">
  <div class="groupHeader" title="${escapeHtml(g.file)}">${escapeHtml(g.file)} <span class="muted">(${g.count})</span></div>
  <div class="groupBody">
    ${rows}
  </div>
</div>`;
            })
            .join("");

    const importsToggle =
      args.showImportsToggle && args.imports.length > 0
        ? `<button id="importsToggle" class="importsToggle" title="Show imports">${args.headerRight}</button>`
        : `<div class="importsStatic">${args.headerRight}</div>`;

    const importPanel =
      args.imports.length > 0
        ? `<div id="importsPanel" class="importsPanel" style="display:none;">
             ${importsRows}
           </div>`
        : "";

    const autoScanInfo =
      args.autoScanMinutes && args.autoScanMinutes > 0
        ? `<div class="mutedSmall">Auto-scan: every ${Math.max(1, Math.min(10, Math.floor(args.autoScanMinutes)))} min</div>`
        : `<div class="mutedSmall">Auto-scan: off</div>`;

    // NOTE: using your requested theme vars/styles
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }

    .top {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      padding:10px 10px 8px;
      border-bottom: 1px solid var(--vscode-sideBar-border);
      background: var(--vscode-sideBar-background);
    }

    .topLeft {
      display:flex;
      flex-direction:column;
      gap:2px;
      min-width:0;
      flex: 1 1 auto;
    }

    .topLine {
      display:flex;
      gap:10px;
      align-items:baseline;
      min-width:0;
      flex-wrap:wrap;
    }

    .titleLeft { font-size:12px; font-weight:700; opacity:.95; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width: 100%; }
    .titleMid { font-size:12px; font-weight:700; opacity:.85; white-space:nowrap; }
    .importsToggle {
      font-size:12px;
      font-weight:800;
      color: var(--vscode-textLink-foreground);
      background: transparent;
      border: 0;
      padding: 0;
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .importsStatic { font-size:12px; font-weight:800; opacity:.7; }

    .muted { opacity: .75; font-weight: 600; }
    .mutedSmall { font-size: 11px; opacity: .75; }

    .topRight { display:flex; flex-direction:column; gap:6px; align-items:flex-end; }

    button { font: inherit; }
    .actionBtn {
      padding:6px 10px;
      border-radius:8px;
      border:1px solid color-mix(in srgb, CanvasText 20%, transparent);
      background: color-mix(in srgb, Canvas 92%, CanvasText 8%);
      cursor:pointer;
      font-weight:700;
      font-size:12px;
    }
    .actionBtn:hover {
      background: color-mix(in srgb, Canvas 80%, CanvasText 20%);
    }

    .settingsBtn {
      padding:4px 10px;
      border-radius:8px;
      border:1px solid color-mix(in srgb, CanvasText 12%, transparent);
      background: transparent;
      cursor:pointer;
      font-size:11px;
      opacity:.8;
    }
    .settingsBtn:hover { opacity: 1; }

    .importsPanel {
      padding: 10px 10px 6px;
      border-bottom: 1px solid var(--vscode-sideBar-border);
      background: var(--vscode-sideBar-background);
    }
    .importRow {
      font-size: 12px;
      padding: 4px 0;
      border-bottom: 1px dashed color-mix(in srgb, CanvasText 12%, transparent);
    }
    .importRow:last-child { border-bottom: 0; }

    .content {
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: var(--vscode-sideBar-background);
    }

    .group { border:1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius:12px; overflow:hidden; }
    .groupHeader {
      padding: 8px 10px;
      font-size: 12px;
      font-weight: 800;
      background: color-mix(in srgb, CanvasText 5%, transparent);
      color: var(--vscode-sideBarSectionHeader-foreground);
      border-bottom: 1px solid var(--vscode-sideBar-border);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .groupBody {
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: var(--vscode-editor-background);
    }

    .row {
      display:flex;
      gap:10px;
      align-items:center;
      padding:8px;
      border-radius:10px;
      border:1px solid color-mix(in srgb, CanvasText 18%, transparent);
      cursor:pointer;
      flex-wrap: wrap;
    }
    .row:hover {
      background: color-mix(in srgb, CanvasText 5%, transparent);
    }

    .swatchBtn { padding:0; border:none; background:transparent; cursor:pointer; flex: 0 0 auto; }
    .swatch { width: 46px; height: 46px; border-radius: 10px; border:1px solid color-mix(in srgb, CanvasText 20%, transparent); }

    .meta { display:flex; flex-direction:column; gap:2px; flex: 1 1 auto; min-width: 0; }
    .label { font-size: 12px; font-weight: 800; opacity: .9; }
    .value { font-weight: 650; font-size: 13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .line { font-size: 11px; opacity:.75; }

    .btnRow { display:flex; gap:8px; align-items:center; flex: 0 0 auto; }
    .exp {
      padding:6px 9px;
      border-radius:8px;
      border:1px solid color-mix(in srgb, CanvasText 20%, transparent);
      background: color-mix(in srgb, Canvas 92%, CanvasText 8%);
      cursor:pointer;
      font-weight: 900;
      line-height: 1;
    }
    .exp:hover { background: color-mix(in srgb, Canvas 80%, CanvasText 20%); }

    .copy {
      padding:6px 10px;
      border-radius:8px;
      border:1px solid color-mix(in srgb, CanvasText 20%, transparent);
      background: color-mix(in srgb, Canvas 92%, CanvasText 8%);
      cursor:pointer;
      font-weight: 800;
    }
    .copy:hover { background: color-mix(in srgb, Canvas 80%, CanvasText 20%); }

    .expanded {
      margin-top: 8px;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px dashed color-mix(in srgb, CanvasText 18%, transparent);
      background: color-mix(in srgb, CanvasText 3%, transparent);
      display: none;
      flex-direction: column;
      gap: 6px;
      flex: 1 1 100%;
      width: 100%;
    }
    .useRow {
      font-size: 12px;
      line-height: 1.25;
      display:flex;
      justify-content: space-between;
      gap: 10px;
      align-items: baseline;
    }
    .useLeft { font-weight: 700; opacity: .95; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .useRight { opacity: .75; white-space:nowrap; }
    .useSample { font-size: 11px; opacity: .8; white-space: nowrap; overflow:hidden; text-overflow:ellipsis; }

    .empty { padding: 10px; opacity: .75; }
  </style>
</head>
<body>
  <div class="top">
    <div class="topLeft">
      <div class="topLine">
        <div class="titleLeft">${args.headerLeft}</div>
        <div class="titleMid">${args.headerMid}</div>
        ${importsToggle}
      </div>
      ${autoScanInfo}
    </div>

    <div class="topRight">
      <button id="refresh" class="actionBtn">${escapeHtml(args.buttonLabel)}</button>
      <button id="openSettings" class="settingsBtn" title="Open settings">Settings</button>
    </div>
  </div>

  ${importPanel}

  <div class="content">
    ${groupsHtml}
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const refreshBtn = document.getElementById("refresh");
    refreshBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "refresh" });
    });

    const settingsBtn = document.getElementById("openSettings");
    settingsBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "openSettings" });
    });

    const importsToggle = document.getElementById("importsToggle");
    const importsPanel = document.getElementById("importsPanel");
    if (importsToggle && importsPanel) {
      importsToggle.addEventListener("click", (e) => {
        e.preventDefault();
        const isOpen = importsPanel.style.display !== "none";
        importsPanel.style.display = isOpen ? "none" : "block";
      });
    }

    document.querySelectorAll(".row").forEach((row) => {
      const file = row.getAttribute("data-file");
      const line = Number(row.getAttribute("data-line") || "1");
      const startCol = Number(row.getAttribute("data-startcol") || "0");
      const endCol = Number(row.getAttribute("data-endcol") || "0");
      const value = row.getAttribute("data-value");

      const open = () => vscode.postMessage({ type: "open", file, line });
      const pick = () => vscode.postMessage({ type: "pickVscode", file, line, startCol, endCol });

      row.addEventListener("click", (e) => {
        const target = e.target;
        if (target && target.closest && target.closest(".copy")) return;
        if (target && target.closest && target.closest(".exp")) return;
        if (target && target.closest && target.closest(".swatchBtn")) return;
        open();
      });

      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          open();
        }
      });

      const copyBtn = row.querySelector(".copy");
      if (copyBtn) {
        copyBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: "copy", value });
        });
      }

      const swatchBtn = row.querySelector(".swatchBtn");
      if (swatchBtn) {
        swatchBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          pick();
        });
      }

      const expBtn = row.querySelector(".exp");
      const expanded = row.querySelector(".expanded");
      if (expBtn && expanded) {
        expBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const isOpen = expanded.style.display !== "none";
          expanded.style.display = isOpen ? "none" : "flex";
          expBtn.textContent = isOpen ? "▾" : "▴";
        });
      }
    });
  </script>
</body>
</html>`;
  }

  private renderColorRow(c: ColorHit, key: string): string {
    const labelLine = c.kind === "var" ? `<div class="label">Label: ${escapeHtml(c.name)}</div>` : "";
    const colorLine = `<div class="value">Color: ${escapeHtml(c.value)}</div>`;
    const lineLine = `<div class="line">Line: ${c.range.line}</div>`;

    const usageHtml =
      c.usages.length === 0
        ? `<div class="useSample">No usage locations found (yet).</div>`
        : c.usages
            .slice(0, 50)
            .map((u) => {
              const left = `${u.scope} • ${u.prop}`;
              const right = `Line ${u.line}`;
              return `
<div class="useRow">
  <div class="useLeft" title="${escapeHtml(left)}">${escapeHtml(left)}</div>
  <div class="useRight">${escapeHtml(right)}</div>
</div>
<div class="useSample" title="${escapeHtml(u.sample)}">${escapeHtml(u.sample)}</div>`;
            })
            .join("");

    return `
<div class="row"
     role="button"
     tabindex="0"
     data-file="${escapeHtml(c.file)}"
     data-line="${c.range.line}"
     data-startcol="${c.range.startCol}"
     data-endcol="${c.range.endCol}"
     data-value="${escapeHtml(c.value)}">

  <button class="swatchBtn" title="Open VS Code color picker" aria-label="Open VS Code color picker">
    <div class="swatch" style="background:${escapeHtmlAttr(c.value)}"></div>
  </button>

  <div class="meta">
    ${labelLine}
    ${colorLine}
    ${lineLine}
  </div>

  <div class="btnRow">
    <button class="exp" title="Show usage" aria-label="Show usage">▾</button>
    <button class="copy" title="Copy color" aria-label="Copy color">Copy</button>
  </div>

  <div class="expanded">
    ${usageHtml}
  </div>
</div>`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new ColorInspectorViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ColorInspectorViewProvider.viewType, provider)
  );

  // Command: Scan/Refresh (manual trigger)
  context.subscriptions.push(
    vscode.commands.registerCommand("color-inspector.scan", async () => {
      // Mark as scanned so button becomes Refresh and autoscan (if enabled) is allowed
      (provider as any).hasScanned = true; // keep it simple; view provider handles UI state
      await provider.render();
    })
  );

  // Command: Open Settings
  context.subscriptions.push(
    vscode.commands.registerCommand("color-inspector.openSettings", async () => {
      const extId = `${context.extension.packageJSON.publisher}.${context.extension.packageJSON.name}`;
      await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${extId}`);
    })
  );
}

export function deactivate() {}

/* -----------------------------
   Helpers: open/jump + VS Code picker (+ ask before auto space)
------------------------------ */

async function openFileAtLine(relPath: string, line1Based: number): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage("Color Inspector: No workspace folder open.");
    return;
  }

  const wsRoot = folders[0].uri;
  const uri = vscode.Uri.joinPath(wsRoot, relPath);

  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    const line0 = Math.max(0, line1Based - 1);
    const pos = new vscode.Position(line0, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  } catch {
    vscode.window.showWarningMessage(`Color Inspector: Could not open ${relPath}`);
  }
}

async function openFileSelectRangeAndPickVscode(
  workspaceState: vscode.Memento,
  relPath: string,
  line1Based: number,
  startCol: number,
  endCol: number
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage("Color Inspector: No workspace folder open.");
    return;
  }

  const wsRoot = folders[0].uri;
  const uri = vscode.Uri.joinPath(wsRoot, relPath);

  try {
    const doc = await vscode.workspace.openTextDocument(uri);

    const line0 = Math.max(0, line1Based - 1);

    let sCol = Math.max(0, startCol);
    let eCol = Math.max(sCol, endCol);

    // If we have :# (no space) immediately before the token, ASK to insert a space.
    if (sCol > 0) {
      const lineText = doc.lineAt(line0).text;
      const prevChar = lineText[sCol - 1] ?? "";
      const firstChar = lineText[sCol] ?? "";

      const looksLikeHex = firstChar === "#";
      if (prevChar === ":" && looksLikeHex) {
        const before = lineText;
        const after = before.slice(0, sCol) + " " + before.slice(sCol);

        const consent = await confirmAutoSpaceIfNeeded(workspaceState, before, after);
        if (consent === "deny") {
          return;
        }

        const insertPos = new vscode.Position(line0, sCol);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, insertPos, " ");
        await vscode.workspace.applyEdit(edit);

        sCol += 1;
        eCol += 1;
      }
    }

    // Caret INSIDE token – VS Code picker reads token at caret.
    const caretCol = Math.min(sCol + 1, Math.max(eCol - 1, sCol));
    const caret = new vscode.Position(line0, caretCol);

    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      selection: new vscode.Range(caret, caret),
    });

    editor.revealRange(new vscode.Range(caret, caret), vscode.TextEditorRevealType.InCenter);

    await vscode.commands.executeCommand("editor.action.showOrFocusStandaloneColorPicker");

    // VS Code may select the token/line when opening the picker. Force caret-only selection back.
    const caretPos = editor.selection.active;
    setTimeout(() => {
      const active = vscode.window.activeTextEditor;
      if (!active) {
        return;
      }
      active.selection = new vscode.Selection(caretPos, caretPos);
    }, 0);
  } catch {
    vscode.window.showWarningMessage(`Color Inspector: Could not open VS Code picker in ${relPath}`);
  }
}

/* -----------------------------
   Helpers: scan colors + usages
------------------------------ */

async function readUriText(uri: vscode.Uri): Promise<string> {
  const data = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(data).toString("utf8");
}

function buildLineStartIndex(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToLine0(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function offsetToCol(lineStarts: number[], offset: number): number {
  const line0 = offsetToLine0(lineStarts, offset);
  const start = lineStarts[line0] ?? 0;
  return Math.max(0, offset - start);
}

function normalizeColorKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function scanTextForColorsAndUsages(text: string, lineStarts: number[], file: string): ColorHit[] {
  const hits: ColorHit[] = [];

  // Color formats
  const hexRegex = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

  const rgbRegex =
    /\brgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0?\.\d+|1|0|\.\d+))?\s*\)/g;

  const hslRegex =
    /\bhsla?\(\s*\d{1,3}(?:deg|rad|turn)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(?:0?\.\d+|1|0|\.\d+))?\s*\)/g;

  // CSS var definition: --name: value;
  const cssVarDefRegex = /--([A-Za-z0-9_-]+)\s*:\s*([^;]+)\s*;/g;

  // Track ranges of var-def values to avoid double-counting as literals
  // key = `${line}:${startCol}:${endCol}:${normVal}`
  const varValueRangeKeys = new Set<string>();

  // First pass: variable definitions
  for (const m of text.matchAll(cssVarDefRegex)) {
    const matchStart = m.index ?? 0;
    const whole = m[0];
    const propName = `--${m[1]}`;
    const rhs = (m[2] ?? "").trim();

    const value =
      (rhs.match(/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/)?.[0] ??
        rhs.match(/^(?:rgba?|hsla?)\([^)]*\)/i)?.[0] ??
        "")?.trim();

    if (!value) {
      continue;
    }

    const inner = whole.indexOf(value);
    if (inner < 0) {
      continue;
    }

    const startOffset = matchStart + inner;
    const endOffset = startOffset + value.length;

    const line0 = offsetToLine0(lineStarts, startOffset);
    const line = line0 + 1;

    const startCol = offsetToCol(lineStarts, startOffset);
    const endCol = offsetToCol(lineStarts, endOffset);
    varValueRangeKeys.add(`${line}:${startCol}:${endCol}:${normalizeColorKey(value)}`);

    // Usages: the definition itself isn’t a usage; we’ll compute usages later
    hits.push({
      kind: "var",
      name: propName,
      value,
      file,
      range: { line, startCol, endCol },
      usages: [],
    });
  }

  // Second pass: literals (hex/rgb/hsl)
  const addLiteralHit = (value: string, startOffset: number) => {
    const endOffset = startOffset + value.length;
    const line0 = offsetToLine0(lineStarts, startOffset);
    const line = line0 + 1;
    const startCol = offsetToCol(lineStarts, startOffset);
    const endCol = offsetToCol(lineStarts, endOffset);

    const key = `${line}:${startCol}:${endCol}:${normalizeColorKey(value)}`;
    if (varValueRangeKeys.has(key)) {
      return; // avoid duplicate where var def value matches literal at same spot
    }

    hits.push({
      kind: "literal",
      value,
      file,
      range: { line, startCol, endCol },
      usages: [],
    });
  };

  for (const m of text.matchAll(hexRegex)) {
    const startOffset = m.index ?? 0;
    addLiteralHit(m[0], startOffset);
  }

  for (const m of text.matchAll(rgbRegex)) {
    const startOffset = m.index ?? 0;
    addLiteralHit(m[0], startOffset);
  }

  for (const m of text.matchAll(hslRegex)) {
    const startOffset = m.index ?? 0;
    addLiteralHit(m[0], startOffset);
  }

  // Build quick lookup for var names in this file so we can resolve var(...) usages
  const varNames = new Set<string>();
  for (const h of hits) {
    if (h.kind === "var") {
      varNames.add(h.name);
    }
  }

  // Usage extraction (best-effort, line-based)
  const lines = text.split(/\r?\n/);

  // Map from normalized color value -> hit indices
  const valueToHits = new Map<string, number[]>();
  for (let i = 0; i < hits.length; i++) {
    const norm = normalizeColorKey(hits[i].value);
    const arr = valueToHits.get(norm) ?? [];
    arr.push(i);
    valueToHits.set(norm, arr);
  }

  // Also map from var name -> hit indices
  const varToHits = new Map<string, number[]>();
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (h.kind === "var") {
      const arr = varToHits.get(h.name) ?? [];
      arr.push(i);
      varToHits.set(h.name, arr);
    }
  }

  // Find scope: prefer CSS selector lines like ".x:hover {", else prefer className="x", else fallback to tag
  const findCssScopeNear = (lineIdx: number): string | undefined => {
    for (let i = lineIdx; i >= 0 && i >= lineIdx - 40; i--) {
      const t = lines[i].trim();
      if (t.endsWith("{")) {
        const sel = t.slice(0, -1).trim();
        if (sel.length > 0 && !sel.startsWith("@")) {
          return sel;
        }
      }
    }
    return undefined;
  };

  const findJsxScopeNear = (lineIdx: number): string | undefined => {
    // Search upwards for className="..." or className={'...'} or className={...}
    for (let i = lineIdx; i >= 0 && i >= lineIdx - 60; i--) {
      const t = lines[i];
      const m1 = t.match(/\bclassName\s*=\s*["']([^"']+)["']/);
      if (m1 && m1[1]) {
        const first = m1[1].trim().split(/\s+/)[0];
        if (first) {
          return first.startsWith(".") ? first : `.${first}`;
        }
      }
      const m2 = t.match(/\bclass\s*=\s*["']([^"']+)["']/);
      if (m2 && m2[1]) {
        const first = m2[1].trim().split(/\s+/)[0];
        if (first) {
          return first.startsWith(".") ? first : `.${first}`;
        }
      }
      const mTag = t.match(/<\s*([A-Za-z][A-Za-z0-9:_-]*)\b/);
      if (mTag && mTag[1]) {
        return mTag[1];
      }
    }
    return undefined;
  };

  const findPropertyKeyOnLine = (lineText: string): string | undefined => {
    // CSS: "background: ..." or "box-shadow: ..."
    const cssProp = lineText.match(/^\s*([A-Za-z-]+)\s*:\s*/);
    if (cssProp && cssProp[1]) {
      return cssProp[1];
    }

    // JSX inline style object: borderBottom: "1px solid var(--border)"
    const jsProp = lineText.match(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*["']/);
    if (jsProp && jsProp[1]) {
      return jsProp[1];
    }

    // JSX style object with var(...) without quotes sometimes: border: 1
    const jsProp2 = lineText.match(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*[^,]+/);
    if (jsProp2 && jsProp2[1]) {
      return jsProp2[1];
    }

    return undefined;
  };

  const addUsageToHit = (hitIndex: number, usage: UsageHit) => {
    const h = hits[hitIndex];
    const existsAlready = h.usages.some(
      (u) => u.file === usage.file && u.line === usage.line && u.scope === usage.scope && u.prop === usage.prop
    );
    if (!existsAlready) {
      h.usages.push(usage);
    }
  };

  for (let li = 0; li < lines.length; li++) {
    const lineText = lines[li];
    const lineNo = li + 1;

    // Literal usage checks
    const literalMatches = [
      ...lineText.matchAll(/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g),
      ...lineText.matchAll(/\brgba?\(\s*[^)]+\)/g),
      ...lineText.matchAll(/\bhsla?\(\s*[^)]+\)/g),
    ];

    for (const mm of literalMatches) {
      const raw = (mm[0] ?? "").trim();
      if (!raw) {
        continue;
      }
      const norm = normalizeColorKey(raw);
      const idxs = valueToHits.get(norm);
      if (!idxs || idxs.length === 0) {
        continue;
      }

      const prop = findPropertyKeyOnLine(lineText) ?? "unknown";
      const scope = findCssScopeNear(li) ?? findJsxScopeNear(li) ?? "unknown";
      const sample = lineText.trim().slice(0, 220);

      for (const hitIndex of idxs) {
        addUsageToHit(hitIndex, { file, line: lineNo, scope, prop, sample });
      }
    }

    // var(--token) usage checks (for var-defined hits)
    const varMatches = [...lineText.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)];
    for (const vm of varMatches) {
      const name = (vm[1] ?? "").trim();
      if (!name) {
        continue;
      }
      if (!varNames.has(name)) {
        // Still record usage if we have a hit for it? If not defined in this file, it might be in another import.
        // We’ll still try to attach by name if present.
      }
      const idxs = varToHits.get(name);
      if (!idxs || idxs.length === 0) {
        continue;
      }

      const prop = findPropertyKeyOnLine(lineText) ?? "unknown";
      const scope = findCssScopeNear(li) ?? findJsxScopeNear(li) ?? "unknown";
      const sample = lineText.trim().slice(0, 220);

      for (const hitIndex of idxs) {
        addUsageToHit(hitIndex, { file, line: lineNo, scope, prop, sample });
      }
    }
  }

  // Keep usages ordered + small
  for (const h of hits) {
    h.usages.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.scope.localeCompare(b.scope));
  }

  return hits;
}

/* -----------------------------
   Helpers: import graph (explicit only)
------------------------------ */

type ImportSpec = { spec: string; kind: "js" | "css" };

function findImports(text: string): ImportSpec[] {
  const results: ImportSpec[] = [];
  const seen = new Set<string>();

  const importFrom = /\bimport\s+[^;]*?\s+from\s+["']([^"']+)["']/g;
  const importBare = /\bimport\s+["']([^"']+)["']/g;
  const requireRe = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

  // Fixed cssImport regex (your broken one was from a copy/paste mangling)
  const cssImport = /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?/g;

  const add = (spec: string, kind: "js" | "css") => {
    const key = `${kind}:${spec}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ spec: spec.trim(), kind });
    }
  };

  for (const m of text.matchAll(importFrom)) {
    add(m[1], "js");
  }
  for (const m of text.matchAll(importBare)) {
    add(m[1], "js");
  }
  for (const m of text.matchAll(requireRe)) {
    add(m[1], "js");
  }
  for (const m of text.matchAll(cssImport)) {
    add(m[1], "css");
  }

  return results;
}

function isFollowable(spec: string, kind: "js" | "css"): boolean {
  // explicit relative / common aliases
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return true;
  }
  if (spec.startsWith("/")) {
    return true;
  }
  if (spec.startsWith("@/") || spec.startsWith("~/")) {
    return true;
  }
  // CSS often does relative-ish imports without ./ (best-effort)
  if (kind === "css" && !spec.startsWith("http") && !spec.startsWith("data:")) {
    return true;
  }
  return false;
}

function resolveWithExtensions(rawBase: vscode.Uri, specForExtTest: string): vscode.Uri[] {
  const hasExt = /\.[a-zA-Z0-9]+$/.test(specForExtTest);
  if (hasExt) {
    return [rawBase];
  }

  const exts = [".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".sass", ".less", ".json", ".vue", ".svelte", ".html"];
  const candidates: vscode.Uri[] = [];

  for (const ext of exts) {
    candidates.push(vscode.Uri.parse(rawBase.toString() + ext));
  }
  for (const ext of exts) {
    candidates.push(vscode.Uri.joinPath(rawBase, "index" + ext));
  }

  return candidates;
}

function resolveImportCandidates(baseFile: vscode.Uri, wsRoot: vscode.Uri, spec: string, kind: "js" | "css"): vscode.Uri[] {
  const s = spec.trim();

  // Absolute from workspace root
  if (s.startsWith("/")) {
    const without = s.replace(/^\/+/, "");
    return resolveWithExtensions(vscode.Uri.joinPath(wsRoot, without), s);
  }

  // Alias "@/..." or "~//..."
  if (s.startsWith("@/") || s.startsWith("~/")) {
    const without = s.slice(2);
    return resolveWithExtensions(vscode.Uri.joinPath(wsRoot, without), s);
  }

  // Relative
  if (s.startsWith("./") || s.startsWith("../")) {
    const baseDir = vscode.Uri.joinPath(baseFile, "..");
    return resolveWithExtensions(vscode.Uri.joinPath(baseDir, s), s);
  }

  // CSS import without ./ is treated as relative to current file
  if (kind === "css") {
    const baseDir = vscode.Uri.joinPath(baseFile, "..");
    return resolveWithExtensions(vscode.Uri.joinPath(baseDir, s), s);
  }

  return [];
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function collectImportGraph(root: vscode.Uri, wsRoot: vscode.Uri, maxFiles: number): Promise<vscode.Uri[]> {
  const visited = new Set<string>();
  const queue: vscode.Uri[] = [root];
  const out: vscode.Uri[] = [];

  while (queue.length > 0 && out.length < maxFiles) {
    const uri = queue.shift();
    if (!uri) {
      break;
    }

    const key = uri.toString();
    if (visited.has(key)) {
      continue;
    }

    visited.add(key);
    out.push(uri);

    let text = "";
    try {
      text = await readUriText(uri);
    } catch {
      continue;
    }

    const imports = findImports(text);
    for (const imp of imports) {
      if (!isFollowable(imp.spec, imp.kind)) {
        continue;
      }

      const candidates = resolveImportCandidates(uri, wsRoot, imp.spec, imp.kind);
      for (const c of candidates) {
        if (await exists(c)) {
          queue.push(c);
          break;
        }
      }
    }
  }

  return out;
}

/* -----------------------------
   HTML escaping
------------------------------ */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[ch] ?? ch;
  });
}

// For attributes (same as HTML here; kept separate for clarity)
function escapeHtmlAttr(s: string): string {
  return escapeHtml(s);
}