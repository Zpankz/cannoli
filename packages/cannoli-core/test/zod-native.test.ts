import { createRequire } from "node:module";
import { tool } from "@langchain/core/tools";
import type { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod-v4";
import { convertToOpenAIFunction } from "@langchain/core/utils/function_calling";
import { choiceTool, formTool, noteSelectTool } from "../src/fn_calling";
import { GenericModelConfigSchema, LLMProvider } from "../src/providers";
import { Run } from "../src/run";
import { runCanvas } from "./helpers/run";
import { CannoliNode } from "../src/graph/objects/vertices/CannoliNode";
import { CannoliEdge } from "../src/graph/objects/CannoliEdge";
import { HTTPConfigSchema } from "../src/graph/objects/vertices/nodes/content/HttpNode";

// These assertions discriminate native patched v4 from v3 and pre-fix v4.
describe("native v4 collection admission", () => {
  it.each([false, true])(
    "rejects before child refinements, async=%s",
    async (async) => {
      const child = vi.fn(() => true);
      const schema = z.array(z.string().refine(child)).max(1);
      const result = async
        ? await schema.safeParseAsync(["a", "b", "c"])
        : schema.safeParse(["a", "b", "c"]);
      expect(result.success).toBe(false);
      expect(child).not.toHaveBeenCalled();
      expect(schema.safeParse(["a"]).success).toBe(true);
      expect(child).toHaveBeenCalledTimes(1);
    },
  );
});

describe("native schemas through actual legacy tools", () => {
  it.each([
    {
      make: choiceTool,
      name: "choice",
      key: "choice",
      description: "Choose one of the following options",
    },
    {
      make: noteSelectTool,
      name: "note_select",
      key: "note",
      description: "Select one of the following notes",
    },
  ])(
    "preserves $name metadata, validation and invocation",
    async ({ make, name, key, description }) => {
      const adapted = make(["alpha", "beta"]);
      const wire = convertToOpenAIFunction(adapted);
      expect(wire).toEqual({
        name,
        description,
        parameters: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { [key]: { type: "string", enum: ["alpha", "beta"] } },
          required: [key],
        },
      });
      const execute = vi.spyOn(adapted, "func");
      expect(await adapted.invoke({ [key]: "alpha" })).toBe("alpha");
      expect(await adapted.invoke({ [key]: "beta", extra: "ignored" })).toBe(
        "beta",
      );
      for (const invalid of [{}, { [key]: "other" }, { [key]: 1 }, null]) {
        await expect(adapted.invoke(invalid)).rejects.toThrow(
          "Received tool input did not match expected schema",
        );
      }
      expect(execute).toHaveBeenCalledTimes(2);
      // Direct callback invocation proves native validation independently of the
      // legacy JSON Schema validator (which runs before the callback above).
      await expect(adapted.func({ [key]: "other" })).rejects.toThrow(
        z.ZodError,
      );
    },
  );

  it("keeps flat sanitized form fields and its existing return behavior", async () => {
    const adapted = formTool(["first name", "last-name"]);
    expect(convertToOpenAIFunction(adapted)).toEqual({
      name: "form",
      description: "Generate a value for each field",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          first_name: { type: "string" },
          last_name: { type: "string" },
        },
        required: ["first_name", "last_name"],
      },
    });
    const execute = vi.spyOn(adapted, "func");
    // The existing callback returns the `fields` property, not the object.
    // An unknown `fields` property must still be stripped before that return.
    expect(
      await adapted.invoke({
        first_name: "Ada",
        last_name: "Lovelace",
        fields: "strip me",
      }),
    ).toBeUndefined();
    for (const invalid of [
      {},
      { first_name: "Ada" },
      { first_name: 1, last_name: "Lovelace" },
    ]) {
      await expect(adapted.invoke(invalid)).rejects.toThrow(
        "Received tool input did not match expected schema",
      );
    }
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(adapted.func({ first_name: 1 })).rejects.toThrow(z.ZodError);
    expect(
      await formTool(["fields"]).invoke({ fields: "kept", extra: "ignored" }),
    ).toBe("kept");
    expect(await formTool([]).invoke({ fields: "strip me" })).toBeUndefined();
  });
});

describe("native configuration schemas", () => {
  it("preserves coercion, records, stripping and passthrough", () => {
    expect(
      GenericModelConfigSchema.parse({
        temperature: "0.5",
        enableVision: "true",
        extra: 1,
        functions: [
          {
            name: "choice",
            parameters: {
              type: "object",
              properties: { choice: { enum: ["a", "b"] } },
            },
          },
        ],
      }),
    ).toEqual({
      temperature: 0.5,
      enableVision: true,
      functions: [
        {
          name: "choice",
          parameters: {
            type: "object",
            properties: { choice: { enum: ["a", "b"] } },
          },
        },
      ],
    });
    expect(
      GenericModelConfigSchema.safeParse({
        functions: [{ name: "bad", parameters: [] }],
      }).success,
    ).toBe(false);
    expect(HTTPConfigSchema.parse({ timeout: "100", extra: 1 })).toEqual({
      timeout: 100,
      extra: 1,
    });
  });

  it.each(["0.5", "invalid"])(
    "uses config-edge parsing and the first issue for %s",
    (content) => {
      const box = { x: 0, y: 0, width: 200, height: 100 };
      const run = new Run({
        isMock: true,
        cannoli: {
          nodes: [
            { id: "config", type: "text", text: content, color: "6", ...box },
            { id: "call", type: "text", text: "hello", ...box },
          ],
          edges: [
            {
              id: "edge",
              fromNode: "config",
              fromSide: "right",
              toNode: "call",
              toSide: "left",
              color: "2",
              label: "temperature",
            },
          ],
        },
      });
      const node = run.graph.call;
      const edge = run.graph.edge;
      expect(node).toBeInstanceOf(CannoliNode);
      expect(edge).toBeInstanceOf(CannoliEdge);
      if (!(node instanceof CannoliNode) || !(edge instanceof CannoliEdge))
        throw new Error("fixture did not compile");
      edge.content = content;
      const error = vi.spyOn(node, "error").mockImplementation(() => {});
      const config = node.getConfig(GenericModelConfigSchema);
      if (content === "0.5") {
        expect(config.temperature).toBe(0.5);
        expect(error).not.toHaveBeenCalled();
      } else {
        const result = GenericModelConfigSchema.safeParse({
          temperature: content,
        });
        if (result.success) throw new Error("expected invalid config");
        expect(error).toHaveBeenCalledExactlyOnceWith(
          `Error setting config: ${result.error.issues[0].message}`,
        );
      }
    },
  );
});

describe("native parsing of model function outputs", () => {
  it.each([
    {
      name: "choice",
      args: { choice: "alpha" },
      color: "3",
      label: "alpha",
      expected: "alpha",
    },
    {
      name: "form",
      args: { first_name: "Ada" },
      color: "6",
      label: "first name",
      expected: "Ada",
    },
    {
      name: "note_select",
      args: { note: "Alpha" },
      color: undefined,
      label: undefined,
      expected: "[[Alpha]]",
    },
  ])(
    "loads $name output and rejects invalid argument types",
    async ({ name, args, color, label, expected }) => {
      const box = { x: 0, y: 0, width: 200, height: 100 };
      const canvas = {
        nodes: [
          { id: "call", type: "text", text: "Answer", ...box },
          { id: "out", type: "text", text: "", color: "6", ...box },
        ],
        edges: [
          {
            id: "edge",
            fromNode: "call",
            fromSide: "right",
            toNode: "out",
            toSide: "left",
            color,
            label,
          },
        ],
      };
      for (const valid of [true, false]) {
        const invoke = vi.fn().mockResolvedValue({
          role: "assistant",
          content: "",
          function_call: {
            name,
            args: valid
              ? args
              : Object.fromEntries(Object.keys(args).map((key) => [key, 42])),
          },
        });
        const { run, finished, stoppages } = await runCanvas(canvas, {
          isMock: false,
          runArgs: {
            llmConfigs: [
              {
                provider: "ollama",
                model: "mock-model",
                baseURL: "http://127.0.0.1:9",
              },
            ],
          },
          beforeStart(run) {
            vi.spyOn(run, "callLLM").mockImplementation(invoke);
          },
        });
        expect(finished).toBe(true);
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(stoppages.map((s) => s.reason)).toEqual([
          valid ? "complete" : "error",
        ]);
        expect(run.graph.out.text).toBe(valid ? expected : "");
      }
    },
  );
});

// Downstream callers can bind their own v3 tools to the public legacy client.
// Resolve the same v3 peer as LangChain instead of passing a native-v4 schema.
it("preserves legacy Zod tool declarations on the public Gemini client", () => {
  const require = createRequire(import.meta.url);
  const legacyRequire = createRequire(require.resolve("@langchain/core/tools"));
  const { z: legacyZod } = legacyRequire("zod") as typeof import("zod");
  const legacyTool = tool(({ choice }) => choice, {
    name: "legacy_choice",
    description: "Pick a legacy option",
    schema: legacyZod.object({ choice: legacyZod.enum(["a", "b"]) }),
  });
  const provider = new LLMProvider({
    configs: [
      { provider: "gemini", apiKey: "offline-test", model: "gemini-1.5-flash" },
    ],
  });
  const client = provider.getChatClient() as ChatGoogleGenerativeAI;
  const bound = client.bindTools([legacyTool]) as unknown as {
    kwargs: Parameters<typeof client.invocationParams>[0];
  };
  expect(client.invocationParams(bound.kwargs).tools).toEqual([
    {
      functionDeclarations: [
        {
          name: "legacy_choice",
          description: "Pick a legacy option",
          parameters: {
            type: "object",
            properties: { choice: { type: "string", enum: ["a", "b"] } },
            required: ["choice"],
          },
        },
      ],
    },
  ]);
});
