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

type AudioSegment = {
	path: string;
	startTime: number;
	endTime: number;
};

/**
 * Split an audio file into multiple files with a maximum size.
 * @param sourcePath Path to the audio file
 * @param maxFileSize Maximum size of each file
 * @returns Array of audio segments, each of which has a path to the audio file, start time, and end time
 */
export const splitAudio = async (
	sourcePath: string,
	maxFileSize: number,
): Promise<AudioSegment[]> =>
	promisify<string, Ffmpeg.FfprobeData>(Ffmpeg.ffprobe)(sourcePath).then(
		({ format: { duration, size } }) => {
			if (!(duration && size)) {
				throw new Error("Failed to get file metadata from ffprobe.");
			}

			if (size <= maxFileSize) {
				return [
					{
						path: sourcePath,
						startTime: 0,
						endTime: duration,
					},
				];
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
			}).then(async (listFilePath) => {
				const csv = await file(listFilePath).text();
				return (parse(csv) as string[][]).map((row) => {
					if (!(row[0] && row[1] && row[2])) {
						throw new Error("Failed to parse CSV file.");
					}
					return {
						path: join(dirname(listFilePath), row[0]),
						startTime: Number(row[1]),
						endTime: Number(row[2]),
					};
				});
			});
		},
	);
