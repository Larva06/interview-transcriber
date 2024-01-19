import { env } from "bun";
import consola from "consola";
import {
	ApplicationCommandType,
	type ChatInputCommandInteraction,
	type Client,
	DiscordAPIError,
	EmbedBuilder,
	type Interaction,
	type MessageContextMenuCommandInteraction,
	OAuth2Scopes,
	RESTJSONErrorCodes,
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
	type RESTPostAPIContextMenuApplicationCommandsJSONBody,
	type RESTPutAPIApplicationGuildCommandsJSONBody,
	Routes,
	SlashCommandBuilder,
	type UserContextMenuCommandInteraction,
} from "discord.js";
import { extractFileId } from "./gdrive";
import { transcribe } from "./transcribe";

type ExecutableCommand =
	| {
			type: ApplicationCommandType.ChatInput;
			data: RESTPostAPIChatInputApplicationCommandsJSONBody;
			execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
	  }
	| {
			type: ApplicationCommandType.Message;
			data: RESTPostAPIContextMenuApplicationCommandsJSONBody;
			execute: (
				interaction: MessageContextMenuCommandInteraction,
			) => Promise<void>;
	  }
	| {
			type: ApplicationCommandType.User;
			data: RESTPostAPIContextMenuApplicationCommandsJSONBody;
			execute: (
				interaction: UserContextMenuCommandInteraction,
			) => Promise<void>;
	  };

/**
 * Application commands registered to the bot.
 */
const commands: ExecutableCommand[] = [
	{
		type: ApplicationCommandType.ChatInput,
		data: new SlashCommandBuilder()
			.setName("transcribe")
			.setDescription("Transcribe an interview from a Google Drive file.")
			.setDescriptionLocalization(
				"ja",
				"Google ドライブのファイルからインタビューを書き起こします",
			)
			.addStringOption((option) =>
				option
					.setName("video_url")
					.setDescription("The Google Drive URL of the video to transcribe.")
					.setDescriptionLocalization(
						"ja",
						"書き起こす動画の Google ドライブ URL",
					)
					.setRequired(true),
			)
			.addStringOption((option) =>
				option
					.setName("proofread_model")
					.setDescription("The AI model to use for proofreading.")
					.setDescriptionLocalization("ja", "校正に使用する AI モデル")
					.setChoices(
						{ name: "GPT-4 Turbo", value: "gpt-4-1106-preview" },
						{ name: "Gemini Pro", value: "gemini-pro" },
					),
			)
			.toJSON(),
		execute: async (interaction) => {
			const videoFileId = extractFileId(
				interaction.options.getString("video_url", true) ?? "",
			);
			if (!videoFileId) {
				await interaction.reply({
					content: "Invalid video URL.",
					ephemeral: true,
				});
				return;
			}

			const language = interaction.guildLocale?.startsWith("en")
				? "en"
				: interaction.guildLocale?.startsWith("ja")
				  ? "ja"
				  : undefined;

			const proofreadModel = interaction.options.getString("proofread_model") as
				| "gpt-4-1106-preview"
				| "gemini-pro"
				| null;

			interaction.deferReply();
			try {
				const { video, parent, audio, transcription, proofreadTranscription } =
					await transcribe(videoFileId, language, proofreadModel ?? undefined);
				await interaction.editReply({
					embeds: [
						new EmbedBuilder()
							.setTitle(video.name)
							.setURL(video.webViewLink)
							.setFields(
								[
									...(parent
										? [
												{
													keyEn: "Folder",
													keyJa: "フォルダー",
													file: parent,
												},
										  ]
										: []),
									{
										keyEn: "Audio",
										keyJa: "音声",
										file: audio,
									},
									{
										keyEn: "Transcription",
										keyJa: "文字起こし",
										file: transcription,
									},
									{
										keyEn: "Proofread",
										keyJa: "校正",
										file: proofreadTranscription,
									},
								].map(({ keyEn, keyJa, file: { name, webViewLink } }) => ({
									name: language === "en" ? keyEn : keyJa,
									value: `[${name}](${webViewLink})`,
									inline: true,
								})),
							)
							.setColor("Green")
							.toJSON(),
					],
				});
			} catch (error) {
				const message =
					error instanceof Error ? error.message : JSON.stringify(error);
				await interaction.editReply({
					embeds: [
						new EmbedBuilder()
							.setTitle("Error")
							.setDescription(message)
							.setColor("Red")
							.toJSON(),
					],
				});
				console.error(error);
			}
		},
	},
];

/**
 * Register application commands of the bot to Discord.
 * @param client client used to register commands
 */
export const registerCommands = async (client: Client<true>) => {
	consola.start("Registering application commands...");
	try {
		const body: RESTPutAPIApplicationGuildCommandsJSONBody = commands.map(
			(command) => command.data,
		);
		await client.rest.put(
			// register as guild commands to avoid accessing data from DMs or other guilds
			Routes.applicationGuildCommands(
				client.application.id,
				env.DISCORD_GUILD_ID,
			),
			{ body },
		);

		consola.success(
			`Successfully registered application commands: ${commands
				.map((command) => command.data.name)
				.join(", ")}`,
		);
	} catch (error) {
		consola.error("Failed to register application commands.");
		//
		// cspell:ignore restjson
		if (
			error instanceof DiscordAPIError &&
			error.code === RESTJSONErrorCodes.MissingAccess
		) {
			consola.error(
				`Bot may not be in the target guild ${env.DISCORD_GUILD_ID}.`,
			);
			const application = await client.application.fetch();
			if (!application.botRequireCodeGrant) {
				const authorizationUrl = new URL(
					"https://discord.com/api/oauth2/authorize",
				);
				authorizationUrl.searchParams.append("client_id", client.user.id);
				authorizationUrl.searchParams.append(
					"scope",
					OAuth2Scopes.ApplicationsCommands,
				);
				consola.info(
					`Follow this link to add the bot to the guild: ${authorizationUrl}`,
				);
			}
		}
		// do not use consola#error to throw Error since it cannot handle line numbers correctly
		console.error(error);
		process.exit(1);
	}
};

/**
 * Listener for application command interactions.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: if-else statements are necessary here
export const commandsListener = async (interaction: Interaction) => {
	if (!interaction.isCommand()) {
		return;
	}

	// ignore commands from unauthorized guilds or DMs
	if (interaction.guildId !== env.DISCORD_GUILD_ID) {
		consola.warn(
			`Command ${interaction.commandName} was triggered in ${
				interaction.inGuild() ? "an unauthorized guild" : "DM"
			}.`,
		);
		return;
	}

	for (const command of commands) {
		if (command.data.name !== interaction.commandName) {
			continue;
		}

		// do not use switch-case here because the types are not narrowed
		if (
			interaction.isChatInputCommand() &&
			command.type === ApplicationCommandType.ChatInput
		) {
			await command.execute(interaction);
			return;
		}
		if (
			interaction.isMessageContextMenuCommand() &&
			command.type === ApplicationCommandType.Message
		) {
			await command.execute(interaction);
			return;
		}
		if (
			interaction.isUserContextMenuCommand() &&
			command.type === ApplicationCommandType.User
		) {
			await command.execute(interaction);
			return;
		}

		consola.error(`Command ${command.data.name} not found.`);
	}
};
