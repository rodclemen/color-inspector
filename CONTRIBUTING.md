Contributing to Color Inspector

First of all — thank you.
If you’re reading this, you’re already awesome.

This project is intentionally open, hackable, and collaborative.
It’s early. It’s evolving. And yes — contributions are very welcome.

⸻

What kind of help do we want?

Anything that makes the inspector smarter, cleaner, faster, or more accurate.

Examples:
	•	Improve JSX/TSX scope detection
	•	Replace regex parsing with AST-based analysis
	•	Improve import resolution
	•	Reduce duplicate matches
	•	Add performance improvements
	•	Improve accessibility in the webview
	•	Add tests (very welcome)
	•	Improve documentation

If it makes the extension better — it belongs here.

⸻

Development Setup
	1.	Install dependencies:
npm install
	2.	Compile:
npm run compile
	3.	Press F5 to launch an Extension Development Host

That’s it.

⸻

Philosophy
	•	Prefer clarity over cleverness.
	•	Avoid “magic” behavior.
	•	Never silently modify user code.
	•	If something edits code, it must ask first.

The extension should feel predictable.

⸻

Pull Requests
	•	Small and focused is better than huge and mysterious.
	•	Explain why a change was made.
	•	If you change parsing behavior, include a minimal code example.

We’re building something useful — not mysterious.