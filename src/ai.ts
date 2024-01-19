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
 * AI models.
 */
export const models = {
	gpt4: {
		name: "GPT-4 Turbo",
		modelName: "gpt-4-1106-preview",
		// ref: https://platform.openai.com/docs/models/gpt-4-and-gpt-4-turbo
		maxOutputTokens: 4096,
	},
	gemini: {
		name: "Gemini Pro",
		modelName: "gemini-pro",
		// ref: https://ai.google.dev/models/gemini
		maxOutputTokens: 2048,
	},
} as const;

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
export const proofreadTranscription = async <M extends keyof typeof models>(
	transcription: string,
	language: SupportedLanguages,
	model: M,
): Promise<{
	model: (typeof models)[M]["modelName"];
	prompt: string;
	response: string;
}> => {
	const systemPrompt = `You are a web media proofreader.
The text ${model === "gpt4" ? "entered by the user" : "below"} is a transcription of the interview.
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

	const modelName = models[model].modelName;

	let result = "";
	if (model === "gpt4") {
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
			model: modelName,
		});
		result = response.choices[0]?.message.content ?? "";
	} else {
		const response = await geminiClient
			.getGenerativeModel({
				model: modelName,
			})
			.generateContent(`${systemPrompt}\n\n---\n\n${transcription}`);
		result = response.response.text();
	}
	if (!result) {
		throw new Error("The response is empty.");
	}

	return {
		model: modelName,
		prompt: systemPrompt,
		response: result,
	};
};
