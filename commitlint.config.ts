import type { UserConfig } from "@commitlint/types";

const commitlintConfig: UserConfig = {
	extends: ["@commitlint/config-conventional"],
};

// biome-ignore lint/style/noDefaultExport:
export default commitlintConfig;
