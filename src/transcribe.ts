import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { basename } from "node:path";
import { promisify } from "node:util";
import { file } from "bun";
import consola from "consola";
import { parse } from "csv-parse/sync";
import Ffmpeg from "fluent-ffmpeg";
import { downloadFile, driveClient } from "./gdrive";

/**
 * Extract audio from a video file.
 * @param videoFilePath Path to the video file
 * @returns Path to the extracted audio file
 */
const extractAudio = async (videoFilePath: string) => {
	const audioFilePath = join(
		dirname(videoFilePath),
		`${basename(videoFilePath, extname(videoFilePath))}.mp3`,
	);

	return new Promise<string>((resolve, reject) => {
		Ffmpeg(videoFilePath)
			.noVideo()
			.saveToFile(audioFilePath)
			.on("end", () => {
				resolve(audioFilePath);
			})
			.on("error", reject);
	});
};

/**
 * Split an audio file into multiple files with a maximum size.
 * @param sourcePath Path to the audio file
 * @param maxFileSize Maximum size of each file
 * @returns Paths to the splitted audio files
 */
const splitAudio = async (
	sourcePath: string,
	maxFileSize: number,
): Promise<string[]> =>
	promisify<string, Ffmpeg.FfprobeData>(Ffmpeg.ffprobe)(sourcePath)
		.then(({ format: { duration, size } }) => {
			if (!(duration && size)) {
				throw new Error("Failed to get file metadata from ffprobe.");
			}

			const dir = dirname(sourcePath);
			const name = basename(sourcePath, extname(sourcePath));
			const audioFilePath = join(dir, `${name}%03d${extname(sourcePath)}`);
			const listFilePath = join(dir, `${name}.csv`);

			return new Promise<string>((resolve, reject) => {
				Ffmpeg(sourcePath)
					.outputOptions([
						"-f segment",
						`-segment_time ${Math.floor((duration * maxFileSize) / size)}`,
						`-segment_list ${listFilePath}`,
					])
					.saveToFile(audioFilePath)
					.on("end", () => {
						resolve(listFilePath);
					})
					.on("error", reject);
			});
		})
		.then(async (listFilePath) => {
			const csv = await file(listFilePath).text();
			return (parse(csv) as string[][])
				.map((row) => row[0])
				.filter((path): path is string => !!path)
				.map((path) => join(dirname(listFilePath), path));
		});

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
};
