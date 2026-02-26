Release Checklist

Before tagging a new version:
	•	Bump version in package.json
	•	Update README if behavior changed
	•	Test in Extension Development Host
	•	Run npm run compile
	•	Package with vsce package
	•	Install VSIX locally and test
	•	Push tag
	•	Publish (when ready)

Bonus:
	•	Add a short changelog entry
	•	Celebrate