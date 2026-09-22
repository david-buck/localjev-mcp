import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const API_URL = "https://api.typesafe.ai/v1/systemone";
export const MODELS_URL = "https://api.typesafe.ai/v1/models";
export const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 2_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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

const evaluationResponse = z.object({
  model: z.string().min(1),
  answers: z.record(z.unknown()),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

const modelsResponse = z.object({
  models: z.array(z.object({
    name: z.string().min(1),
    description: z.string(),
    release_date: z.string(),
  })),
});

function parseTimeout(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function parseRetryAfter(value) {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_TIMER_DELAY_MS, Math.ceil(seconds * 1_000));
  }

  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.min(MAX_TIMER_DELAY_MS, Math.max(0, date - Date.now()));
}

function retryDelay(response, retryCount) {
  const retryAfter = parseRetryAfter(response.headers?.get?.("retry-after"));
  if (retryAfter !== null) return retryAfter;
  return Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * (2 ** retryCount));
}

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

function waitForRetry(delayMs, signal) {
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };

    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function keyFilePath() {
  return process.env.TYPESAFE_KEY_FILE || join(homedir(), ".config", "typesafe", "key");
}

function resolvedConfiguration(modelId = DEFAULT_MODEL) {
  return {
    endpoint: process.env.TYPESAFE_API_URL || API_URL,
    model: modelId || DEFAULT_MODEL,
    timeoutMs: parseTimeout(process.env.TYPESAFE_TIMEOUT_MS),
  };
}

async function readApiKey() {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();

  const keyPath = keyFilePath();
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

export async function getConfiguration() {
  const configuration = resolvedConfiguration();
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    return {
      ...configuration,
      apiKey: { present: true, source: "environment" },
    };
  }

  try {
    const key = (await readFile(keyFilePath(), "utf8")).trim();
    return {
      ...configuration,
      apiKey: { present: Boolean(key), source: key ? "file" : null },
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      return {
        ...configuration,
        apiKey: { present: false, source: "file" },
      };
    }
    return {
      ...configuration,
      apiKey: { present: false, source: null },
    };
  }
}

export async function listModels() {
  const apiKey = await readApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), parseTimeout(process.env.TYPESAFE_TIMEOUT_MS));

  try {
    const response = await fetch(process.env.TYPESAFE_MODELS_URL || MODELS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`TypeSafe models request failed (HTTP ${response.status}).`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error("TypeSafe models API returned invalid JSON.");
    }
    const parsed = modelsResponse.safeParse(payload);
    if (!parsed.success) throw new Error("TypeSafe models API returned an invalid response envelope.");
    return parsed.data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("TypeSafe models request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function evaluate({ state, questions: questionMap, model: modelId = DEFAULT_MODEL }) {
  const apiKey = await readApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), parseTimeout(process.env.TYPESAFE_TIMEOUT_MS));
  let retryCount = 0;

  try {
    while (true) {
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
        if ([429, 529].includes(response.status) && retryCount < MAX_RETRIES) {
          const delay = retryDelay(response, retryCount);
          retryCount += 1;
          await response.body?.cancel().catch(() => {});
          await waitForRetry(delay, controller.signal);
          continue;
        }

        // Do not reflect response bodies: provider errors can include submitted data.
        throw new Error(`TypeSafe API request failed (HTTP ${response.status}).`);
      }

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        if (error.name === "AbortError") throw error;
        throw new Error("TypeSafe API returned invalid JSON.");
      }
      const parsed = evaluationResponse.safeParse(payload);
      if (!parsed.success) throw new Error("TypeSafe API returned an invalid response envelope.");
      if (!Object.keys(questionMap).every((id) => Object.hasOwn(parsed.data.answers, id))) {
        throw new Error("TypeSafe API returned an incomplete response envelope.");
      }
      return parsed.data;
    }
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("TypeSafe API request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
