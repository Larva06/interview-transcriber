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
