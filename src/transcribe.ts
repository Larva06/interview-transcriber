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
 * Transcribe a video file.
 * @param videoFileId Google Drive file ID of the video file.
 * @param language Language of the video file.
 * @param proofreadModel AI model to use for proofreading.
 * @returns Google Drive file metadata of the uploaded files (audio, transcription, proofread transcription).
 */
export const transcribe = async (
	videoFileId: string,
	language: SupportedLanguages = "en",
	proofreadModel: Parameters<typeof proofreadTranscription>[2] = "gemini",
) => {
	consola.start(`Transcribing ${videoFileId}...`);
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
		consola.start("Downloading video file...");
		const videoFilePath = await downloadFile(
			videoFileId,
			// use random string to avoid non-ASCII characters in the file name which causes an error in whisper
			join(tempDir, uniqueString() + extname(videoFile.name)),
		);
		consola.success(`Downloaded to ${videoFilePath}`);

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

		consola.start("Extracting audio...");
		const audioFilePath = await extractAudio(videoFilePath);
		consola.success(`Extracted audio to ${audioFilePath}`);
		results.push(
			uploadFile(
				audioFilePath,
				`${videoBasename}_${language === "en" ? "audio" : "音声"}`,
				parentFolderId,
			).then((data) => {
				consola.success(`Uploaded audio to ${data.webViewLink}`);
				return data;
			}),
		);

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
			`${basename(videoFilePath, extname(videoFilePath))}_transcription.txt`,
		);
		await write(transcriptionFilePath, transcribedText);
		consola.success(
			`Transcribed audio to ${transcriptionFilePath} (${
				[...segmenter.segment(transcribedText)].length
			} characters)`,
		);
		results.push(
			uploadFile(
				transcriptionFilePath,
				`${videoBasename}_${
					language === "en" ? "transcription" : "文字起こし"
				}`,
				parentFolderId,
				"application/vnd.google-apps.document",
			).then((data) => {
				consola.success(`Uploaded transcription to ${data.webViewLink}`);
				return data;
			}),
		);

		consola.start("Proofreading transcription...");
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
		consola.success(
			`Proofread transcription to ${proofreadFilePath} (${
				[...segmenter.segment(proofreadText.response)].length
			} characters)`,
		);
		results.push(
			uploadFile(
				proofreadFilePath,
				`${videoBasename}_${language === "en" ? "proofread" : "校正"}`,
				parentFolderId,
				"application/vnd.google-apps.document",
			).then((data) => {
				consola.success(
					`Uploaded proofread transcription to ${data.webViewLink}`,
				);
				return data;
			}),
		);

		const [parentFolder, audioFile, transcriptionFile, proofreadFile] =
			await Promise.all(results);
		if (!(audioFile && transcriptionFile && proofreadFile)) {
			// parentFolder is undefined if the video file is not in a folder
			throw new Error("Failed to upload files.");
		}
		consola.success(`Transcribed ${videoFileId}.`);
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
