// Mirrors CONTRIBUTING.md.
export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		"scope-enum": [
			2,
			"always",
			["theme", "ui", "assets", "deps", "ci", "lint"],
		],
		"header-max-length": [2, "always", 72],
		"body-max-line-length": [2, "always", 72],
	},
};
