import { promisify } from "node:util";
import { env } from "bun";
import { consola } from "consola";
import { ActivityType, Client, Events } from "discord.js";
import Ffmpeg from "fluent-ffmpeg";
import { geminiClient, openaiClient } from "./ai";
import { commandsListener, registerCommands } from "./commands";
import { driveClient } from "./gdrive";

consola.start("interview-transcriber is starting...");

// check if all required environment variables are set
// need to sync with env.d.ts
const requiredEnvs = [
	"DISCORD_BOT_TOKEN",
	"DISCORD_GUILD_ID",
	"GOOGLE_SERVICE_ACCOUNT_EMAIL",
	"GOOGLE_SERVICE_ACCOUNT_KEY",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
];
const missingEnv = requiredEnvs.filter((name) => !env[name]);
if (missingEnv.length) {
	consola.error(
		`Environment variables ${missingEnv.join(
			", ",
		)} are not set. Follow the instructions in README.md and set them in .env.`,
	);
	process.exit(1);
}

// test if the client is working with valid credentials to fail fast

consola.start("Checking ffmpeg installation...");
await promisify(Ffmpeg.getAvailableFormats)();
consola.ready("ffmpeg is installed!");

consola.start("Initializing OpenAI API client...");
await openaiClient.models.list();
consola.ready("OpenAI API client is now ready!");

consola.start("Initializing Gemini API client...");
const result = await geminiClient
	.getGenerativeModel({
		model: "gemini-pro",
	})
	.generateContent("Ping! Say something to me!");
consola.info(`Gemini: ${result.response.text()}`);
consola.ready("Gemini API client is now ready!");

consola.start("Initializing Google Drive API client...");
consola.info(`Service account email: ${env.GOOGLE_SERVICE_ACCOUNT_EMAIL}`);
const files = await driveClient.files.list({
	fields: "files(owners)",
});
// exit if the service account has access to no files
// exclude files owned by the service account itself
// only legacy files have multiple owners, so we do not support them
// ref: https://developers.google.com/drive/api/reference/rest/v3/files#File.FIELDS.owners
if (
	!files.data.files?.filter(({ owners }) => owners?.[0] && !owners?.[0]?.me)
		.length
) {
	consola.warn(
		"No files are shared to the service account in Google Drive. Share some files to the service account.",
	);
}
consola.ready("Google Drive API client is now ready!");

consola.start("Starting Discord bot...");
const discordClient = new Client({ intents: [] });

discordClient.once(Events.ClientReady, async (client) => {
	consola.ready("Discord bot is now ready!");
	consola.info(`Logged in as ${client.user.tag}.`);

	client.user.setActivity("Whisper", { type: ActivityType.Streaming });

	const application = await client.application.fetch();
	const botSettingsUrl = `https://discord.com/developers/applications/${application.id}/bot`;
	if (application.botPublic) {
		consola.warn(
			`Bot is public (can be added by anyone). Consider making it private from ${botSettingsUrl}.`,
		);
	}
	if (application.botRequireCodeGrant) {
		consola.warn(
			`Bot requires OAuth2 code grant. It is unnecessary for this bot. Consider disabling it from ${botSettingsUrl}.`,
		);
	}

	await registerCommands(client);

	consola.ready("interview-transcriber is successfully started!");
});

discordClient.on(Events.InteractionCreate, commandsListener);

discordClient.login(env.DISCORD_BOT_TOKEN);
