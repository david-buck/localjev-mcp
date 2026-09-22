import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, evaluationInput, listModels } from "../src/typesafe.js";

test("evaluationInput accepts the documented request shape and rejects malformed input", () => {
  const valid = {
    state: { ticket: "Payouts have failed for three days." },
    model: "jev-latest",
    questions: {
      urgent: {
        type: "noul",
        instructions: "Does `ticket` convey urgency?",
        criteria: { true: "Explicitly time-sensitive", false: "No urgency" },
      },
      team: {
        type: "choice",
        instructions: "Which team should handle `ticket`?",
        criteria: { billing: "Payouts and payments", technical: "Product defect" },
      },
      frustration: {
        type: "score",
        instructions: "How frustrated is the customer?",
        criteria: ["Calm", "Frustrated", "Very angry"],
      },
    },
  };

  assert.deepEqual(evaluationInput.parse(valid), valid);
  assert.equal(evaluationInput.safeParse({ ...valid, state: 42 }).success, false);
  assert.equal(evaluationInput.safeParse({ ...valid, questions: { bad: "not a question" } }).success, false);
});

test("evaluate sends the documented authenticated request and returns the response", async (t) => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  const originalUrl = process.env.TYPESAFE_API_URL;
  const originalFetch = globalThis.fetch;
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.TYPESAFE_API_URL = "https://typesafe.test/v1/systemone";
  t.after(() => {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.TYPESAFE_API_URL;
    else process.env.TYPESAFE_API_URL = originalUrl;
    globalThis.fetch = originalFetch;
  });

  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { relevant: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200 });
  };

  const response = await evaluate({
    state: "hello",
    questions: { relevant: { type: "noul", instructions: "Is this a greeting?" } },
  });

  assert.equal(request.url, "https://typesafe.test/v1/systemone");
  assert.equal(request.init.headers.Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(request.init.body), {
    state: "hello",
    model: "jev-latest",
    questions: { relevant: { type: "noul", instructions: "Is this a greeting?" } },
  });
  assert.equal(response.model, "jev-1.13.0");
});

test("evaluate retries 429 with Retry-After and reuses the total timeout signal", async (t) => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  const originalUrl = process.env.TYPESAFE_API_URL;
  const originalTimeout = process.env.TYPESAFE_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.TYPESAFE_API_URL = "https://typesafe.test/v1/systemone";
  process.env.TYPESAFE_TIMEOUT_MS = "500";
  t.after(() => {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.TYPESAFE_API_URL;
    else process.env.TYPESAFE_API_URL = originalUrl;
    if (originalTimeout === undefined) delete process.env.TYPESAFE_TIMEOUT_MS;
    else process.env.TYPESAFE_TIMEOUT_MS = originalTimeout;
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  let firstSignal;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    firstSignal ??= init.signal;
    assert.equal(init.signal, firstSignal);
    if (calls === 1) return new Response(null, { status: 429, headers: { "Retry-After": "0" } });
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { relevant: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200 });
  };

  const response = await evaluate({
    state: "hello",
    questions: { relevant: { type: "noul", instructions: "Is this a greeting?" } },
  });

  assert.equal(calls, 2);
  assert.equal(response.answers.relevant.noul, 0.9);
});

test("evaluate rejects an invalid successful response envelope", async (t) => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  const originalUrl = process.env.TYPESAFE_API_URL;
  const originalFetch = globalThis.fetch;
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.TYPESAFE_API_URL = "https://typesafe.test/v1/systemone";
  t.after(() => {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.TYPESAFE_API_URL;
    else process.env.TYPESAFE_API_URL = originalUrl;
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 42,
    answers: [],
    usage: { input_tokens: -1, output_tokens: 0 },
  }), { status: 200 });

  await assert.rejects(
    evaluate({ state: "hello", questions: { relevant: { type: "noul", instructions: "Is this a greeting?" } } }),
    { message: "TypeSafe API returned an invalid response envelope." },
  );
});

test("evaluate stops retrying when the total timeout expires during backoff", async (t) => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  const originalUrl = process.env.TYPESAFE_API_URL;
  const originalTimeout = process.env.TYPESAFE_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.TYPESAFE_API_URL = "https://typesafe.test/v1/systemone";
  process.env.TYPESAFE_TIMEOUT_MS = "10";
  t.after(() => {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.TYPESAFE_API_URL;
    else process.env.TYPESAFE_API_URL = originalUrl;
    if (originalTimeout === undefined) delete process.env.TYPESAFE_TIMEOUT_MS;
    else process.env.TYPESAFE_TIMEOUT_MS = originalTimeout;
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 529, headers: { "Retry-After": "1" } });
  };

  await assert.rejects(
    evaluate({ state: "hello", questions: { relevant: { type: "noul", instructions: "Is this a greeting?" } } }),
    { message: "TypeSafe API request timed out." },
  );
  assert.equal(calls, 1);
});

test("evaluate cancels a discarded retry response and rejects incomplete results", async (t) => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  const originalUrl = process.env.TYPESAFE_API_URL;
  const originalFetch = globalThis.fetch;
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.TYPESAFE_API_URL = "https://typesafe.test/v1/systemone";
  t.after(() => {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.TYPESAFE_API_URL;
    else process.env.TYPESAFE_API_URL = originalUrl;
    globalThis.fetch = originalFetch;
  });

  let cancelled = false;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 529,
        headers: new Headers({ "Retry-After": "0" }),
        body: { cancel: async () => { cancelled = true; } },
      };
    }
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200 });
  };

  await assert.rejects(
    evaluate({ state: "hello", questions: { relevant: { type: "noul", instructions: "Is this a greeting?" } } }),
    { message: "TypeSafe API returned an incomplete response envelope." },
  );
  assert.equal(cancelled, true);
});

test("malformed successful JSON never exposes provider response text", async (t) => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  const originalUrl = process.env.TYPESAFE_API_URL;
  const originalModelsUrl = process.env.TYPESAFE_MODELS_URL;
  const originalFetch = globalThis.fetch;
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.TYPESAFE_API_URL = "https://typesafe.test/v1/systemone";
  process.env.TYPESAFE_MODELS_URL = "https://typesafe.test/v1/models";
  t.after(() => {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.TYPESAFE_API_URL;
    else process.env.TYPESAFE_API_URL = originalUrl;
    if (originalModelsUrl === undefined) delete process.env.TYPESAFE_MODELS_URL;
    else process.env.TYPESAFE_MODELS_URL = originalModelsUrl;
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response("PRIVATE_PROVIDER_BODY not json", { status: 200 });

  await assert.rejects(
    evaluate({ state: "hello", questions: { relevant: { type: "noul", instructions: "Is this a greeting?" } } }),
    { message: "TypeSafe API returned invalid JSON." },
  );
  await assert.rejects(listModels(), { message: "TypeSafe models API returned invalid JSON." });
});

test("a timeout while reading a successful response remains a timeout", async (t) => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  const originalUrl = process.env.TYPESAFE_API_URL;
  const originalTimeout = process.env.TYPESAFE_TIMEOUT_MS;
  const originalFetch = globalThis.fetch;
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.TYPESAFE_API_URL = "https://typesafe.test/v1/systemone";
  process.env.TYPESAFE_TIMEOUT_MS = "10";
  t.after(() => {
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.TYPESAFE_API_URL;
    else process.env.TYPESAFE_API_URL = originalUrl;
    if (originalTimeout === undefined) delete process.env.TYPESAFE_TIMEOUT_MS;
    else process.env.TYPESAFE_TIMEOUT_MS = originalTimeout;
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => new Promise((_, reject) => setTimeout(() => reject(new DOMException("aborted", "AbortError")), 20)),
  });

  await assert.rejects(
    evaluate({ state: "hello", questions: { relevant: { type: "noul", instructions: "Is this a greeting?" } } }),
    { message: "TypeSafe API request timed out." },
  );
});
