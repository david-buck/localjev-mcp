import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const API_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 15_000;

export const jsonValue = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValue),
  z.record(jsonValue),
]));

// TypeSafe accepts a string, object, or array as state and instructions.
export const structuredValue = z.union([
  z.string(),
  z.array(jsonValue),
  z.record(jsonValue),
]);

const description = structuredValue;
export const choiceCriteria = z.record(z.string().min(1), z.union([description, z.null()]))
  .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 255, "Choice criteria must contain 1 to 255 options.");

export const noulQuestion = z.object({
  type: z.literal("noul"),
  instructions: structuredValue,
  criteria: z.object({
    true: description.optional(),
    false: description.optional(),
  }).strict().optional(),
}).strict();

export const choiceQuestion = z.object({
  type: z.literal("choice"),
  instructions: structuredValue,
  criteria: choiceCriteria,
}).strict();

export const scoreQuestion = z.object({
  type: z.literal("score"),
  instructions: structuredValue,
  criteria: z.array(description).min(2).max(10),
}).strict();

export const question = z.discriminatedUnion("type", [noulQuestion, choiceQuestion, scoreQuestion]);
export const questions = z.record(z.string().min(1), question)
  .refine((value) => Object.keys(value).length > 0, "At least one question is required.");
export const model = z.string().min(1).default(DEFAULT_MODEL);
export const evaluationInput = z.object({
  state: structuredValue,
  questions,
  model,
});

function parseTimeout(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

async function readApiKey() {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();

  const keyPath = process.env.TYPESAFE_KEY_FILE || join(homedir(), ".config", "typesafe", "key");
  try {
    const key = (await readFile(keyPath, "utf8")).trim();
    if (key) return key;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error("Could not read the configured TypeSafe key file.");
    }
  }

  throw new Error(
    "No TypeSafe API key is available. Set TYPESAFE_API_KEY for this server or create ~/.config/typesafe/key with mode 600.",
  );
}

export async function evaluate({ state, questions: questionMap, model: modelId = DEFAULT_MODEL }) {
  const apiKey = await readApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), parseTimeout(process.env.TYPESAFE_TIMEOUT_MS));

  try {
    const response = await fetch(process.env.TYPESAFE_API_URL || API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, model: modelId, questions: questionMap }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Do not reflect response bodies: provider errors can include submitted data.
      throw new Error(`TypeSafe API request failed (HTTP ${response.status}).`);
    }

    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("TypeSafe API request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
