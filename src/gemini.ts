import {
	GoogleGenerativeAI,
	HarmBlockThreshold,
	HarmCategory,
} from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/files";
import { env } from "bun";
import mime from "mime";

/**
 * Maximum duration of each audio segment in seconds that can be transcribed precisely.
 */
export const maxAudioFileDuration = 20 * 60;

/**
 * Genders of speakers.
 */
export const genders = ["男", "女"] as const;

export const geminiClient = new GoogleGenerativeAI(env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(env.GEMINI_API_KEY);

/**
 * Transcribe an audio file.
 * @param audioFilePath Path to the audio file
 * @param speakers List of speakers with their roles, names, and genders
 * @returns Transcribed text
 */
export const transcribeAudioFile = async (
	audioFilePath: string,
	speakers: {
		role: string;
		name: string;
		gender: (typeof genders)[number];
	}[],
): Promise<string> => {
	const audioFileMimeType = mime.getType(audioFilePath);
	if (!audioFileMimeType?.startsWith("audio/")) {
		throw new Error("The file is not an audio file");
	}

	const audioDrive = await fileManager
		.uploadFile(audioFilePath, {
			mimeType: audioFileMimeType,
		})
		.then((response) => response.file);

	const result = await geminiClient
		.getGenerativeModel({
			model: "gemini-1.5-pro-latest",
		})
		.generateContent({
			contents: [
				{
					role: "user",
					parts: [
						{
							fileData: {
								mimeType: audioDrive.mimeType,
								fileUri: audioDrive.uri,
							},
						},
						{
							text: `インタビューの録音をインタビュー記事として文字起こししてください。
不要な繰り返しやフィラーは削除してください。
ただし、インタビュー内の情報は削除しないでください。

話者は以下の通りです。
${speakers
	.map(({ role, name, gender }) => `${role}(${gender}): ${name}`)
	.join("\n")}`,
						},
					],
				},
			],
			generationConfig: {
				// reduce randomness
				temperature: 0,
				responseMimeType: "text/plain",
			},
			// disable all safety settings
			safetySettings: Object.values(HarmCategory)
				.filter(
					(category) => category !== HarmCategory.HARM_CATEGORY_UNSPECIFIED,
				)
				.map((category) => ({
					category,
					threshold: HarmBlockThreshold.BLOCK_NONE,
				})),
		});

	return result.response.text();
};
