import type { UserConfig } from "@commitlint/types";

const commitlintConfig: UserConfig = {
	extends: ["@commitlint/config-conventional"],
};

// biome-ignore lint/nursery/noDefaultExport:
export default commitlintConfig;
