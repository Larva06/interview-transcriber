import type { KnipConfig } from "knip";

const config: KnipConfig = {
	ignoreDependencies: [
		// @commitlint/cli cannot be detected because its binary is named "commitlint"
		// ref: https://knip.dev/guides/handling-issues/#example
		"@commitlint/cli",
	],
};

// biome-ignore lint/style/noDefaultExport:
export default config;
