import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, evaluationInput } from "../src/typesafe.js";

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
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200 });
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
