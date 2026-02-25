import * as vscode from "vscode";

/* =========================================================
   Types
========================================================= */

type HitRange = {
  line: number; // 1-based
  startCol: number; // 0-based
  endCol: number; // 0-based
};

type UsageInfo = {
  isDefinition: boolean;
  scope?: string; // CSS selector (.pair-card) OR JSX scope (.pair-card or div)
  property?: string; // CSS property OR JS style key (border/background/boxShadow)
  line: number; // 1-based
};

type ColorOccur =
  | {
      kind: "var";
      name: string; // --border
      value: string; // resolved color for swatch (hex/rgb/rgba/hsl/hsla)
      file: string; // relative
      range: HitRange;
      usage: UsageInfo;
    }
  | {
      kind: "literal";
      value: string;
      file: string;
      range: HitRange;
      usage: UsageInfo;
    };

type ColorEntry = {
  key: string;
  kind: "var" | "literal";
  name?: string;
  value: string;
  occurrences: ColorOccur[];
};

type FileGroup = {
  file: string;
  entries: Array<{
    entry: ColorEntry;
    occurrencesInFile: ColorOccur[];
  }>;
  uniqueCount: number;
};

type VarDef = { name: string; value: string };

/* =========================================================
   Workspace setting key
========================================================= */

const WS_KEY_ALLOW_SPACE = "colorInspector.allowAutoSpaceForHex";

/* =========================================================
   Confirm: auto-insert space before # in var definitions
========================================================= */

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

/* =========================================================
   Webview Provider
========================================================= */

class ColorInspectorViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "colorInspector.view";
  private view?: vscode.WebviewView;

  constructor(private readonly workspaceState: vscode.Memento) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "copy" && typeof msg.value === "string") {
        await vscode.env.clipboard.writeText(msg.value);
        vscode.window.showInformationMessage(`${msg.value} copied`);
        return;
      }

      if (msg?.type === "open" && typeof msg.file === "string" && typeof msg.line === "number") {
        await openFileAtLine(msg.file, msg.line);
        return;
      }

      if (
        msg?.type === "pickVscode" &&
        typeof msg.file === "string" &&
        typeof msg.line === "number" &&
        typeof msg.startCol === "number" &&
        typeof msg.endCol === "number"
      ) {
        await openFileSelectRangeAndPickVscode(
          this.workspaceState,
          msg.file,
          msg.line,
          msg.startCol,
          msg.endCol
        );
        return;
      }

      if (msg?.type === "refresh") {
        await this.render();
        return;
      }
    });

    void this.render();
  }

  public async render() {
    if (!this.view) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.view.webview.html = this.html({
        headerPath: "No active editor",
        totalColors: 0,
        importFiles: [],
        importCounts: new Map<string, number>(),
        groups: [],
      });
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.view.webview.html = this.html({
        headerPath: "No workspace folder open",
        totalColors: 0,
        importFiles: [],
        importCounts: new Map<string, number>(),
        groups: [],
      });
      return;
    }

    const wsRoot = folders[0].uri;
    const rootDoc = editor.document;
    const rootUri = rootDoc.uri;

    // Only explicit imports
    const uris = await collectImportGraph(rootUri, wsRoot, 120);

    const rootRelPath = vscode.workspace.asRelativePath(rootUri, false);
    const rootFolderName = wsRoot.path.split("/").filter(Boolean).pop() ?? "workspace";
    const headerPath = `${rootFolderName}/${rootRelPath}`;

    // Imports (exclude root)
    const importFiles = uris
      .slice(1)
      .map((u) => vscode.workspace.asRelativePath(u, false))
      .sort((a, b) => a.localeCompare(b));

    // Cache file text + line starts
    const fileTextCache = new Map<string, { text: string; lineStarts: number[] }>();

    // Pass 1: collect var definitions across graph so var(--x) can resolve
    const globalVarValueByName = new Map<string, string>(); // "--border" -> "#aabbcc"
    for (const uri of uris) {
      let text = "";
      try {
        text = await readUriText(uri);
      } catch {
        continue;
      }
      const fileLabel = vscode.workspace.asRelativePath(uri, false);
      const lineStarts = buildLineStartIndex(text);
      fileTextCache.set(fileLabel, { text, lineStarts });

      const defs = scanVarDefinitions(text);
      for (const d of defs) {
        if (!globalVarValueByName.has(d.name)) {
          globalVarValueByName.set(d.name, d.value);
        }
      }
    }

    // Pass 2: scan occurrences
    const occByFile = new Map<string, ColorOccur[]>();
    for (const [fileLabel, cached] of fileTextCache.entries()) {
      const occ = scanTextForColorOccurrences(
        cached.text,
        cached.lineStarts,
        fileLabel,
        globalVarValueByName
      );
      occByFile.set(fileLabel, occ);
    }

    // Aggregate into unique entries, keep occurrences
    const entriesByKey = new Map<string, ColorEntry>();
    for (const arr of occByFile.values()) {
      for (const o of arr) {
        const key = makeColorKey(o);
        const existing = entriesByKey.get(key);
        if (!existing) {
          entriesByKey.set(key, {
            key,
            kind: o.kind,
            name: o.kind === "var" ? o.name : undefined,
            value: o.value,
            occurrences: [o],
          });
        } else {
          existing.occurrences.push(o);
        }
      }
    }

    const allEntries = Array.from(entriesByKey.values());
    const totalColors = allEntries.length;

    // Unique keys per file (for grouping + import counts)
    const uniqueKeysPerFile = new Map<string, Set<string>>();
    for (const e of allEntries) {
      for (const o of e.occurrences) {
        const set = uniqueKeysPerFile.get(o.file) ?? new Set<string>();
        set.add(e.key);
        uniqueKeysPerFile.set(o.file, set);
      }
    }

    // Import counts = unique colors in each import file
    const importCounts = new Map<string, number>();
    for (const f of importFiles) {
      importCounts.set(f, uniqueKeysPerFile.get(f)?.size ?? 0);
    }

    // File groups (root first, then alpha)
    const fileList = Array.from(uniqueKeysPerFile.keys()).sort((a, b) => {
      if (a === rootRelPath && b !== rootRelPath) {
        return -1;
      }
      if (b === rootRelPath && a !== rootRelPath) {
        return 1;
      }
      return a.localeCompare(b);
    });

    const groups: FileGroup[] = fileList.map((file) => {
      const keys = uniqueKeysPerFile.get(file) ?? new Set<string>();

      const entriesForFile = Array.from(keys)
        .map((k) => entriesByKey.get(k)!)
        .filter(Boolean)
        .map((entry) => {
          const occurrencesInFile = entry.occurrences
            .filter((o) => o.file === file)
            .sort((a, b) => a.usage.line - b.usage.line);
          return { entry, occurrencesInFile };
        })
        .sort((a, b) => {
          if (a.entry.kind !== b.entry.kind) {
            return a.entry.kind === "var" ? -1 : 1;
          }
          if (a.entry.kind === "var" && b.entry.kind === "var") {
            return (a.entry.name ?? "").localeCompare(b.entry.name ?? "");
          }
          return a.entry.value.localeCompare(b.entry.value);
        });

      return { file, entries: entriesForFile, uniqueCount: entriesForFile.length };
    });

    this.view.webview.html = this.html({
      headerPath,
      totalColors,
      importFiles,
      importCounts,
      groups,
    });
  }

  private html(args: {
    headerPath: string;
    totalColors: number;
    importFiles: string[];
    importCounts: Map<string, number>;
    groups: FileGroup[];
  }) {
    const { headerPath, totalColors, importFiles, importCounts, groups } = args;

    const escapeHtml = (s: string) =>
      s.replace(/[&<>"']/g, (ch) => {
        const map: Record<string, string> = {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        };
        return map[ch] ?? ch;
      });

    const importCount = importFiles.length;
    const importWord = importCount === 1 ? "Import" : "Imports";

    const importsButton =
      importCount > 0
        ? `<button id="importsToggle" class="importsBtn" aria-expanded="false" title="Show imported files">+${importCount} ${importWord}</button>`
        : `<span class="importsOff">+0 Imports</span>`;

    const importsPanel =
      importCount > 0
        ? `<div id="importsPanel" class="importsPanel" hidden>
            ${importFiles
              .map((p) => {
                const c = importCounts.get(p) ?? 0;
                return `<div class="importLine">${escapeHtml(p)} <span class="importCount">(${c})</span></div>`;
              })
              .join("")}
           </div>`
        : "";

    const groupsHtml =
      groups.length === 0
        ? `<div class="empty">No colors found.</div>`
        : groups
            .map((g) => {
              const fileTitle = `${g.file} (${g.uniqueCount})`;

              const rows = g.entries
                .map(({ entry, occurrencesInFile }) => {
                  // Pick a primary occurrence for jump/caret (prefer non-definition)
                  const nonDef = occurrencesInFile.find((o) => !o.usage.isDefinition);
                  const primary = nonDef ?? occurrencesInFile[0];
                  const line = primary?.usage.line ?? 1;

                  // Expanded details: only usages (not definitions)
                  const usageOcc = occurrencesInFile.filter((o) => !o.usage.isDefinition);

                  const details = usageOcc
                    .map((o) => {
                      const scope = o.usage.scope ?? "(unknown)";
                      const prop = o.usage.property ?? "(unknown)";
                      return `
<div class="useRow" role="button" tabindex="0"
     data-file="${escapeHtml(o.file)}"
     data-line="${o.usage.line}">
  <div class="useMain">
    <div class="useLeft"><span class="useScope">${escapeHtml(scope)}</span> • <span class="useProp">${escapeHtml(
                        prop
                      )}</span></div>
  </div>
  <div class="useLine">Line ${o.usage.line}</div>
</div>`;
                    })
                    .join("");

                  const labelBlock =
                    entry.kind === "var"
                      ? `<div class="metaRow"><span class="metaKey">Label:</span> <span class="metaVal">${escapeHtml(
                          entry.name ?? ""
                        )}</span></div>`
                      : "";

                  return `
<div class="row"
     role="button"
     tabindex="0"
     data-file="${escapeHtml(g.file)}"
     data-line="${line}"
     data-startcol="${primary?.range.startCol ?? 0}"
     data-endcol="${primary?.range.endCol ?? 0}"
     data-value="${escapeHtml(entry.value)}">

  <button class="swatchBtn" title="Open VS Code color picker" aria-label="Open VS Code color picker">
    <div class="swatch" style="background:${entry.value}"></div>
  </button>

  <div class="meta">
    ${labelBlock}
    <div class="metaRow"><span class="metaKey">Color:</span> <span class="metaVal mono">${escapeHtml(
      entry.value
    )}</span></div>
    <div class="metaRow"><span class="metaKey">Line:</span> <span class="metaVal">${line}</span></div>
  </div>

  <button class="expandBtn" title="Show usages" aria-label="Show usages" aria-expanded="false">▾</button>
  <button class="copy" title="Copy color" aria-label="Copy color">Copy</button>
</div>
<div class="details" hidden>
  <div class="detailsInner">
    ${details || `<div class="emptySmall">No usages found in this file.</div>`}
  </div>
</div>`;
                })
                .join("");

              return `
<section class="group">
  <div class="groupHeader">${escapeHtml(fileTitle)}</div>
  <div class="groupBody">${rows}</div>
</section>`;
            })
            .join("");

    const safeHeaderPath = escapeHtml(headerPath);

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: light dark; }

    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-sideBar-foreground);
    }

    .top {
      display:flex;
      flex-direction:column;
      gap:8px;
      padding:10px 10px 8px;
      border-bottom: 1px solid var(--vscode-sideBar-border);
      background: var(--vscode-sideBar-background);
    }

    .topRow {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
    }

    .title {
      font-size:12px;
      opacity:.9;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
      flex: 1 1 auto;
      min-width: 0;
    }

    .stats {
      display:flex;
      align-items:center;
      gap:10px;
      flex: 0 0 auto;
      white-space:nowrap;
      font-size:12px;
      opacity:.9;
    }

    .sep { opacity: .5; }
    .colorsCount { font-weight: 800; }

    .importsBtn {
      padding:0;
      border:none;
      background:transparent;
      cursor:pointer;
      font-size:12px;
      font-weight:800;
      color: var(--vscode-sideBar-foreground);
    }
    .importsBtn:hover { text-decoration: underline; }

    .importsOff {
      font-size:12px;
      font-weight:800;
      opacity:.35;
      user-select:none;
    }

    .importsPanel {
      padding:8px;
      border-radius:10px;
      border:1px solid var(--vscode-sideBar-border);
      background: var(--vscode-editorWidget-background);
      display:flex;
      flex-direction:column;
      gap:6px;
      max-height: 160px;
      overflow:auto;
    }

    .importLine {
      font-size: 11px;
      opacity: .92;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      white-space: nowrap;
      overflow:hidden;
      text-overflow: ellipsis;
      display:flex;
      justify-content:space-between;
      gap:10px;
    }

    .importCount { opacity: .7; flex: 0 0 auto; }

    button { font: inherit; }

    .refresh {
      padding:6px 10px;
      border-radius:8px;
      border:1px solid var(--vscode-sideBar-border);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor:pointer;
    }
    .refresh:hover { background: var(--vscode-button-secondaryHoverBackground); }

    /* ===== Your requested colors ===== */
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
    }

    .row:hover {
      background: color-mix(in srgb, CanvasText 5%, transparent);
    }
    /* ===== end ===== */

    .swatchBtn { padding:0; border:none; background:transparent; cursor:pointer; flex: 0 0 auto; }
    .swatch { width: 50px; height: 50px; border-radius: 10px; border:1px solid color-mix(in srgb, CanvasText 18%, transparent); }

    .meta { display:flex; flex-direction:column; gap:4px; flex: 1 1 auto; min-width: 0; }
    .metaRow { display:flex; gap:6px; align-items:baseline; }
    .metaKey { font-size:11px; opacity:.7; min-width: 44px; }
    .metaVal { font-size:12px; font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }

    .expandBtn {
      flex: 0 0 auto;
      width: 34px;
      height: 32px;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
      background: color-mix(in srgb, CanvasText 5%, transparent);
      color: inherit;
      cursor: pointer;
      line-height: 1;
      display:flex;
      align-items:center;
      justify-content:center;
    }
    .expandBtn:hover { background: color-mix(in srgb, CanvasText 9%, transparent); }
    .expandBtn.isOpen { transform: rotate(180deg); }

    .copy {
      flex: 0 0 auto;
      padding:6px 10px;
      border-radius:8px;
      border:1px solid color-mix(in srgb, CanvasText 18%, transparent);
      background: color-mix(in srgb, CanvasText 5%, transparent);
      cursor:pointer;
      color: inherit;
    }
    .copy:hover { background: color-mix(in srgb, CanvasText 9%, transparent); }

    .details {
      margin-top: -6px;
      padding-left: 60px;
    }
    .detailsInner {
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
      border-radius: 10px;
      padding: 8px;
      background: var(--vscode-editor-background);
      display:flex;
      flex-direction:column;
      gap:6px;
    }

    .useRow {
      display:flex;
      justify-content:space-between;
      gap:10px;
      padding:6px 8px;
      border-radius:8px;
      border:1px solid color-mix(in srgb, CanvasText 18%, transparent);
      background: transparent;
      cursor:pointer;
    }
    .useRow:hover { background: color-mix(in srgb, CanvasText 5%, transparent); }

    .useMain { display:flex; flex-direction:column; gap:2px; min-width:0; }
    .useLeft {
      font-size:11px;
      font-weight:800;
      opacity:.9;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }
    .useScope { font-weight: 900; }
    .useProp { font-weight: 900; }
    .useLine { font-size:11px; opacity:.75; white-space:nowrap; flex: 0 0 auto; }

    .empty { padding: 10px; opacity: .75; }
    .emptySmall { opacity: .7; font-size: 11px; padding: 4px 2px; }
  </style>
</head>
<body>
  <div class="top">
    <div class="topRow">
      <div class="title">${safeHeaderPath}</div>
      <div class="stats">
        <span class="colorsCount">${totalColors} colors</span>
        <span class="sep">|</span>
        ${importsButton}
      </div>
      <div class="actions">
        <button id="refresh" class="refresh" title="Refresh">Refresh</button>
      </div>
    </div>
    ${importsPanel}
  </div>

  <div class="content">${groupsHtml}</div>

  <script>
    const vscode = acquireVsCodeApi();

    document.getElementById("refresh").addEventListener("click", () => {
      vscode.postMessage({ type: "refresh" });
    });

    const toggle = document.getElementById("importsToggle");
    const panel = document.getElementById("importsPanel");
    if (toggle && panel) {
      toggle.addEventListener("click", () => {
        const isHidden = panel.hasAttribute("hidden");
        if (isHidden) {
          panel.removeAttribute("hidden");
          toggle.setAttribute("aria-expanded", "true");
        } else {
          panel.setAttribute("hidden", "");
          toggle.setAttribute("aria-expanded", "false");
        }
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

      const details = row.nextElementSibling && row.nextElementSibling.classList.contains("details")
        ? row.nextElementSibling
        : null;

      const expandBtn = row.querySelector(".expandBtn");
      if (expandBtn && details) {
        expandBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const hidden = details.hasAttribute("hidden");
          if (hidden) {
            details.removeAttribute("hidden");
            expandBtn.classList.add("isOpen");
            expandBtn.setAttribute("aria-expanded", "true");
          } else {
            details.setAttribute("hidden", "");
            expandBtn.classList.remove("isOpen");
            expandBtn.setAttribute("aria-expanded", "false");
          }
        });
      }

      row.addEventListener("click", (e) => {
        if (e.target && e.target.classList && e.target.classList.contains("copy")) {
          return;
        }
        if (e.target && e.target.closest && e.target.closest(".swatchBtn")) {
          return;
        }
        if (e.target && e.target.closest && e.target.closest(".expandBtn")) {
          return;
        }
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
    });

    document.querySelectorAll(".useRow").forEach((u) => {
      const file = u.getAttribute("data-file");
      const line = Number(u.getAttribute("data-line") || "1");
      const open = () => vscode.postMessage({ type: "open", file, line });

      u.addEventListener("click", (e) => {
        e.stopPropagation();
        open();
      });
      u.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          open();
        }
      });
    });
  </script>
</body>
</html>`;
  }
}

/* =========================================================
   Extension activation
========================================================= */

export function activate(context: vscode.ExtensionContext) {
  const provider = new ColorInspectorViewProvider(context.workspaceState);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ColorInspectorViewProvider.viewType, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("color-inspector.scan", async () => {
      await provider.render();
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      void provider.render();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(() => {
      void provider.render();
    })
  );
}

export function deactivate() {}

/* =========================================================
   Helpers: open/jump + VS Code picker (+ ask before auto space)
========================================================= */

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

    // If we have :# (no space) immediately before token, ASK to insert a space
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

    // Put caret inside token; picker reads token at caret
    const caretCol = Math.min(sCol + 1, Math.max(eCol - 1, sCol));
    const caret = new vscode.Position(line0, caretCol);

    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      selection: new vscode.Range(caret, caret),
    });

    editor.revealRange(new vscode.Range(caret, caret), vscode.TextEditorRevealType.InCenter);

    await vscode.commands.executeCommand("editor.action.showOrFocusStandaloneColorPicker");

    // Restore caret-only selection
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

/* =========================================================
   Helpers: IO + indices
========================================================= */

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

function getLineText(text: string, lineStarts: number[], line0: number): string {
  const start = lineStarts[line0] ?? 0;
  const end = line0 + 1 < lineStarts.length ? (lineStarts[line0 + 1] ?? text.length) : text.length;
  return text.slice(start, end).replace(/\r?\n$/, "");
}

/* =========================================================
   Helpers: keys + detection
========================================================= */

function normalizeColorKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function makeColorKey(o: ColorOccur): string {
  const v = normalizeColorKey(o.value);
  if (o.kind === "var") {
    return `var:${o.name.toLowerCase()}=${v}`;
  }
  return `lit:${v}`;
}

function isCssFile(file: string): boolean {
  return /\.(css|scss|sass|less)$/i.test(file);
}

/* =========================================================
   Context extraction (CSS selector + property / JS style key)
========================================================= */

function findCssContext(
  text: string,
  lineStarts: number[],
  offset: number
): { scope?: string; property?: string } {
  const line0 = offsetToLine0(lineStarts, offset);
  const lineText = getLineText(text, lineStarts, line0);

  let property: string | undefined;
  const propMatch = lineText.match(/^\s*([-\w]+)\s*:/);
  if (propMatch) {
    property = propMatch[1];
  }

  const before = text.slice(0, offset);
  const bracePos = before.lastIndexOf("{");
  if (bracePos < 0) {
    return { scope: undefined, property };
  }

  const beforeBrace = before.slice(0, bracePos);
  const prevClose = beforeBrace.lastIndexOf("}");
  const selectorChunk = beforeBrace.slice(prevClose >= 0 ? prevClose + 1 : 0);

  const scope = selectorChunk
    .replace(/\/\*.*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();

  return { scope: scope || undefined, property };
}

/**
 * Find the JS object key (style property) closest BEFORE a given column on the same line.
 * Example: border: "1px solid var(--border)" -> "border"
 */
function findJsPropertyKeyBeforeCol(lineText: string, col: number): string | undefined {
  const upTo = lineText.slice(0, Math.max(0, col));
  const re = /(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][A-Za-z0-9_$-]*))\s*:\s*/g;

  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null = null;

  while ((m = re.exec(upTo)) !== null) {
    last = m;
  }

  if (!last) {
    return undefined;
  }

  const key = (last[1] ?? last[2] ?? last[3])?.trim();
  return key || undefined;
}

/**
 * JSX scope around a token:
 * - Prefer nearest className within the same JSX tag (even if multi-line)
 * - Else fallback to tag name (div, button, etc.)
 */
function findJsxScopeAround(text: string, lineStarts: number[], tokenLine0: number): string | undefined {
  const MAX_BACK = 30;
  const startLine0 = Math.max(0, tokenLine0 - MAX_BACK);

  // Find likely start of the current tag by walking up until we hit a '<'
  let tagStartLine0: number | undefined;
  for (let i = tokenLine0; i >= startLine0; i--) {
    const lt = getLineText(text, lineStarts, i);
    if (lt.includes("<")) {
      tagStartLine0 = i;
      break;
    }
  }

  const lines: string[] = [];
  if (tagStartLine0 !== undefined) {
    for (let i = tagStartLine0; i <= tokenLine0; i++) {
      lines.push(getLineText(text, lineStarts, i));
    }
  } else {
    lines.push(getLineText(text, lineStarts, tokenLine0));
  }

  const chunk = lines.join(" ");

  // className="pair-card other"
  const m1 = chunk.match(/\bclassName\s*=\s*["']([^"']+)["']/);
  if (m1?.[1]) {
    const first = m1[1].trim().split(/\s+/)[0];
    if (first) {
      return `.${first}`;
    }
  }

  // className={"pair-card"} / {'pair-card'}
  const m2 = chunk.match(/\bclassName\s*=\s*\{\s*["']([^"']+)["']\s*\}/);
  if (m2?.[1]) {
    const first = m2[1].trim().split(/\s+/)[0];
    if (first) {
      return `.${first}`;
    }
  }

  // Fallback: tag name
  const m3 = chunk.match(/<\s*([A-Za-z][A-Za-z0-9]*)\b/);
  if (m3?.[1]) {
    return m3[1];
  }

  return undefined;
}

/* =========================================================
   Scan: var definitions (for resolving var(--x))
========================================================= */

function scanVarDefinitions(text: string): VarDef[] {
  const defs: VarDef[] = [];
  const cssVarDefRegex = /--([A-Za-z0-9_-]+)\s*:\s*([^;]+)\s*;/g;

  for (const m of text.matchAll(cssVarDefRegex)) {
    const propName = `--${m[1]}`;
    const rhs = m[2].trim();

    const value = extractFirstColorToken(rhs);
    if (!value) {
      continue;
    }

    defs.push({ name: propName, value });
  }

  return defs;
}

/* =========================================================
   Scan: occurrences (var defs + var refs + literals)
========================================================= */

function scanTextForColorOccurrences(
  text: string,
  lineStarts: number[],
  file: string,
  globalVarValueByName: Map<string, string>
): ColorOccur[] {
  const occ: ColorOccur[] = [];

  // Hex: #fff, #ffff, #ffffff, #ffffffff
  const hexRegex = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

  // rgb() / rgba()
  const rgbRegex =
    /\brgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0?\.\d+|1|0|\.\d+))?\s*\)/gi;

  // hsl() / hsla()
  const hslRegex =
    /\bhsla?\(\s*\d{1,3}(?:deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*(?:,\s*(?:0?\.\d+|1|0|\.\d+))?\s*\)/gi;

  const cssVarDefRegex = /--([A-Za-z0-9_-]+)\s*:\s*([^;]+)\s*;/g;
  const cssVarRefRegex = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*[^)]*)?\)/g;

  // Exclude spans so we don't double-count literals inside var-def values
  const excludeSpans: Array<{ start: number; end: number }> = [];

  // 1) Var definitions
  for (const m of text.matchAll(cssVarDefRegex)) {
    const matchStart = m.index ?? 0;
    const whole = m[0];
    const propName = `--${m[1]}`;
    const rhs = m[2].trim();

    const value = extractFirstColorToken(rhs);
    if (!value) {
      continue;
    }

    const inner = whole.indexOf(value);
    if (inner < 0) {
      continue;
    }

    const startOffset = matchStart + inner;
    const endOffset = startOffset + value.length;
    excludeSpans.push({ start: startOffset, end: endOffset });

    const line0 = offsetToLine0(lineStarts, startOffset);
    const line = line0 + 1;

    const snippet = getLineText(text, lineStarts, line0);
    const col = offsetToCol(lineStarts, startOffset);

    let scope: string | undefined;
    let property: string | undefined;

    if (isCssFile(file)) {
      const cssCtx = findCssContext(text, lineStarts, startOffset);
      scope = cssCtx.scope;
      property = cssCtx.property;
    } else {
      scope = findJsxScopeAround(text, lineStarts, line0);
      property = findJsPropertyKeyBeforeCol(snippet, col);
    }

    occ.push({
      kind: "var",
      name: propName,
      value,
      file,
      range: {
        line,
        startCol: col,
        endCol: offsetToCol(lineStarts, endOffset),
      },
      usage: {
        isDefinition: true,
        scope,
        property,
        line,
      },
    });
  }

  excludeSpans.sort((a, b) => a.start - b.start);

  const isExcluded = (start: number, end: number): boolean => {
    let lo = 0;
    let hi = excludeSpans.length - 1;
    let idx = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (excludeSpans[mid].start <= start) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (idx < 0) {
      return false;
    }

    const s = excludeSpans[idx];
    return start < s.end && end > s.start;
  };

  // 2) Var references: var(--border) anywhere (CSS, TSX strings, etc.)
  for (const m of text.matchAll(cssVarRefRegex)) {
    const startOffset = m.index ?? 0;
    const matchText = m[0];
    const name = m[1];
    const endOffset = startOffset + matchText.length;

    const resolved = globalVarValueByName.get(name);
    if (!resolved) {
      continue;
    }

    const line0 = offsetToLine0(lineStarts, startOffset);
    const line = line0 + 1;

    const snippet = getLineText(text, lineStarts, line0);
    const col = offsetToCol(lineStarts, startOffset);

    let scope: string | undefined;
    let property: string | undefined;

    if (isCssFile(file)) {
      const cssCtx = findCssContext(text, lineStarts, startOffset);
      scope = cssCtx.scope;
      property = cssCtx.property;
    } else {
      scope = findJsxScopeAround(text, lineStarts, line0);
      property = findJsPropertyKeyBeforeCol(snippet, col);
    }

    occ.push({
      kind: "var",
      name,
      value: resolved,
      file,
      range: {
        line,
        startCol: col,
        endCol: offsetToCol(lineStarts, endOffset),
      },
      usage: {
        isDefinition: false,
        scope,
        property,
        line,
      },
    });
  }

  // 3) Literal hex
  for (const m of text.matchAll(hexRegex)) {
    const startOffset = m.index ?? 0;
    const value = m[0];
    const endOffset = startOffset + value.length;

    if (isExcluded(startOffset, endOffset)) {
      continue;
    }

    const line0 = offsetToLine0(lineStarts, startOffset);
    const line = line0 + 1;

    const snippet = getLineText(text, lineStarts, line0);
    const col = offsetToCol(lineStarts, startOffset);

    let scope: string | undefined;
    let property: string | undefined;

    if (isCssFile(file)) {
      const cssCtx = findCssContext(text, lineStarts, startOffset);
      scope = cssCtx.scope;
      property = cssCtx.property;
    } else {
      scope = findJsxScopeAround(text, lineStarts, line0);
      property = findJsPropertyKeyBeforeCol(snippet, col);
    }

    occ.push({
      kind: "literal",
      value,
      file,
      range: {
        line,
        startCol: col,
        endCol: offsetToCol(lineStarts, endOffset),
      },
      usage: {
        isDefinition: false,
        scope,
        property,
        line,
      },
    });
  }

  // 4) Literal rgb/rgba
  for (const m of text.matchAll(rgbRegex)) {
    const startOffset = m.index ?? 0;
    const value = m[0];
    const endOffset = startOffset + value.length;

    if (isExcluded(startOffset, endOffset)) {
      continue;
    }

    const line0 = offsetToLine0(lineStarts, startOffset);
    const line = line0 + 1;

    const snippet = getLineText(text, lineStarts, line0);
    const col = offsetToCol(lineStarts, startOffset);

    let scope: string | undefined;
    let property: string | undefined;

    if (isCssFile(file)) {
      const cssCtx = findCssContext(text, lineStarts, startOffset);
      scope = cssCtx.scope;
      property = cssCtx.property;
    } else {
      scope = findJsxScopeAround(text, lineStarts, line0);
      property = findJsPropertyKeyBeforeCol(snippet, col);
    }

    occ.push({
      kind: "literal",
      value,
      file,
      range: {
        line,
        startCol: col,
        endCol: offsetToCol(lineStarts, endOffset),
      },
      usage: {
        isDefinition: false,
        scope,
        property,
        line,
      },
    });
  }

  // 5) Literal hsl/hsla
  for (const m of text.matchAll(hslRegex)) {
    const startOffset = m.index ?? 0;
    const value = m[0];
    const endOffset = startOffset + value.length;

    if (isExcluded(startOffset, endOffset)) {
      continue;
    }

    const line0 = offsetToLine0(lineStarts, startOffset);
    const line = line0 + 1;

    const snippet = getLineText(text, lineStarts, line0);
    const col = offsetToCol(lineStarts, startOffset);

    let scope: string | undefined;
    let property: string | undefined;

    if (isCssFile(file)) {
      const cssCtx = findCssContext(text, lineStarts, startOffset);
      scope = cssCtx.scope;
      property = cssCtx.property;
    } else {
      scope = findJsxScopeAround(text, lineStarts, line0);
      property = findJsPropertyKeyBeforeCol(snippet, col);
    }

    occ.push({
      kind: "literal",
      value,
      file,
      range: {
        line,
        startCol: col,
        endCol: offsetToCol(lineStarts, endOffset),
      },
      usage: {
        isDefinition: false,
        scope,
        property,
        line,
      },
    });
  }

  return occ;
}

function extractFirstColorToken(rhs: string): string {
  const s = rhs.trim();

  const hex = s.match(/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/);
  if (hex?.[0]) {
    return hex[0].trim();
  }

  const rgb = s.match(/^(?:rgba?|RGBA?)\([^)]*\)/);
  if (rgb?.[0]) {
    return rgb[0].trim();
  }

  const hsl = s.match(/^(?:hsla?|HSLA?)\([^)]*\)/);
  if (hsl?.[0]) {
    return hsl[0].trim();
  }

  return "";
}

/* =========================================================
   Import graph (explicit only)
========================================================= */

type ImportSpec = { spec: string; kind: "js" | "css" };

function findImports(text: string): ImportSpec[] {
  const results: ImportSpec[] = [];
  const seen = new Set<string>();

  const importFrom = /\bimport\s+[^;]*?\s+from\s+["']([^"']+)["']/g;
  const importBare = /\bimport\s+["']([^"']+)["']/g;
  const requireRe = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

  // Keep this clean (your earlier one got corrupted by a formatter)
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
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return true;
  }
  if (spec.startsWith("/")) {
    return true;
  }
  if (spec.startsWith("@/") || spec.startsWith("~/")) {
    return true;
  }
  if (kind === "css" && !spec.startsWith(".") && !spec.startsWith("@") && !spec.startsWith("~")) {
    return true;
  }
  return false;
}

function resolveWithExtensions(raw: vscode.Uri, spec: string): vscode.Uri[] {
  const hasExt = /\.[a-zA-Z0-9]+$/.test(spec);
  if (hasExt) {
    return [raw];
  }

  const exts = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".json",
    ".vue",
    ".svelte",
    ".html",
  ];
  const candidates: vscode.Uri[] = [];

  for (const ext of exts) {
    candidates.push(vscode.Uri.parse(raw.toString() + ext));
  }
  for (const ext of exts) {
    candidates.push(vscode.Uri.joinPath(raw, "index" + ext));
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

  while (queue.length && out.length < maxFiles) {
    const uri = queue.shift()!;
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