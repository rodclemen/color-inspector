# 🎨 Color Inspector

> 🚧 Early development. Contributions welcome.

![License](https://img.shields.io/badge/license-MIT-green)
![Early Development](https://img.shields.io/badge/status-early--development-orange)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)
![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/rodclemen.color-inspector)
![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/rodclemen.color-inspector)
![Visual Studio Marketplace Rating](https://img.shields.io/visual-studio-marketplace/r/rodclemen.color-inspector)
![Visual Studio Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/rodclemen.color-inspector)
![Color Inspector banner](media/banner.png)

Track down every color in your codebase (via explicit imports). Swatches, copy-paste, jump-to-line, and usage — in the sidebar.

🚧 Early development. Contributions welcome.

## What it does
- Scans the active file and its **explicit imports** (hard stop: no guessing)
- Finds CSS variables and color literals (hex, rgb/rgba, hsl/hsla)
- Groups results by file with large, readable swatches
- Expand a color to see **where it’s used** (best-effort)
- Click to copy, click to jump, click swatch to open the VS Code color picker

## How to use
1. Open a file
2. Open the **Color Inspector** view in the Activity Bar
3. Click **Scan** (first time) / **Refresh** (after)

---

## 🚧 Status

Early development.

Some example scenarios shown below are still not 100% reliable — especially:

- Complex multi-line JSX structures  
- Edge-case inline styles  
- Nested template literals  
- Unusual import patterns  
- Certain advanced CSS constructs  

Scope detection and usage mapping are improving, but not perfect yet.

If something doesn’t show up, it’s not you. It’s the parser.

---

## 🤝 Contributions Welcome

This project is intentionally open and evolving.
If you see something imperfect — that’s an invitation.

I fully welcome collaboration.
See CONTRIBUTING.md for dev setup and PR guidelines.

If you want to:

- Improve parsing accuracy  
- Add smarter AST-based analysis  
- Refactor architecture  
- Improve performance  
- Polish UI/UX  
- Add tests  
- Clean up rough edges  

If you'd like to help improve it, check the issues labeled:

- [good first issue](https://github.com/rodclemen/color-inspector/labels/good%20first%20issue)
- [help wanted](https://github.com/rodclemen/color-inspector/labels/help%20wanted)

Open an issue. Open a PR. Ask questions.

This project is intentionally open for cooperation.  
If you want to help shape it — just say so.

---

## ✨ Features

- Detects:
  - CSS variables (example: --border: #aabbcc)
  - var(--token) references
  - Hex colors (#fff, #aabbcc)
  - rgb() / rgba()
  - hsl() / hsla()
- Follows explicit imports only
- Groups results by file
- Shows:
  - Label (for CSS variables)
  - Resolved color value
  - Line number
- Click to:
  - Jump to line
  - Copy color
  - Open VS Code’s native color picker
- Expand a color to see:
  - Scope (.pair-card, div, etc.)
  - Property (border, background, boxShadow, etc.)
  - Line of usage

---

## 🧠 How It Works

1. Starts from the currently active file.
2. Traverses only explicit import statements.
3. Scans each file for:
   - Variable definitions
   - Variable usages
   - Literal color values
4. Resolves var(--token) to its defined value (if available).
5. Displays a structured, grouped view in the sidebar.

No implicit resolution.  
No global scanning.  
If it’s not imported, it’s not scanned.

Hard stop.

---

## 📂 Example Output

For this CSS:

    .pair-card {
      border: 1px solid var(--border);
      background: var(--panel);
    }

You should see something like:

    .pair-card • border — Line 12
    .pair-card • background — Line 13

For JSX:

    <div
      className="pair-card"
      style={{
        border: "1px solid var(--border)",
        boxShadow: "0 12px 40px rgba(0,0,0,.25)",
      }}
    >

You should see something like:

    .pair-card • border — Line 45
    .pair-card • boxShadow — Line 46

Note: Complex JSX formatting may not always resolve the correct scope yet.

---

## 🗺️ Roadmap

This project is in early development. The core workflow works, but there’s plenty to improve.

### Next up
- Improve usage detection (especially JSX/TSX inline styles and nested declarations)
- Better grouping / deduping across imports and shared theme variables
- Performance controls for large projects (limits, caching, incremental scan)
- More color formats (edge cases) and better parsing of gradients
- UI polish: smoother expand/collapse, better density controls

### Nice-to-have
- Export palette (JSON / CSS vars / ASE)
- Search / filter within results
- Sort modes (by frequency, by file, by name)
- “Scan workspace” command (opt-in, not automatic)

---

## 🧩 Good First Issues

- Add tests for color scanners (hex/rgb/hsl + CSS variable parsing)
- Improve import detection edge cases
- Improve JSX scope detection
- UI polish (focus states, accessibility, keyboard navigation)
- Improve deduping rules

---

## 🛠 Installation

Install from VSIX:

    code --install-extension color-inspector-0.0.1.vsix

Or in VS Code:

1. Open Extensions panel  
2. Click the three-dot menu  
3. Choose “Install from VSIX…”  

---

## 🚀 Development

Install dependencies:

    npm install

Compile:

    npm run compile

Run in development mode:

Press F5 to launch an Extension Development Host.

Package:

    vsce package

---

## ⚙️ Behavior Notes

- Only explicit imports are followed.
- JSX scope detection prefers className and falls back to tag names.
- Variable resolution uses first definition found.
- Parsing is heuristic-based (not full AST analysis — yet).

---

## 📄 License

MIT