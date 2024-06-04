import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { write } from "bun";
import consola from "consola";
import {
	ApplicationCommandType,
	EmbedBuilder,
	SlashCommandBuilder,
} from "discord.js";
import uniqueString from "unique-string";
import type { ExecutableCommand } from "./commands.ts";
import { extractAudio, removeSilence, splitAudio } from "./ffmpeg.ts";
import {
	downloadFile,
	extractFileId,
	getFileMetadata,
	uploadFile,
} from "./gdrive.ts";
import {
	genders,
	maxAudioFileDuration,
	transcribeAudioFile,
} from "./gemini.ts";

/**
 * Transcribe a video or an audio file.
 * @param sourceFileId Google Drive file ID of the source file.
 * @param speakers Array of speakers with their names and genders
 * @returns Google Drive file metadata of the uploaded files (audio, transcription, proofread transcription).
 */
const transcribe = async (
	sourceFileId: string,
	speakers: Parameters<typeof transcribeAudioFile>[1],
) => {
	consola.start(`Transcribing ${sourceFileId}...`);
	const sourceFile = await getFileMetadata(sourceFileId, [
		"name",
		"webViewLink",
		"mimeType",
		"parents",
	]);
	const fileType = sourceFile.mimeType.split("/")[0];
	if (fileType !== "video" && fileType !== "audio") {
		throw new Error("Specified file is not a video nor an audio.");
	}
	const sourceBasename = basename(sourceFile.name, extname(sourceFile.name));
	consola.info(
		`File (${fileType}): ${sourceFile.name} (${sourceFile.webViewLink})`,
	);
	const parentFolderId = sourceFile.parents[0];

	const tempDir = await mkdtemp(join(tmpdir(), "interview-transcriber-"));

	try {
		consola.start("Downloading source file...");
		const sourceFilePath = await downloadFile(
			sourceFileId,
			// use random string to avoid non-ASCII characters in the file name which causes an error in whisper
			join(tempDir, uniqueString() + extname(sourceFile.name)),
		);
		consola.success(`Downloaded to ${sourceFilePath}`);

		const parentFolder = parentFolderId
			? getFileMetadata(parentFolderId, ["name", "webViewLink"]).then(
					(data) => {
						consola.info(`Parent folder: ${data.name} (${data.webViewLink})`);
						return data;
					},
				)
			: undefined;

		let audioFilePath: string;
		let audioFile: ReturnType<typeof uploadFile> | undefined;
		if (fileType === "audio") {
			audioFilePath = sourceFilePath;
		} else {
			consola.start("Extracting audio...");
			audioFilePath = await extractAudio(sourceFilePath);
			consola.success(`Extracted audio to ${audioFilePath}`);
			audioFile = uploadFile(
				audioFilePath,
				`${sourceBasename}_audio`,
				parentFolderId,
			).then((data) => {
				consola.success(`Uploaded audio to ${data.webViewLink}`);
				return data;
			});
		}

		consola.start("Removing silence...");
		const noSilenceAudioFilePath = await removeSilence(audioFilePath);
		consola.success("Removed silence from the audio");

		consola.start("Splitting audio...");
		const audioSegments = await splitAudio(
			noSilenceAudioFilePath,
			maxAudioFileDuration,
		);
		consola.success(
			`Split audio into ${audioSegments.length} files (total ${
				audioSegments.at(-1)?.endTime
			} seconds)`,
		);

		consola.start("Transcribing audio...");
		const transcriptions = await Promise.all(
			audioSegments.map(({ path }) => transcribeAudioFile(path, speakers)),
		);
		const transcribedText = transcriptions.join("\n");
		const transcriptionFilePath = join(
			tempDir,
			`${basename(sourceFilePath, extname(sourceFilePath))}_transcription.txt`,
		);
		await write(transcriptionFilePath, transcribedText);
		consola.success(
			`Transcribed audio to ${transcriptionFilePath} (${
				[
					...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(
						transcribedText,
					),
				].length
			} characters)`,
		);
		const transcriptionFile = uploadFile(
			transcriptionFilePath,
			`${sourceBasename}_transcription`,
			parentFolderId,
			"application/vnd.google-apps.document",
		).then((data) => {
			consola.success(`Uploaded transcription to ${data.webViewLink}`);
			return data;
		});

		consola.success(`Transcribed ${sourceFileId}.`);
		return {
			source: sourceFile,
			// parent is undefined if the source file is not in a folder
			parent: await parentFolder,
			// audio is undefined if the source file is an audio file
			audio: await audioFile,
			transcription: await transcriptionFile,
		};
	} finally {
		await rmdir(tempDir, { recursive: true });
	}
};

/**
 * Create an executable slash command to transcribe an interview from a video or an audio file.
 * @returns Executable slash command
 */
export const createTranscribeCommand = (): ExecutableCommand => {
	const speakersOptions = [
		{
			name: "interviewee",
			description: "インタビュイー",
			required: true,
		},
		...Array.from({ length: 2 }, (_, i) => ({
			name: `interviewer_${i + 1}`,
			description: `インタビュアー${i + 1}`,
			// at least one interviewer is required
			required: i === 0,
		})),
	];

	const builder = new SlashCommandBuilder()
		.setName("transcribe")
		.setDescription("Google ドライブのファイルからインタビューを書き起こします")
		.addStringOption((option) =>
			option
				.setName("source_url")
				.setDescription("書き起こす動画・音声のGoogleドライブURL")
				.setRequired(true),
		);

	for (const { name, description, required } of speakersOptions) {
		builder.addStringOption((option) =>
			option
				.setName(`${name}_name`)
				.setDescription(`${description}の名前`)
				.setRequired(required),
		);
		builder.addStringOption((option) =>
			option
				.setName(`${name}_gender`)
				.setDescription(`${description}の性別`)
				.setRequired(required)
				.setChoices(
					genders.map((gender) => ({
						name: `${gender}性`,
						value: gender,
					})),
				),
		);
	}

	return {
		type: ApplicationCommandType.ChatInput,
		data: builder.toJSON(),
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: giving up
		execute: async (interaction) => {
			const sourceFileId = extractFileId(
				interaction.options.getString("source_url", true) ?? "",
			);
			if (!sourceFileId) {
				await interaction.reply({
					content: "Invalid file URL.",
					ephemeral: true,
				});
				return;
			}

			const speakers = speakersOptions
				.map(({ name, required }) => ({
					role: name,
					name: interaction.options.getString(`${name}_name`, required),
					gender: interaction.options.getString(`${name}_gender`, required) as
						| (typeof genders)[number]
						| null,
				}))
				.filter(
					(
						speaker,
					): speaker is {
						role: string;
						name: NonNullable<(typeof speaker)["name"]>;
						gender: NonNullable<(typeof speaker)["gender"]>;
					} => !!speaker.name && !!speaker.gender,
				);

			interaction.deferReply();
			try {
				const { source, parent, audio, transcription } = await transcribe(
					sourceFileId,
					speakers,
				);
				await interaction.editReply({
					embeds: [
						new EmbedBuilder()
							.setTitle(parent?.name ?? source.name)
							.setURL(parent?.webViewLink ?? source.webViewLink)
							.setFields(
								[
									...(parent
										? [
												{
													key: audio ? "動画" : "音声",
													file: source,
												},
											]
										: []),
									...(audio
										? [
												{
													key: "音声",
													file: audio,
												},
											]
										: []),
									{
										key: "文字起こし",
										file: transcription,
									},
								].map(({ key, file: { name, webViewLink } }) => ({
									name: key,
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
	};
};
