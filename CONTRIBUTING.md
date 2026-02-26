# Contributing to Color Inspector

Thanks for wanting to help — collaboration is fully welcome.

## Ways to contribute
- Bug reports (with a minimal repro)
- Parser improvements (regex or AST-based)
- UI/UX improvements in the webview
- Performance improvements (caching/incremental refresh)
- Tests and fixtures for real-world cases
- Documentation polish

## Development setup
1) Install deps:
   npm install

2) Build:
   npm run compile

3) Run:
   Press F5 to launch an Extension Development Host

## Code style and intent
- Prefer clarity over cleverness
- Avoid silent behavior changes (especially anything that edits user files)
- Parser changes should come with a small repro snippet whenever possible

## Submitting a PR
1) Fork the repo
2) Create a branch: feature/my-change or fix/my-bug
3) Commit with a clear message
4) Open a PR describing what changed and why

## Reporting parsing issues
Please include:
- A minimal code snippet that fails
- The language/file type (css/tsx/vue/etc)
- What you expected vs what you got
- Any relevant logs or screenshots
