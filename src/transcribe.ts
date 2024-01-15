import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { write } from "bun";
import consola from "consola";
import { proofreadTranscription, transcribeAudioFile } from "./ai";
import { extractAudio, splitAudio } from "./ffmpeg";
import { downloadFile, driveClient } from "./gdrive";

/**
 * Supported languages.
 */
export type SupportedLanguages = "en" | "ja";

export const transcribe = async (
	videoFileId: string,
	language: SupportedLanguages = "en",
	proofreadModel: Parameters<typeof proofreadTranscription>[2] = "gemini-pro",
) => {
	consola.info(`Transcribing ${videoFileId}...`);
	const {
		data: { name: fileName, webViewLink, mimeType, parents },
	} = await driveClient.files.get({
		fileId: videoFileId,
		fields: "name,webViewLink,mimeType,parents",
	});
	if (!(fileName && webViewLink && mimeType && parents)) {
		throw new Error("Failed to get file metadata from Google Drive API.");
	}
	if (!mimeType?.startsWith("video/")) {
		throw new Error("Specified file is not a video.");
	}
	consola.info(`File: ${fileName} (${webViewLink})`);

	const tempDir = await mkdtemp(join(tmpdir(), "interview-transcriber-"));
	const videoFilePath = await downloadFile(
		videoFileId,
		join(tempDir, fileName),
	);
	consola.info(`Downloaded to ${videoFilePath}`);

	const audioFilePath = await extractAudio(videoFilePath);
	consola.info(`Extracted audio to ${audioFilePath}`);

	// split into files with a maximum size of 23 MiB
	// file size limit of Whisper API is 25 MB
	// ref: https://platform.openai.com/docs/guides/speech-to-text
	const audioSegments = await splitAudio(audioFilePath, 23 << 20);
	consola.info(
		`Split audio into ${audioSegments.length} files (total ${
			audioSegments.at(-1)?.endTime
		} seconds)`,
	);

	const segmenter = new Intl.Segmenter(language);

	const transcriptions = await Promise.all(
		audioSegments.map(({ path }) => transcribeAudioFile(path, language)),
	);
	const transcribedText = transcriptions.flat().join("\n");
	const transcriptionFilePath = join(
		tempDir,
		`${basename(videoFilePath, extname(videoFilePath))}_transcription.txt`,
	);
	await write(transcriptionFilePath, transcribedText);
	consola.info(
		`Transcribed audio to ${transcriptionFilePath} (${
			[...segmenter.segment(transcribedText)].length
		} characters)`,
	);

	const proofreadText = await proofreadTranscription(
		transcribedText,
		language,
		proofreadModel,
	);
	const proofreadFilePath = join(
		tempDir,
		`${basename(videoFilePath, extname(videoFilePath))}_proofread.txt`,
	);
	await write(proofreadFilePath, proofreadText);
	consola.info(
		`Proofread transcription to ${proofreadFilePath} (${
			[...segmenter.segment(proofreadText)].length
		} characters)`,
	);
};
