# Changelog

All notable changes to **Color Inspector** will be documented in this file.

This project is currently in early development and evolving rapidly.  
Expect rough edges. That’s part of the fun.

---

## [Unreleased] - 2026-02-28

### 🎨 Improved
- JSX/TSX usage scope now shows a breadcrumb context like `"MyComponent > Card > .container"` instead of just the first tag name found. Distinguishes PascalCase JSX components from lowercase HTML tags, and stops walking up at component/function declaration boundaries.
- `var(--x)` usage detection in JSX/TSX files now correctly prefers JSX scope over CSS scope, preventing inline style references from showing `"unknown"` when no CSS selector exists nearby.

> _Based on PR #3 by [Chizaram-Igolo](https://github.com/Chizaram-Igolo) — applied selectively._

---

## [0.0.6] - 2026-02-26

### ✨ Added
- Theme-aware grouping (Dark / Light / Base / Other)
- Automatic detection of `prefers-color-scheme` blocks
- Detection of `data-theme-mode="dark|light"` patterns
- System/Auto theme indicator icon in file headers
- Setting: `colorInspector.themeGroupsStartOpen`
  - Control whether theme groups start expanded or collapsed

### 🎨 Improved
- File header now displays theme icons (Light / Dark / System)
- Better separation of theme variable definitions
- More accurate theme detection for CSS / SCSS files

### 🛠 Fixed
- Improved duplicate color handling across imports
- Minor UI layout and spacing refinements

---

## [0.0.5] - 2026-02-26

### ✨ Added
- Expandable usage view per color
- Usage detection for:
  - `var(--variable)`
  - Direct hex / rgb / hsl usage
- Jump-to-line improvements
- VS Code native color picker integration

### 🎨 Improved
- Sidebar UI polish
- Copy-to-clipboard interaction
- Better import-following logic

---

## [0.0.4] - 2026-02-26

### ✨ Added
- Explicit import graph traversal (JS / TS / CSS)
- Import counter in header (`+N Imports`)
- Import file list panel (collapsible)

### 🎨 Improved
- More stable color deduplication across files
- Cleaner grouping by file

---

## [0.0.3] - 2026-02-26

### ✨ Major Improvements
- Sidebar redesigned to group colors by file
- Header now shows:
  - Workspace-relative file path
  - Total color count
  - Import count with expandable import list
- Expandable import list showing imported files and color counts
- Expandable usage panel per color
  - Shows selector / component scope (e.g. `.pair-card`)
  - Shows property using the color (e.g. `border`, `background`, `filter`)
  - Shows line number
- Improved variable handling
  - Prevents duplicate listing of `--var` and its literal value
- Improved JSX / inline style detection
  - Detects `style={{ border: "1px solid var(--border)" }}`
- Expand arrow moved to correct position (left of copy button)
- Expanded usage now expands vertically (correct layout behavior)
- UI updated to use VS Code theme variables
- Auto-scan interval setting added (0–10 minutes)
- Settings shortcut button inside panel
- Manual Scan / Refresh workflow (no auto scan on open)

### 🐛 Fixes
- Fixed duplicate variable + literal detection
- Fixed import resolution issues
- Fixed broken CSS `@import` regex
- Restored `rgba()`, `rgb()`, `hsl()`, `hsla()` detection
- Fixed expanded panel rendering to prevent sideways expansion
- Fixed color picker caret positioning issues
- Fixed improper selection behavior when opening picker

### ⚠ Known Limitations
- Usage detection is best-effort and may not cover all dynamic patterns
- Complex inline computed styles may not fully resolve
- Very large projects may need performance optimization
- Early development — API and behavior may change

---

## [0.0.2] - 2026-02-25

### Added
- Initial sidebar view
- Import graph scanning (explicit imports only)
- Color detection:
  - CSS variables
  - Hex
  - `rgb()` / `rgba()`
- Click-to-copy
- Click-to-jump-to-line
- VS Code color picker integration
- Manual refresh command

---

## [0.0.1] - 2026-02-24

### Initial Commit
- Basic color scanning prototype
- Webview panel
- CSS variable detection