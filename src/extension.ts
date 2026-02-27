import * as vscode from "vscode";

/**
 * Color Inspector — extension.ts
 *
 * Manual scan by default.
 * Optional auto-scan interval via setting: colorInspector.autoScanMinutes (0–10).
 */

type ThemeTag = "dark" | "light" | "base";

type ThemeInfo = {
  hasDark: boolean;
  hasLight: boolean;
  hasBase: boolean;
  supportsSystem: boolean; // best-effort: prefers-color-scheme + your selector patterns
};

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
      theme: ThemeTag; // dark/light/base (applies to var definitions only)
    }
  | {
      kind: "literal";
      value: string; // #aabbcc / rgba(...)
      file: string;
      range: HitRange;
      usages: UsageHit[];
    };

function computeFileThemeInfo(text: string, hits: ColorHit[]): ThemeInfo {
  const hasDark = hits.some((h) => h.kind === "var" && h.theme === "dark");
  const hasLight = hits.some((h) => h.kind === "var" && h.theme === "light");
  const hasBase = hits.some((h) => h.kind === "var" && h.theme === "base");

  const lower = text.toLowerCase();

  const hasPrefers = /prefers-color-scheme\s*:\s*(dark|light)/.test(lower);
  const hasSystemAttr = /data-theme-mode\s*=\s*["']system["']/.test(lower);
  const hasRootNotAttr = /:root\s*:?\s*not\(\s*\[data-theme-mode\]\s*\)/.test(lower);

  const supportsSystem = hasSystemAttr || (hasPrefers && hasRootNotAttr);

  return { hasDark, hasLight, hasBase, supportsSystem };
}

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

    themeGroupsStartOpen: themeGroupsStartOpen(),

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
    const perFileThemeInfo = new Map<string, ThemeInfo>();

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
      perFileThemeInfo.set(fileLabel, computeFileThemeInfo(text, hits));
    }

    // De-dupe across files:
    const varSeen = new Set<string>();
    const litSeen = new Set<string>();
    const merged: ColorHit[] = [];

    for (const h of allHits) {
      const normVal = normalizeColorKey(h.value);
      if (h.kind === "var") {
        // include theme so dark/base defs don't collapse into one
        const key = `${h.file}|${h.theme}|${h.name}=${normVal}`.toLowerCase();
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

    this.view.webview.html = this.htmlMain(merged, perFileThemeInfo);
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
  themeGroupsStartOpen: vscode.workspace
    .getConfiguration()
    .get<boolean>("colorInspector.themeGroupsStartOpen", false),
});
  }

  private htmlMain(colors: ColorHit[], perFileThemeInfo: Map<string, ThemeInfo>): string {
    const importCount = this.lastImportCount;
    const importLabel = importCount === 1 ? "Import" : "Imports";
    const importsClickable = importCount > 0;

    const headerLeft = escapeHtml(this.lastRootRel);
    const headerMid = escapeHtml(`${this.lastTotalColors} colors`);
    const headerRight =
      importCount > 0 ? escapeHtml(`+${importCount} ${importLabel}`) : escapeHtml(`+0 Imports`);
    const themeGroupsStartOpen = vscode.workspace
  .getConfiguration()
  .get<boolean>("colorInspector.themeGroupsStartOpen", false);

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
          // theme ordering: dark, light, base
          const ta = a.theme === "dark" ? 0 : a.theme === "light" ? 1 : 2;
          const tb = b.theme === "dark" ? 0 : b.theme === "light" ? 1 : 2;
          if (ta !== tb) {
            return ta - tb;
          }
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
        themeInfo:
          perFileThemeInfo.get(file) ?? { hasDark: false, hasLight: false, hasBase: false, supportsSystem: false },
      };
    });

    // Root file group first
    groups.sort((a, b) => {
      if (a.file === this.lastRootRel) {
        return -1;
      }
      if (b.file === this.lastRootRel) {
        return 1;
      }
      return a.file.localeCompare(b.file);
    });

    const imports = this.lastImportFiles;

    const buttonLabel = this.hasScanned ? "Refresh" : "Scan";
    const autoScanMinutes = vscode.workspace.getConfiguration().get<number>("colorInspector.autoScanMinutes", 0);

    const startOpen = vscode.workspace
  .getConfiguration()
  .get<boolean>("colorInspector.themeGroupsStartOpen", false);

return this.htmlShell({
  headerLeft,
  headerMid,
  headerRight,
  imports,
  groups,
  buttonLabel,
  showImportsToggle: importsClickable,
  autoScanMinutes,
  themeGroupsStartOpen: vscode.workspace
    .getConfiguration()
    .get<boolean>("colorInspector.themeGroupsStartOpen", false),
});
  }

  private themeIconsHtml(info: ThemeInfo): string {
    const iconWrap = (svg: string, title: string) =>
      `<span class="ticon" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${svg}</span>`;

    const themeIconStyle = `style="width:12px;height:12px;display:block"`;

    const lightSvg = `
<svg ${themeIconStyle} viewBox="0 0 512 512" aria-hidden="true">
  <path fill="currentColor" d="M361.5 1.2c5 2.1 8.6 6.6 9.6 11.9L391 121l107.9 19.8c5.3 1 9.8 4.6 11.9 9.6s1.5 10.7-1.6 15.2L446.9 256l62.3 90.3c3.1 4.5 3.7 10.2 1.6 15.2s-6.6 8.6-11.9 9.6L391 391 371.1 498.9c-1 5.3-4.6 9.8-9.6 11.9s-10.7 1.5-15.2-1.6L256 446.9l-90.3 62.3c-4.5 3.1-10.2 3.7-15.2 1.6s-8.6-6.6-9.6-11.9L121 391 13.1 371.1c-5.3-1-9.8-4.6-11.9-9.6s-1.5-10.7 1.6-15.2L65.1 256 2.8 165.7c-3.1-4.5-3.7-10.2-1.6-15.2s6.6-8.6 11.9-9.6L121 121 140.9 13.1c1-5.3 4.6-9.8 9.6-11.9s10.7-1.5 15.2 1.6L256 65.1 346.3 2.8c4.5-3.1 10.2-3.7 15.2-1.6zM160 256a96 96 0 1 1 192 0 96 96 0 1 1 -192 0zm224 0a128 128 0 1 0 -256 0 128 128 0 1 0 256 0z"/>
</svg>`.trim();

    const systemSvg = `
<svg ${themeIconStyle} viewBox="0 0 384 512" aria-hidden="true">
  <path fill="currentColor" d="M223.5 32C100 32 0 132.3 0 256S100 480 223.5 480c60.6 0 115.5-24.2 155.8-63.4c5-4.9 6.3-12.5 3.1-18.7s-10.1-9.7-17-8.5c-9.8 1.7-19.8 2.6-30.1 2.6c-96.9 0-175.5-78.8-175.5-176c0-65.8 36-123.1 89.3-153.3c6.1-3.5 9.2-10.5 7.7-17.3s-7.3-11.9-14.3-12.5c-6.3-.5-12.6-.8-19-.8z"/>
</svg>`.trim();

    const darkSvg = `
<svg ${themeIconStyle} viewBox="0 0 576 512" aria-hidden="true">
  <path fill="currentColor" d="M64 0C28.7 0 0 28.7 0 64L0 352c0 35.3 28.7 64 64 64l176 0-10.7 32L160 448c-17.7 0-32 14.3-32 32s14.3 32 32 32l256 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-69.3 0L336 416l176 0c35.3 0 64-28.7 64-64l0-288c0-35.3-28.7-64-64-64L64 0zM512 64l0 224L64 288 64 64l448 0z"/>
</svg>`.trim();

    const out: string[] = [];

    // If there’s no explicit light-theme block but base exists, treat base as “Light Theme”.
    const showLight = info.hasLight || info.hasBase;

    if (showLight) out.push(iconWrap(lightSvg, "Light theme vars"));
    if (info.hasDark) out.push(iconWrap(darkSvg, "Dark theme vars"));
    if (info.supportsSystem) out.push(iconWrap(systemSvg, "System/Auto theme support"));

    return out.length ? `<div class="ticons">${out.join("")}</div>` : "";
  }

  private htmlShell(args: {
    headerLeft: string;
    headerMid: string;
    headerRight: string;
    imports: { file: string; colors: number }[];
    groups: { file: string; count: number; hits: ColorHit[]; themeInfo: ThemeInfo }[];
    buttonLabel: string;
    showImportsToggle: boolean;
    autoScanMinutes: number;
    themeGroupsStartOpen: boolean;
  }): string {
    const importsRows =
      args.imports.length === 0
        ? ""
        : args.imports
            .map(
              (i) =>
                `<div class="importRow">${escapeHtml(i.file)} <span class="muted">(${i.colors})</span></div>`
            )
            .join("");

    const groupsHtml =
      args.groups.length === 0
        ? `<div class="empty">No colors found.</div>`
        : args.groups
            .map((g) => {
              // Theme grouping inside each file:
              const darkVars = g.hits.filter((h) => h.kind === "var" && h.theme === "dark");
              const lightVars = g.hits.filter((h) => h.kind === "var" && h.theme === "light");
              const baseVars = g.hits.filter((h) => h.kind === "var" && h.theme === "base");
              const literals = g.hits.filter((h) => h.kind === "literal");

              const renderSection = (title: string, arr: ColorHit[], openByDefault: boolean) => {
                if (arr.length === 0) {
                  return "";
                }
                const rows = arr.map((c, idx) => this.renderColorRow(c, `${g.file}::${title}::${idx}`)).join("");

                return `
<details class="themeGroup" ${openByDefault ? "open" : ""}>
  <summary class="themeSummary">
    <span>${escapeHtml(title)} <span class="muted">(${arr.length})</span></span>
    <span class="themeChevron">▸</span>
  </summary>
  <div class="themeBody">
    ${rows}
  </div>
</details>`;
              };

              const hasExplicitLight = lightVars.length > 0;
              const baseLabel = hasExplicitLight ? "Base" : "Light theme";

              const body =
                renderSection("Dark theme", darkVars, args.themeGroupsStartOpen) +
                renderSection("Light theme", lightVars, args.themeGroupsStartOpen) +
                renderSection(baseLabel, baseVars, args.themeGroupsStartOpen) +
                renderSection("Other colors", literals, args.themeGroupsStartOpen);

              const icons = this.themeIconsHtml(g.themeInfo);

              return `
<div class="group">
  <div class="groupHeader" title="${escapeHtml(g.file)}">
    <div class="ghLeft">${escapeHtml(g.file)} <span class="muted">(${g.count})</span></div>
    ${icons}
  </div>
  <div class="groupBody">
    ${body}
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

      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
    }

    .ghLeft {
      min-width:0;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }

    .ticons{
      display:flex;
      gap:6px;
      align-items:center;
      flex:0 0 auto;
      opacity:.85;
    }
    .ticon{
  width:auto;
  height:auto;
  border:0;
  background:transparent;
  padding:0;
}
    .ticon:hover{ opacity:1; }

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

    details.themeGroup {
      border: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
      border-radius: 10px;
      overflow: hidden;
      background: color-mix(in srgb, CanvasText 2%, transparent);
    }
    details.themeGroup[open] {
      background: color-mix(in srgb, CanvasText 3%, transparent);
    }
    summary.themeSummary {
      list-style: none;
      cursor: pointer;
      padding: 8px 10px;
      font-size: 11px;
      font-weight: 900;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      user-select: none;
    }
    summary.themeSummary::-webkit-details-marker { display:none; }
    .themeChevron { opacity: .75; font-weight: 900; }
    details.themeGroup[open] .themeChevron { transform: rotate(90deg); }
    .themeBody {
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      border-top: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
      background: var(--vscode-editor-background);
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
    const cssProp = c.usages.find((u) => Object.keys(u).includes("prop"))?.prop;
    const contextObj = c.usages.find((u)=>Object.keys(u).includes("scope"))?.scope;

    const labelLine = c.kind === "var" ? `<div class="label">Label: ${escapeHtml(c.name)}</div>` : "";
    const colorLine = `<div class="value">Color: ${escapeHtml(c.value)}</div>`;
    const propertyKey = cssProp ? `<div class="value">Property key: ${escapeHtml(cssProp)}</div>` : "";
    const contextHint = contextObj ? `<div class="value">Context hint {}: ${escapeHtml(contextObj)}</div>` : "";
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
     data-value="${escapeHtml(c.value)}"
     data-property-key="${escapeHtml(propertyKey)}"
     data-context-hint="${escapeHtml(contextHint)}">

  <button class="swatchBtn" title="Open VS Code color picker" aria-label="Open VS Code color picker">
    <div class="swatch" style="background:${escapeHtmlAttr(c.value)}"></div>
  </button>

  <div class="meta">
    ${labelLine}
    ${colorLine}
    ${propertyKey}
    ${contextHint}
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
      (provider as any).hasScanned = true;
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
   Helpers: scan colors + usages (+ theme tagging for var definitions)
------------------------------ */

function themeGroupsStartOpen(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>("colorInspector.themeGroupsStartOpen", false);
}

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

function computeThemeByLine(text: string): ThemeTag[] {
  const lines = text.split(/\r?\n/);
  const themeByLine: ThemeTag[] = new Array(lines.length).fill("base");

  // stack values: theme for opened blocks, or null for "inherit"
  const stack: Array<ThemeTag | null> = [];

  const currentTheme = (): ThemeTag => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const t = stack[i];
      if (t) {
        return t;
      }
    }
    return "base";
  };

  const stripSameLineComments = (line: string): string => {
    // cheap: remove /*...*/ on same line and trailing //...
    return line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/g, "");
  };

  const detectThemeTrigger = (line: string): ThemeTag | null => {
    const l = line.toLowerCase();

    // @media (prefers-color-scheme: dark|light)
    const media = l.match(/@media[^{]*prefers-color-scheme\s*:\s*(dark|light)/);
    if (media) {
      return media[1] === "dark" ? "dark" : "light";
    }

    // :root[data-theme-mode="dark|light"]
    const rootAttr = l.match(/:root[^{]*data-theme-mode\s*=\s*["'](dark|light)["']/);
    if (rootAttr) {
      return rootAttr[1] === "dark" ? "dark" : "light";
    }

    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = stripSameLineComments(raw);

    themeByLine[i] = currentTheme();

    const trigger = detectThemeTrigger(line);

    const opens = (line.match(/{/g) ?? []).length;
    const closes = (line.match(/}/g) ?? []).length;

    for (let k = 0; k < opens; k++) {
      if (k === 0 && trigger) {
        stack.push(trigger);
      } else {
        stack.push(null);
      }
    }

    for (let k = 0; k < closes; k++) {
      if (stack.length > 0) {
        stack.pop();
      }
    }
  }

  return themeByLine;
}

function scanTextForColorsAndUsages(text: string, lineStarts: number[], file: string): ColorHit[] {
  const hits: ColorHit[] = [];

  const themeByLine = computeThemeByLine(text);

  // Color formats
  const hexRegex = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

  const rgbRegex =
    /\brgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0?\.\d+|1|0|\.\d+))?\s*\)/g;

  const hslRegex =
    /\bhsla?\(\s*\d{1,3}(?:deg|rad|turn)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(?:0?\.\d+|1|0|\.\d+))?\s*\)/g;

  // CSS var definition: --name: value;
  const cssVarDefRegex = /--([A-Za-z0-9_-]+)\s*:\s*([^;]+)\s*;/g;

  // Track ranges of var-def values to avoid double-counting as literals
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

    const theme: ThemeTag = themeByLine[line0] ?? "base";

    hits.push({
      kind: "var",
      name: propName,
      value,
      file,
      range: { line, startCol, endCol },
      usages: [],
      theme,
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
      return;
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
    addLiteralHit(m[0], m.index ?? 0);
  }
  for (const m of text.matchAll(rgbRegex)) {
    addLiteralHit(m[0], m.index ?? 0);
  }
  for (const m of text.matchAll(hslRegex)) {
    addLiteralHit(m[0], m.index ?? 0);
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

  // Map from var name -> hit indices
  const varToHits = new Map<string, number[]>();
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (h.kind === "var") {
      const arr = varToHits.get(h.name) ?? [];
      arr.push(i);
      varToHits.set(h.name, arr);
    }
  }

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
    let componentName: string | undefined;
    let selectorName: string | undefined; // nearest PascalCase JSX component (<Grid>)
    let tagName: string | undefined;       // nearest lowercase HTML tag (<em>)
    let className: string | undefined;

    // Collect element-level context.
    // PascalCase tags (<Grid>) and lowercase tags (<em>) are kept separate
    // so both can appear in the context breadcrumb.
    for (let i = lineIdx; i >= 0 && i >= lineIdx - 15; i--) {
      const t = lines[i];

      if (
        /(?:^|\s)(?:function|const|let|var)\s+[A-Z][A-Za-z0-9_]*\b/.test(t) ||
        /export\s+(?:default\s+)?(?:function\s+)?[A-Z][A-Za-z0-9_]*\b/.test(t)
      ) {
        break;
      }

      if (!className) {
        const m1 = t.match(/\bclassName\s*=\s*["']([^"']+)["']/);
        const m2 = t.match(/\bclass\s*=\s*["']([^"']+)["']/);
        const raw = m1?.[1] ?? m2?.[1];
        if (raw) {
          const first = raw.trim().split(/\s+/)[0];
          className = first?.startsWith(".") ? first : `.${first}`;
        }
      }

      if (!selectorName) {
        const mComp = t.match(/<([A-Z][A-Za-z0-9]*)\b/);
        if (mComp?.[1]) selectorName = mComp[1];
      }

      if (!tagName) {
        const mTag = t.match(/<([a-z][A-Za-z0-9-]*)\b/);
        if (mTag?.[1]) tagName = mTag[1];
      }
    }

    // Collect enclosing component/function name.
    for (let i = lineIdx; i >= 0 && i >= lineIdx - 60; i--) {
      const t = lines[i];

      const mFn = t.match(/(?:^|\s)(?:function|const|let|var)\s+([A-Z][A-Za-z0-9_]*)\b/);
      if (mFn?.[1]) { componentName = mFn[1]; break; }

      const mArrow = t.match(/export\s+(?:default\s+)?(?:function\s+)?([A-Z][A-Za-z0-9_]*)\b/);
      if (mArrow?.[1]) { componentName = mArrow[1]; break; }
    }

    // Build context breadcrumb: component > selector > class|tag, skipping missing parts.
    // Omit selectorName if it matches componentName (avoids "Grid > Grid").
    const parts = [
      componentName,
      selectorName !== componentName ? selectorName : undefined,
      className ?? tagName,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" > ") : undefined;
  };

  const findPropertyKeyOnLine = (lineText: string): string | undefined => {
    const cssProp = lineText.match(/^\s*([A-Za-z-]+)\s*:\s*/);
    if (cssProp && cssProp[1]) {
      return cssProp[1];
    }

    const jsProp = lineText.match(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*["']/);
    if (jsProp && jsProp[1]) {
      return jsProp[1];
    }

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

    const literalMatches = [
      ...lineText.matchAll(/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g),
      ...lineText.matchAll(/\brgba?\(\s*[^)]+\)/g),
      ...lineText.matchAll(/\bhsla?\(\s*[^)]+\)/g),
    ];

    for (const mm of literalMatches) {
      const raw = (mm[0] ?? "").trim();
      if (!raw) continue;

      const norm = normalizeColorKey(raw);
      const idxs = valueToHits.get(norm);
      if (!idxs || idxs.length === 0) continue;

      const prop = findPropertyKeyOnLine(lineText) ?? "unknown";
      const scope = findJsxScopeNear(li) ?? "unknown";
      const sample = lineText.trim().slice(0, 220);

      for (const hitIndex of idxs) {
        addUsageToHit(hitIndex, { file, line: lineNo, scope, prop, sample });
      }
    }

    const varMatches = [...lineText.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)];
    for (const vm of varMatches) {
      const name = (vm[1] ?? "").trim();
      if (!name) continue;

      const idxs = varToHits.get(name);
      if (!idxs || idxs.length === 0) continue;

      const prop = findPropertyKeyOnLine(lineText) ?? "unknown";
      const scope = findJsxScopeNear(li) ?? findCssScopeNear(li) ?? "unknown";
      const sample = lineText.trim().slice(0, 220);

      for (const hitIndex of idxs) {
        addUsageToHit(hitIndex, { file, line: lineNo, scope, prop, sample });
      }
    }
  }

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

  const cssImport = /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?/g;

  const add = (spec: string, kind: "js" | "css") => {
    const key = `${kind}:${spec}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ spec: spec.trim(), kind });
    }
  };

  for (const m of text.matchAll(importFrom)) add(m[1], "js");
  for (const m of text.matchAll(importBare)) add(m[1], "js");
  for (const m of text.matchAll(requireRe)) add(m[1], "js");
  for (const m of text.matchAll(cssImport)) add(m[1], "css");

  return results;
}

function isFollowable(spec: string, kind: "js" | "css"): boolean {
  if (spec.startsWith("./") || spec.startsWith("../")) return true;
  if (spec.startsWith("/")) return true;
  if (spec.startsWith("@/") || spec.startsWith("~/")) return true;

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

function resolveImportCandidates(
  baseFile: vscode.Uri,
  wsRoot: vscode.Uri,
  spec: string,
  kind: "js" | "css"
): vscode.Uri[] {
  const s = spec.trim();

  if (s.startsWith("/")) {
    const without = s.replace(/^\/+/, "");
    return resolveWithExtensions(vscode.Uri.joinPath(wsRoot, without), s);
  }

  if (s.startsWith("@/") || s.startsWith("~/")) {
    const without = s.slice(2);
    return resolveWithExtensions(vscode.Uri.joinPath(wsRoot, without), s);
  }

  if (s.startsWith("./") || s.startsWith("../")) {
    const baseDir = vscode.Uri.joinPath(baseFile, "..");
    return resolveWithExtensions(vscode.Uri.joinPath(baseDir, s), s);
  }

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
    if (!uri) break;

    const key = uri.toString();
    if (visited.has(key)) continue;

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
      if (!isFollowable(imp.spec, imp.kind)) continue;

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

function escapeHtmlAttr(s: string): string {
  return escapeHtml(s);
}