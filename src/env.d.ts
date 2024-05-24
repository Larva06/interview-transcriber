declare module "bun" {
	interface Env {
		/**
		 * Token of the Discord bot.
		 */
		readonly DISCORD_BOT_TOKEN: string;

		/**
		 * ID of the Discord guild where the bot is used.
		 */
		readonly DISCORD_GUILD_ID: string;

		/**
		 * Email of the Google Cloud service account.
		 * (`client_email` in the JSON file)
		 */
		readonly GOOGLE_SERVICE_ACCOUNT_EMAIL: string;

		/**
		 * Private key of the Google Cloud service account.
		 * (`private_key` in the JSON file)
		 */
		readonly GOOGLE_SERVICE_ACCOUNT_KEY: string;

		/**
		 * API key of the Gemini API.
		 */
		readonly GEMINI_API_KEY: string;
	}
}
