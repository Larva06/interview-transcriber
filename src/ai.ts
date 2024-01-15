import { createReadStream } from "node:fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "bun";
import openAi from "openai";
import { SupportedLanguages } from "./transcribe";

/**
 * OpenAI API client.
 */
export const openaiClient = new openAi({
	apiKey: env.OPENAI_API_KEY,
});

/**
 * Maximum file size for Whisper API.
 * @see https://platform.openai.com/docs/api-reference/speech-to-text
 */
export const whisperMaxFileSize = 25 * 1000 * 1000;

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
	language: SupportedLanguages,
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

/**
 * Proofread a transcription.
 * @param transcription Transcription to proofread
 * @param language Language of the transcription
 * @param model AI model to use
 * @param prompt System prompt to use
 * @returns Proofread transcription
 */
export const proofreadTranscription = async <M extends "gpt-4" | "gemini-pro">(
	transcription: string,
	language: SupportedLanguages,
	model: M,
): Promise<{ model: M; prompt: string; response: string }> => {
	const systemPrompt = `You are a web media proofreader.
The text ${model === "gpt-4" ? "entered by the user" : "below"} is a transcription of the interview.
Follow the guide below and improve it.
- Remove redundant or repeating expressions.
- Remove fillers.
- Correct grammar errors.
- Replace unnatural or difficult wordings.
- Shorten sentences.
The output style should be the style of an interview, like \`interviewer: \` or \`interviewee\`.
${
	language === "en"
		? "The response must not include markdown syntax."
		: "The response must be in Japanese without markdown syntax."
}`;

	let result = "";
	if (model === "gpt-4") {
		const response = await openaiClient.chat.completions.create({
			messages: [
				{
					role: "system",
					content: systemPrompt,
				},
				{
					role: "user",
					content: transcription,
				},
			],
			model,
		});
		result = response.choices[0]?.message.content ?? "";
	} else {
		const response = await geminiClient
			.getGenerativeModel({
				model,
			})
			.generateContent(`${systemPrompt}\n\n---\n\n${transcription}`);
		result = response.response.text();
	}
	if (!result) {
		throw new Error("The response from OpenAI API is empty.");
	}

	return {
		model,
		prompt: systemPrompt,
		response: result,
	};
};
