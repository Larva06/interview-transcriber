import type { KnipConfig } from "knip";

const config: KnipConfig = {
	ignoreBinaries: ["screen"],
	ignoreDependencies: ["bun-types"],
};

// biome-ignore lint/style/noDefaultExport:
export default config;
