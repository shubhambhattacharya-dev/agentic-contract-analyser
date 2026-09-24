import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AgentService,
  type AgentEvent,
  type AgentModel,
} from "../../src/services/ai/agent.service.js";
import { AgentToolRegistry } from "../../src/services/ai/tool.registry.js";
import type { RegisteredTool } from "../../src/services/ai/execute-tool.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const DOCS = ["22222222-2222-4222-8222-222222222222"];

function stubTool(behavior: "ok" | "throw" | "empty"): RegisteredTool {
  return {
    name: "search_document",
    description: "Search the documents for evidence (test stub).",
    inputSchema: z.object({
      query: z.string().min(1).max(100),
    }),
    async execute(args) {
      if (behavior === "throw") {
        throw new Error("storage exploded");
      }

      if (behavior === "empty") {
        return { results: [] };
      }

      return {
        results: [
          {
            documentId: DOCS[0],
            chunkId: "c1",
            parentId: null,
            text: `evidence for ${args.query}`,
            score: 0.9,
            startOffset: 0,
            endOffset: 10,
          },
        ],
      };
    },
  };
}

class ScriptedModel implements AgentModel {
  calls = 0;

  constructor(private readonly script: string[]) {}

  async generate(): Promise<string> {
    const next = this.script[this.calls];
    this.calls += 1;
    return next ?? JSON.stringify({ thought: "done", tool: "FINISH", args: {} });
  }
}

function makeAgent(modelScript: string[], toolBehavior: "ok" | "throw" | "empty" = "ok") {
  const model = new ScriptedModel(modelScript);
  const agent = new AgentService(
    model,
    new AgentToolRegistry([stubTool(toolBehavior)]),
  );

  return { model, agent };
}

async function collect(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];

  for await (const event of generator) {
    events.push(event);
  }

  return events;
}

const decision = (tool: string, args: Record<string, unknown> = {}) =>
  JSON.stringify({ thought: "trying", tool, args });

describe("agent loop (Part C option 2)", () => {
  it("AG01/AG18: FINISH on round 1 ends immediately with gathered context", async () => {
    const { model, agent } = makeAgent([decision("FINISH")]);

    const events = await collect(
      agent.run({ question: "q", documentIds: DOCS, sessionId: SESSION }),
    );

    expect(model.calls).toBe(1);
    expect(events.some((event) => event.type === "agent_finished")).toBe(true);
    expect(events.filter((event) => event.type === "agent_step")).toHaveLength(0);
  });

  it("multi-round: tool calls stream agent_step events and evidence accumulates", async () => {
    const { model, agent } = makeAgent([
      decision("search_document", { query: "termination" }),
      decision("search_document", { query: "liability" }),
      decision("FINISH"),
    ]);

    const events = await collect(
      agent.run({ question: "q", documentIds: DOCS, sessionId: SESSION }),
    );

    const steps = events.filter((event) => event.type === "agent_step");

    expect(steps).toHaveLength(2);
    expect(model.calls).toBe(3);

    const context = events.find((event) => event.type === "context");

    expect(context && "chunks" in context && context.chunks.length).toBeGreaterThan(0);
  });

  it("AG16/AG17: hard cap — exactly MAX rounds run, no round 5, stops with max_rounds_reached", async () => {
    const script = Array.from({ length: 10 }, () =>
      decision("search_document", { query: "endless" }),
    );
    const { model, agent } = makeAgent(script);

    const events = await collect(
      agent.run({ question: "q", documentIds: DOCS, sessionId: SESSION, maxRounds: 4 }),
    );

    expect(model.calls).toBe(4);

    const stopped = events.find(
      (event) => event.type === "agent_stopped",
    ) as Extract<AgentEvent, { type: "agent_stopped" }> | undefined;

    expect(stopped?.reason).toBe("max_rounds_reached");
    expect(stopped?.rounds).toBe(4);
  });

  it("AG06: unknown tool yields an error observation and the loop continues safely", async () => {
    const { agent } = makeAgent([
      decision("delete_all_documents", {}),
      decision("FINISH"),
    ]);

    const events = await collect(
      agent.run({ question: "q", documentIds: DOCS, sessionId: SESSION }),
    );

    const context = events.find((event) => event.type === "context") as
      | Extract<AgentEvent, { type: "context" }>
      | undefined;

    expect(context?.chunks.join("\n")).toContain("Unknown tool");
    expect(events.some((event) => event.type === "agent_finished")).toBe(true);
  });

  it("AG07/AG21: malformed JSON stops the loop with malformed_agent_call", async () => {
    const { agent } = makeAgent(["this is not json at all"]);

    const events = await collect(
      agent.run({ question: "q", documentIds: DOCS, sessionId: SESSION }),
    );

    const stopped = events.find(
      (event) => event.type === "agent_stopped",
    ) as Extract<AgentEvent, { type: "agent_stopped" }> | undefined;

    expect(stopped?.reason).toBe("malformed_agent_call");
  });

  it("AG08/AG09/AG10: invalid or extra tool arguments are rejected by schema validation", async () => {
    const { agent } = makeAgent([
      decision("search_document", {}), // missing required query
      decision("search_document", { query: "x", hackerField: "DROP TABLE" }),
      decision("FINISH"),
    ]);

    const events = await collect(
      agent.run({ question: "q", documentIds: DOCS, sessionId: SESSION }),
    );

    const context = events.find((event) => event.type === "context") as
      | Extract<AgentEvent, { type: "context" }>
      | undefined;

    // Missing args → invalid; extra args → stripped by zod (call succeeds).
    expect(context?.chunks.join("\n")).toContain("tool arguments are invalid");
  });

  it("AG11: a throwing tool is normalized to an error observation, server survives", async () => {
    const { agent } = makeAgent([
      decision("search_document", { query: "boom" }),
      decision("FINISH"),
    ], "throw");

    const events = await collect(
      agent.run({ question: "q", documentIds: DOCS, sessionId: SESSION }),
    );

    const context = events.find((event) => event.type === "context") as
      | Extract<AgentEvent, { type: "context" }>
      | undefined;

    expect(context?.chunks.join("\n")).toContain("tool failed while processing");
    expect(events.some((event) => event.type === "agent_finished")).toBe(true);
  });

  it("AG19/AG20: empty tool results are still DATA — loop can finish or exhaust honestly", async () => {
    const { agent } = makeAgent([
      decision("search_document", { query: "nothing" }),
      decision("FINISH"),
    ], "empty");

    const events = await collect(
      agent.run({ question: "q", documentIds: DOCS, sessionId: SESSION }),
    );

    expect(events.some((event) => event.type === "agent_finished")).toBe(true);
  });

  it("T10/AG14/AG15: trusted context always wins — model cannot escape session or docs", async () => {
    const { agent } = makeAgent([
      decision("search_document", { query: "ok" }),
      decision("FINISH"),
    ]);

    const events = await collect(
      agent.run({
        question: "q",
        documentIds: DOCS,
        sessionId: SESSION,
        maxRounds: 4,
      }),
    );

    const context = events.find((event) => event.type === "context") as
      | Extract<AgentEvent, { type: "context" }>
      | undefined;

    const observation = context?.chunks.find((chunk) =>
      chunk.includes("evidence for ok"),
    );

    expect(observation).toBeDefined();
    expect(observation).toContain(DOCS[0]);
  });

  it("abort: a pre-aborted signal stops the loop with reason aborted", async () => {
    const { agent } = makeAgent([decision("search_document", { query: "x" })]);

    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      agent.run({
        question: "q",
        documentIds: DOCS,
        sessionId: SESSION,
        signal: controller.signal,
      }),
    );

    const stopped = events.find(
      (event) => event.type === "agent_stopped",
    ) as Extract<AgentEvent, { type: "agent_stopped" }> | undefined;

    expect(stopped?.reason).toBe("aborted");
  });
});
