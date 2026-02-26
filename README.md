# 🎨 Color Inspector

![Version](https://img.shields.io/badge/version-0.0.1-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Early Development](https://img.shields.io/badge/status-early--development-orange)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

A focused VS Code extension that scans the active file and its explicit imports to find and organize color usage.

No guessing. No magic crawling. Just what you actually imported.

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

Near-term:
- Improve detection of color usages in JSX/TSX inline style objects
- More reliable scope detection across multi-line JSX
- Better parsing for rgba()/hsla()/color-mix() edge cases
- Reduce duplicate matches
- Performance improvements for larger import graphs

Mid-term:
- Optional AST-based scanning for JS/TS/TSX
- Support more preprocessors and CSS module patterns
- Improved usage grouping and deduplication
- Configurable include/exclude settings

Later:
- Export color reports (JSON/CSV)
- Enhanced swatch rendering
- Automated tests for real-world codebases

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

---

## 📝 Changelog

### 0.0.1
- Initial release — color scanning from active file and explicit imports
- CSS variable detection, var() resolution, hex/rgb/hsl support
- Sidebar view with swatches, jump-to-line, copy, and VS Code color picker
- Added CONTRIBUTING.md, CODE_OF_CONDUCT.md, issue templates, and release checklist
