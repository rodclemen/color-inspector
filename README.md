# Color Inspector

Color Inspector scans the currently active file and its explicit imports, finds color references, and shows them in a sidebar view with swatches and copy/jump actions.

## Features

- Finds CSS variables (e.g. `--border: #aabbcc;`) and literal colors (`#fff`, `rgba(...)`, `hsl(...)`)
- Follows explicit imports only (no guessing)
- Groups results by file
- Click a row to jump to the line
- Copy the color value
- Open VS Code’s color picker from the swatch
- Expand a color to see where it’s used (scope + property + line)

## Usage

1. Open a file you want to scan.
2. Open the **Color Inspector** view in the Activity Bar / Side Bar.
3. Click **Refresh** if needed.

## Notes

- Only follows explicit imports from the active file.
- JSX/TSX scope is best-effort (prefers `className`, falls back to tag name).