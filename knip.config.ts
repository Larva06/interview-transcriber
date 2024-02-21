import type { KnipConfig } from "knip";

const config: KnipConfig = {
	ignoreDependencies: [
		// bun run is not handled correctly by script parser
		"@commitlint/cli",
	],
};

// biome-ignore lint/style/noDefaultExport:
export default config;
