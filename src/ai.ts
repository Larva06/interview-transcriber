import { createReadStream } from "node:fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "bun";
import consola from "consola";
import openAi from "openai";
import { encoding_for_model } from "tiktoken";
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
	gpt4turbo: {
		name: "GPT-4 Turbo",
		api: "openai",
		modelName: "gpt-4-1106-preview",
		// ref: https://platform.openai.com/docs/models/gpt-4-and-gpt-4-turbo
		maxOutputTokens: 4096,
	},
	gpt4: {
		name: "GPT-4",
		api: "openai",
		modelName: "gpt-4",
		// ref: https://platform.openai.com/docs/models/gpt-4-and-gpt-4-turbo
		maxOutputTokens: 4096,
	},
	gemini: {
		name: "Gemini Pro",
		api: "gemini",
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
 * Count the number of tokens in a text.
 * @param text Text to count tokens
 * @param model AI model to use
 * @returns Number of tokens
 */
const countTokens = async (
	text: string,
	model: keyof typeof models,
): Promise<number> => {
	const modelData = models[model];
	if (modelData.api === "openai") {
		const encoding = encoding_for_model(modelData.modelName);
		return encoding.encode(text).length;
	}

	const response = await geminiClient
		.getGenerativeModel({ model: modelData.modelName })
		.countTokens(text);
	return response.totalTokens;
};

/**
 * Split a transcription into segments with the tokens less than the maximum.
 * @param transcription Transcription to split
 * @param language Language of the transcription
 * @param model AI model to use
 * @returns Split transcription
 */
const splitTranscription = async (
	transcription: string,
	language: SupportedLanguages,
	model: keyof typeof models,
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the complexity is caused by the algorithm
): Promise<string[]> => {
	// only use some of the max output tokens since the model ignores the prompt if the input is long
	const maxInputTokensRatio = 0.4;

	const segmenter = new Intl.Segmenter(language, {
		// use grapheme segmentation for Japanese since tokenizers often tokenize 1 character as nearly 1 token
		granularity: language === "en" ? "word" : "grapheme",
	});

	// split the transcription into segments with the almost same length
	const transcriptionTokens = await countTokens(transcription, model);
	const expectedSegments = Math.ceil(
		transcriptionTokens / (models[model].maxOutputTokens * maxInputTokensRatio),
	);
	const segmentLength =
		[...segmenter.segment(transcription)].length / expectedSegments;

	const segments = transcription
		.split(/\n+/)
		.filter((line) => line.trim())
		.reduce<{ text: string; length: number }[][]>(
			(segments, line) => {
				// biome-ignore lint/style/noNonNullAssertion: initialized with an array of an empty array
				const lastSegment = segments.at(-1)!;
				const lastSegmentLength = lastSegment.reduce(
					(sum, { length }) => sum + length,
					0,
				);
				const length = [...segmenter.segment(line)].length;

				const segment = {
					text: line,
					length,
				};
				if (lastSegmentLength + length < segmentLength) {
					lastSegment.push(segment);
				} else {
					segments.push([segment]);
				}
				return segments;
			},
			[[]],
		);

	for (let i = 0; ; i++) {
		const segment = segments[i];
		// check here since the length of the array may change in the loop
		if (!segment) {
			break;
		}

		while (
			// tolerate 5% more tokens than the ideal max tokens
			(await countTokens(segment.map(({ text }) => text).join("\n"), model)) >
			models[model].maxOutputTokens * (maxInputTokensRatio + 0.05)
		) {
			// tolerate if the single line is too long
			// TODO: split the line into multiple lines
			if (segment.length === 1) {
				consola.warn(`Too long line: ${segment[0]?.text}`);
				break;
			}

			const lastLine = segment.pop();
			// unexpected but check just in case
			if (!lastLine) {
				break;
			}
			const nextSegment = segments[i + 1];
			if (nextSegment) {
				nextSegment.unshift(lastLine);
			} else {
				segments.push([lastLine]);
			}
		}
	}

	return segments.map((segment) => segment.map(({ text }) => text).join("\n"));
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
	const modelData = models[model];

	const systemPrompt = `Task: Proofread an interview transcript ${
		modelData.api === "openai" ? "entered by the user" : "below"
	} for a web media publication.
Proofreading guide:
- Shorten sentences for improved readability.
- Remove redundancy and repetition.
- Eliminate filler words and unnecessary pauses.
- Correct grammatical errors.
- Replace unnatural or difficult language with more precise alternatives.
- Never omit any essential information from the interview.
Output format: Interview style by prefixing each paragraph with "${
		language === "en" ? "interviewer" : "インタビュアー"
	}:" or "${language === "en" ? "interviewee" : "インタビュイー"}:".
Language: ${language === "en" ? "English" : "Japanese"}.`;

	const segments = await splitTranscription(transcription, language, model);
	consola.info(`Split transcription into ${segments.length} segments`);

	let results: string[] = [];
	if (modelData.api === "openai") {
		const responses = await Promise.all(
			segments.map((segment) =>
				openaiClient.chat.completions.create({
					messages: [
						{
							role: "system",
							content: systemPrompt,
						},
						{
							role: "user",
							content: segment,
						},
					],
					model: modelData.modelName,
				}),
			),
		);
		results = responses.map(({ choices }) => choices[0]?.message.content ?? "");
	} else {
		const responses = await Promise.all(
			segments.map((segment) =>
				geminiClient
					.getGenerativeModel({
						model: modelData.modelName,
					})
					.generateContent(`${systemPrompt}\n\n---\n\n${segment}`),
			),
		);
		results = responses.map(({ response }) => response.text());
	}
	if (results.some((result) => !result)) {
		throw new Error("The response is empty.");
	}

	return {
		model: modelData.modelName,
		prompt: systemPrompt,
		response: results.join("\n\n"),
	};
};
