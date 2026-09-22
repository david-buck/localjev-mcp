import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { choiceCriteria, choiceQuestion, evaluate, evaluationInput, getConfiguration, listModels, model, noulQuestion, scoreQuestion, structuredValue } from "./typesafe.js";

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function toolError(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

const server = new McpServer({ name: "localjev", version: "0.1.0" });

server.tool(
  "jev_evaluate",
  "Ask one or more typed Jev Choice, Score, or Noul questions about the same state. Use this for independent judgments that share evidence.",
  {
    state: structuredValue.describe("Text, JSON object, or JSON array Jev should evaluate."),
    questions: evaluationInput.shape.questions.describe("Map of TypeSafe Choice, Score, or Noul questions, keyed by a caller-defined id."),
    model: evaluationInput.shape.model,
  },
  async (input) => {
    try {
      return toolResult(await evaluate(input));
    } catch (error) {
      return toolError(error.message);
    }
  },
);

server.tool(
  "jev_classify",
  "Select one defined label for a state and return the full probability distribution.",
  {
    state: structuredValue.describe("Text, JSON object, or JSON array to classify."),
    instructions: choiceQuestion.shape.instructions.describe("The classification question."),
    criteria: choiceCriteria.describe("Every allowed label and its definition. Include an explicit other label when appropriate."),
    model,
  },
  async ({ state, instructions, criteria, model: modelId }) => {
    try {
      return toolResult(await evaluate({
        state,
        model: modelId,
        questions: { result: { type: "choice", instructions, criteria } },
      }));
    } catch (error) {
      return toolError(error.message);
    }
  },
);

server.tool(
  "jev_score",
  "Rate a state against an ordered, descriptive rubric and return its score, level probabilities, and confidence.",
  {
    state: structuredValue.describe("Text, JSON object, or JSON array to score."),
    instructions: scoreQuestion.shape.instructions.describe("The scoring question."),
    criteria: scoreQuestion.shape.criteria.describe("Ordered score-level descriptions, from lowest to highest."),
    model,
  },
  async ({ state, instructions, criteria, model: modelId }) => {
    try {
      return toolResult(await evaluate({
        state,
        model: modelId,
        questions: { result: { type: "score", instructions, criteria } },
      }));
    } catch (error) {
      return toolError(error.message);
    }
  },
);

server.tool(
  "jev_check",
  "Evaluate one yes-or-no proposition about a state and return Jev's Noul probability.",
  {
    state: structuredValue.describe("Text, JSON object, or JSON array to check."),
    instructions: noulQuestion.shape.instructions.describe("The yes-or-no proposition."),
    criteria: noulQuestion.shape.criteria.describe("Optional definitions of yes and no."),
    model,
  },
  async ({ state, instructions, criteria, model: modelId }) => {
    try {
      return toolResult(await evaluate({
        state,
        model: modelId,
        questions: { result: { type: "noul", instructions, ...(criteria ? { criteria } : {}) } },
      }));
    } catch (error) {
      return toolError(error.message);
    }
  },
);

server.tool(
  "jev_models",
  "List the TypeSafe models available to this API key. This requests model metadata and does not evaluate a Jev question.",
  {},
  async () => {
    try {
      return toolResult(await listModels());
    } catch (error) {
      return toolError(error.message);
    }
  },
);

server.tool(
  "jev_doctor",
  "Inspect local Jev configuration without contacting TypeSafe. Reports only whether a key is present and where it comes from, never the key itself.",
  {},
  async () => toolResult(await getConfiguration()),
);

await server.connect(new StdioServerTransport());
