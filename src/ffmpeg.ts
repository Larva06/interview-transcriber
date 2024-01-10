import { dirname, extname, join } from "node:path";
import { basename } from "node:path";
import { promisify } from "node:util";
import { file } from "bun";
import { parse } from "csv-parse/sync";
import Ffmpeg from "fluent-ffmpeg";

/**
 * Extract audio from a video file.
 * @param videoFilePath Path to the video file
 * @returns Path to the extracted audio file
 */
export const extractAudio = async (videoFilePath: string) => {
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
export const splitAudio = async (
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
