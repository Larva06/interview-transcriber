declare module "bun" {
	interface Env {
		/**
		 * Token of the Discord bot.
		 */
		// biome-ignore lint/style/useNamingConvention: should be SCREAMING_SNAKE_CASE
		DISCORD_BOT_TOKEN: string;

		/**
		 * ID of the Discord guild where the bot is used.
		 */
		// biome-ignore lint/style/useNamingConvention:
		DISCORD_GUILD_ID: string;

		/**
		 * Email of the Google Cloud service account.
		 * (`client_email` in the JSON file)
		 */
		// biome-ignore lint/style/useNamingConvention:
		GOOGLE_SERVICE_ACCOUNT_EMAIL: string;

		/**
		 * Private key of the Google Cloud service account.
		 * (`private_key` in the JSON file)
		 */
		// biome-ignore lint/style/useNamingConvention:
		GOOGLE_SERVICE_ACCOUNT_KEY: string;

		/**
		 * API key of the OpenAI API.
		 */
		// biome-ignore lint/style/useNamingConvention:
		OPENAI_API_KEY: string;

		/**
		 * API key of the Gemini API.
		 */
		// biome-ignore lint/style/useNamingConvention:
		GEMINI_API_KEY: string;
	}
}
