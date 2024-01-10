import { createReadStream } from "node:fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "bun";
import openAi from "openai";

/**
 * OpenAI API client.
 */
export const openaiClient = new openAi({
	apiKey: env.OPENAI_API_KEY,
});

/**
 * Gemini API client.
 */
export const geminiClient = new GoogleGenerativeAI(env.GEMINI_API_KEY);

/**
 * Transcribe an audio file.
 * @param audioFilePath Path to the audio file
 * @param language Language of the audio file
 * @returns Transcribed text segments
 */
export const transcribeAudioFile = async (
	audioFilePath: string,
	language: "en" | "ja",
): Promise<string[]> => {
	const response = (await openaiClient.audio.transcriptions.create({
		file: createReadStream(audioFilePath),
		model: "whisper-1",
		language,
		prompt:
			language === "en"
				? "Hello. This is an interview, and you transcribe it."
				: "こんにちは。これはインタビューの録音で、文字起こしをします。",
		// biome-ignore lint/style/useNamingConvention: library's naming convention
		response_format: "verbose_json",
	})) as openAi.Audio.Transcriptions.Transcription & {
		segments: {
			text: string;
		}[];
	}; // cast since the library doesn't support verbose_json

	return response.segments.map((segment) => segment.text);
};
