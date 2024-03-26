import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { write } from "bun";
import consola from "consola";
import uniqueString from "unique-string";
import {
	proofreadTranscription,
	transcribeAudioFile,
	whisperMaxFileSize,
} from "./ai";
import { extractAudio, removeSilence, splitAudio } from "./ffmpeg";
import { downloadFile, getFileMetadata, uploadFile } from "./gdrive";

/**
 * Supported languages.
 */
export type SupportedLanguages = "en" | "ja";

/**
 * Transcribe a video or an audio file.
 * @param sourceFileId Google Drive file ID of the source file.
 * @param language Language of the source file.
 * @param proofreadModel AI model to use for proofreading.
 * @returns Google Drive file metadata of the uploaded files (audio, transcription, proofread transcription).
 */
export const transcribe = async (
	sourceFileId: string,
	language: SupportedLanguages = "en",
	proofreadModel: Parameters<typeof proofreadTranscription>[2] = "gemini",
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
		let audioFile: ReturnType<typeof uploadFile> | undefined = undefined;
		if (fileType === "audio") {
			audioFilePath = sourceFilePath;
		} else {
			consola.start("Extracting audio...");
			audioFilePath = await extractAudio(sourceFilePath);
			consola.success(`Extracted audio to ${audioFilePath}`);
			audioFile = uploadFile(
				audioFilePath,
				`${sourceBasename}_${language === "en" ? "audio" : "音声"}`,
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
			whisperMaxFileSize * 0.95,
		);
		consola.success(
			`Split audio into ${audioSegments.length} files (total ${
				audioSegments.at(-1)?.endTime
			} seconds)`,
		);

		const segmenter = new Intl.Segmenter(language);

		consola.start("Transcribing audio...");
		const transcriptions = await Promise.all(
			audioSegments.map(({ path }) => transcribeAudioFile(path, language)),
		);
		const transcribedText = transcriptions.flat().join("\n");
		const transcriptionFilePath = join(
			tempDir,
			`${basename(sourceFilePath, extname(sourceFilePath))}_transcription.txt`,
		);
		await write(transcriptionFilePath, transcribedText);
		consola.success(
			`Transcribed audio to ${transcriptionFilePath} (${
				[...segmenter.segment(transcribedText)].length
			} characters)`,
		);
		const transcriptionFile = uploadFile(
			transcriptionFilePath,
			`${sourceBasename}_${language === "en" ? "transcription" : "文字起こし"}`,
			parentFolderId,
			"application/vnd.google-apps.document",
		).then((data) => {
			consola.success(`Uploaded transcription to ${data.webViewLink}`);
			return data;
		});

		consola.start("Proofreading transcription...");
		const proofreadText = await proofreadTranscription(
			transcribedText,
			language,
			proofreadModel,
		);
		const proofreadFilePath = join(
			tempDir,
			`${basename(sourceFilePath, extname(sourceFilePath))}_proofread.txt`,
		);
		await write(
			proofreadFilePath,
			`model: ${proofreadText.model}\nprompt:\n${proofreadText.prompt}\n\n---\n\n${proofreadText.response}`,
		);
		consola.success(
			`Proofread transcription to ${proofreadFilePath} (${
				[...segmenter.segment(proofreadText.response)].length
			} characters)`,
		);
		const proofreadFile = uploadFile(
			proofreadFilePath,
			`${sourceBasename}_${language === "en" ? "proofread" : "校正"}`,
			parentFolderId,
			"application/vnd.google-apps.document",
		).then((data) => {
			consola.success(
				`Uploaded proofread transcription to ${data.webViewLink}`,
			);
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
			proofreadTranscription: await proofreadFile,
		};
	} finally {
		await rmdir(tempDir, { recursive: true });
	}
};
