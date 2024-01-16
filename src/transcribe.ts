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
import { extractAudio, splitAudio } from "./ffmpeg";
import { downloadFile, getFileMetadata, uploadFile } from "./gdrive";

/**
 * Supported languages.
 */
export type SupportedLanguages = "en" | "ja";

/**
 * Transcribe a video file.
 * @param videoFileId Google Drive file ID of the video file.
 * @param language Language of the video file.
 * @param proofreadModel AI model to use for proofreading.
 * @returns Google Drive file metadata of the uploaded files (audio, transcription, proofread transcription).
 */
export const transcribe = async (
	videoFileId: string,
	language: SupportedLanguages = "en",
	proofreadModel: Parameters<typeof proofreadTranscription>[2] = "gemini-pro",
) => {
	consola.info(`Transcribing ${videoFileId}...`);
	const videoFile = await getFileMetadata(videoFileId, [
		"name",
		"webViewLink",
		"mimeType",
		"parents",
	]);
	if (!videoFile.mimeType.startsWith("video/")) {
		throw new Error("Specified file is not a video.");
	}
	const videoBasename = basename(videoFile.name, extname(videoFile.name));
	consola.info(`File: ${videoFile.name} (${videoFile.webViewLink})`);
	const parentFolderId = videoFile.parents[0];

	const tempDir = await mkdtemp(join(tmpdir(), "interview-transcriber-"));

	try {
		const videoFilePath = await downloadFile(
			videoFileId,
			// use random string to avoid non-ASCII characters in the file name which causes an error in whisper
			join(tempDir, uniqueString() + extname(videoFile.name)),
		);
		consola.info(`Downloaded to ${videoFilePath}`);

		const results: ReturnType<typeof uploadFile>[] = [];
		if (parentFolderId) {
			results.push(
				getFileMetadata(parentFolderId, ["name", "webViewLink"]).then(
					(data) => {
						consola.info(`Parent folder: ${data.name} (${data.webViewLink})`);
						return data;
					},
				),
			);
		}

		const audioFilePath = await extractAudio(videoFilePath);
		consola.info(`Extracted audio to ${audioFilePath}`);
		results.push(
			uploadFile(audioFilePath, videoBasename, parentFolderId).then((data) => {
				consola.info(`Uploaded audio to ${data.webViewLink}`);
				return data;
			}),
		);

		const audioSegments = await splitAudio(
			audioFilePath,
			whisperMaxFileSize * 0.95,
		);
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
		results.push(
			uploadFile(
				transcriptionFilePath,
				videoBasename,
				parentFolderId,
				"application/vnd.google-apps.document",
			).then((data) => {
				consola.info(`Uploaded transcription to ${data.webViewLink}`);
				return data;
			}),
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
		await write(
			proofreadFilePath,
			`model: ${proofreadText.model}\nprompt:\n${proofreadText.prompt}\n\n---\n\n${proofreadText.response}`,
		);
		consola.info(
			`Proofread transcription to ${proofreadFilePath} (${
				[...segmenter.segment(proofreadText.response)].length
			} characters)`,
		);
		results.push(
			uploadFile(
				proofreadFilePath,
				videoBasename,
				parentFolderId,
				"application/vnd.google-apps.document",
			).then((data) => {
				consola.info(`Uploaded proofread transcription to ${data.webViewLink}`);
				return data;
			}),
		);

		const [parentFolder, audioFile, transcriptionFile, proofreadFile] =
			await Promise.all(results);
		if (!(audioFile && transcriptionFile && proofreadFile)) {
			// parentFolder is undefined if the video file is not in a folder
			throw new Error("Failed to upload files.");
		}
		return {
			video: videoFile,
			parent: parentFolder,
			audio: audioFile,
			transcription: transcriptionFile,
			proofreadTranscription: proofreadFile,
		};
	} finally {
		await rmdir(tempDir, { recursive: true });
	}
};
