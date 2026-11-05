import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { Run } from "../src/run";
import { canvasDataSchema } from "../src/persistor";
import * as rng from "../src/util/rng";
import {
  assertCanvasResourceLimits as guard,
  resolveCanvasResourceLimits as resolve,
  CanvasResourceError,
} from "../src/canvasLimits";

const canvas = () => ({ nodes: [], edges: [] });
const admit = (value: unknown, options = {}) => guard(value, resolve(options));

describe("canvas resource admission", () => {
  it("admits the documented default boundaries and rejects the next unit", () => {
    admit({ nodes: new Array(1000), edges: new Array(4000) });
    expect(() => admit({ nodes: new Array(1001) })).toThrow("maxNodes");
    expect(() => admit({ edges: new Array(4001) })).toThrow("maxEdges");
    admit(new Array(100_000));
    expect(() => admit(new Array(100_001))).toThrow("maxEntries");
    let deep: unknown = 0;
    for (let i = 0; i < 64; i++) deep = { x: deep };
    admit(deep);
    expect(() => admit({ x: deep })).toThrow("maxDepth");
    const text = "x".repeat(1024 * 1024);
    admit(text);
    expect(() => admit(text + "x")).toThrow("maxStringBytes");
    admit(new Array(7).fill(text));
    expect(() => admit(new Array(8).fill(text))).toThrow("maxInputBytes");
  });

  it("preserves foreign JSON metadata and malformed-cache omission in Run", () => {
    const run = new Run({
      cannoli: {
        nodes: [
          {
            id: "n",
            type: "text",
            text: "[input]\nhi",
            color: "6",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            foreign: { nested: ["é", { toJSON: "data" }] },
            cannoli: { v: "invalid" },
          },
        ],
        edges: [],
      },
      isMock: true,
    });
    const node = run.canvasData!.nodes[0] as unknown as Record<string, unknown>;
    expect(node.foreign).toEqual({ nested: ["é", { toJSON: "data" }] });
    expect(Object.hasOwn(node, "cannoli")).toBe(false);
  });

  it("bounds entries across containers and repeated aliases", () => {
    const alias = { x: 1 };
    admit({ a: alias, b: alias }, { maxEntries: 4 });
    expect(() => admit({ a: alias, b: alias }, { maxEntries: 3 })).toThrow(
      "maxEntries",
    );
    admit([1, 2], { maxEntries: 2 });
    expect(() => admit(new Array(3), { maxEntries: 2 })).toThrow("maxEntries");
    admit({ a: 1, b: 2 }, { maxEntries: 3 });
  });

  it("bounds depth including scalar leaves", () => {
    admit({ a: { b: 1 } }, { maxDepth: 2 });
    expect(() => admit({ a: { b: 1 } }, { maxDepth: 1 })).toThrow("maxDepth");
  });

  it.each(["nodes", "edges"] as const)(
    "checks %s length before visiting children",
    (key) => {
      const children = new Array(3);
      Object.defineProperty(children, "0", {
        enumerable: true,
        get() {
          throw Error("visited");
        },
      });
      const option = key === "nodes" ? "maxNodes" : "maxEdges";
      admit({ [key]: [null, null] }, { [option]: 2 });
      expect(() => admit({ [key]: children }, { [option]: 2 })).toThrow(option);
    },
  );

  it("counts UTF-8 keys, surrogate pairs and JSON escapes without encoding allocations", () => {
    admit("é😀", { maxStringBytes: 6, maxInputBytes: 8 });
    expect(() => admit("é😀", { maxStringBytes: 5 })).toThrow("maxStringBytes");
    expect(() => admit("é😀", { maxInputBytes: 7 })).toThrow("maxInputBytes");
    admit("\u0000", { maxInputBytes: 8 });
    expect(() => admit("\u0000", { maxInputBytes: 7 })).toThrow(
      "maxInputBytes",
    );
    expect(() => admit({ "😀": 1 }, { maxStringBytes: 3 })).toThrow(
      "maxStringBytes",
    );
    admit("\ud800", { maxStringBytes: 3, maxInputBytes: 8 });
  });

  it("rejects cycles, hooks and executable data without invoking them", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => admit(cyclic)).toThrow(CanvasResourceError);
    const callback = vi.fn(() => {
      throw Error("executed");
    });
    for (const value of [
      {
        get metadata() {
          return callback();
        },
      },
      { toJSON: callback },
      Object.defineProperty({}, "toJSON", { get: callback }),
      { value: callback },
      new Date(),
      { value: 1n },
    ])
      expect(() => admit(value)).toThrow(CanvasResourceError);
    expect(callback).not.toHaveBeenCalled();
  });

  it("checks non-enumerable array slots before JSON can read them", () => {
    const get = vi.fn();
    const array = new Array(1);
    Object.defineProperty(array, "0", { get });
    expect(() => admit(array)).toThrow("jsonData");
    expect(get).not.toHaveBeenCalled();
    const hidden = new Array(1);
    Object.defineProperty(hidden, "0", { value: "x".repeat(101) });
    expect(() => admit(hidden, { maxStringBytes: 100 })).toThrow(
      "maxStringBytes",
    );
  });

  it.each([0, -1, Infinity, NaN, 1.5, null, undefined, "5"])(
    "rejects supplied invalid option %s",
    (maxNodes) => {
      expect(() => resolve({ maxNodes } as never)).toThrow(CanvasResourceError);
    },
  );

  it("does not evaluate limit option getters and caps downstream recursive depth", () => {
    const get = vi.fn();
    expect(() =>
      resolve(Object.defineProperty({}, "maxNodes", { get })),
    ).toThrow(CanvasResourceError);
    expect(get).not.toHaveBeenCalled();
    expect(() => resolve({ maxDepth: 257 })).toThrow("maxDepth");
    expect(() => resolve(null as never)).toThrow(CanvasResourceError);
  });

  it("rejects before hash, schema, secrets, callbacks, provider config or persistor access", () => {
    const hash = vi.spyOn(rng, "seedFromCanvas");
    const parse = vi.spyOn(canvasDataSchema, "parse");
    const copy = vi.spyOn(JSON, "stringify");
    const effect = vi.fn(() => {
      throw Error("side effect");
    });
    try {
      const args = {
        cannoli: { ...canvas(), metadata: "too large" },
        resourceLimits: { maxStringBytes: 2 },
        secrets: { get: effect, has: effect, list: effect },
        llmConfigs: [
          {
            get provider() {
              return effect();
            },
          },
        ],
        persistor: {
          get start() {
            return effect();
          },
        },
        onFinish: effect,
      };
      expect(() => new Run(args as never)).toThrow(CanvasResourceError);
      expect(copy).not.toHaveBeenCalled();
      expect(hash).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
      expect(effect).not.toHaveBeenCalled();
    } finally {
      copy.mockRestore();
      hash.mockRestore();
      parse.mockRestore();
    }
  });

  it("keeps bounded schema failures on the existing stoppage path", () => {
    const onFinish = vi.fn();
    expect(
      () =>
        new Run({ cannoli: { nodes: [1], edges: [] }, onFinish, isMock: true }),
    ).toThrow("Invalid input");
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "error" }),
    );
  });

  it("omits hidden schema inputs without evaluating their getters", () => {
    const get = vi.fn();
    const input = { nodes: [{}], edges: [] };
    Object.defineProperty(input.nodes[0], "text", { get });
    expect(
      () => new Run({ cannoli: input, onFinish: vi.fn(), isMock: true }),
    ).toThrow("Invalid input");
    expect(get).not.toHaveBeenCalled();
  });

  it("freezes a policy snapshot and propagates it to explicit children", async () => {
    const options = { maxNodes: 1, maxStringBytes: 100 };
    const parent = new Run({
      cannoli: canvas(),
      resourceLimits: options,
      isMock: true,
    });
    options.maxNodes = 100;
    options.maxStringBytes = 1000;
    expect(Object.isFrozen(parent.resourceLimits)).toBe(true);
    await expect(
      parent.subcannoliCallback({ nodes: [null, null], edges: [] }, {}, true),
    ).rejects.toThrow("maxNodes");
    await expect(
      parent.subcannoliCallback(
        { ...canvas(), extra: "x".repeat(101) },
        {},
        true,
      ),
    ).rejects.toThrow("maxStringBytes");
    await expect(
      parent.subcannoliCallback(
        {
          nodes: [
            {
              id: "out",
              type: "text",
              text: "[out]\nhello",
              color: "6",
              x: 0,
              y: 0,
              width: 200,
              height: 100,
            },
          ],
          edges: [],
        },
        {},
        true,
      ),
    ).resolves.toEqual({});
  });

  it("bounds deep, wide, sparse, alias-expanded, cyclic and huge-string inputs in a subprocess", () => {
    const bundled = buildSync({
      entryPoints: ["src/canvasLimits.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
    }).outputFiles[0].text;
    const script =
      bundled +
      `
      const { assertCanvasResourceLimits: guard, resolveCanvasResourceLimits: resolve } = module.exports;
      const limits = resolve();
      let deep = {}; for (let i=0;i<100000;i++) deep = {x:deep};
      const wide = {}; for (let i=0;i<110000;i++) wide['k'+i] = 0;
      let alias = {}; for(let i=0;i<25;i++) alias = {a:alias,b:alias};
      const cyclic = {}; cyclic.x=cyclic;
      for (const input of [deep,wide,new Array(2**32-1),alias,cyclic,'x'.repeat(2000000)]) {
        try { guard(input,limits); process.exit(2); } catch(e) { if(e.name !== 'CanvasResourceError') throw e; }
      }
    `;
    const result = spawnSync(
      process.execPath,
      ["--max-old-space-size=128", "-e", script],
      { timeout: 5000, encoding: "utf8", maxBuffer: 4096 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
