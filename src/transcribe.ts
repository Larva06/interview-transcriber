import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { write } from "bun";
import consola from "consola";
import { transcribeAudioFile } from "./ai";
import { extractAudio, splitAudio } from "./ffmpeg";
import { downloadFile, driveClient } from "./gdrive";

export const transcribe = async (videoFileId: string) => {
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
	const splittedAudioFilePaths = await splitAudio(audioFilePath, 23 << 20);
	consola.info(`Splitted audio into ${splittedAudioFilePaths.length} files`);

	const transcriptions = await Promise.all(
		splittedAudioFilePaths.map((splittedAudioFilePath) =>
			transcribeAudioFile(splittedAudioFilePath, "ja"),
		),
	);
	const text = transcriptions.flat().join("\n");
	await write(
		join(
			tempDir,
			`${basename(videoFilePath, extname(videoFilePath))}_transcription.txt`,
		),
		text,
	);
};
