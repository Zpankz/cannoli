import { describe, expect, it, vi } from "vitest";
import { Run, type RunArgs } from "../src/run";
import { run, resultsRun } from "../src/cannoli";
import { CanvasResourceError } from "../src/canvasLimits";

describe("canvas preflight before host argument access", () => {
  for (const entry of ["Run", "run", "resultsRun"] as const) {
    for (const key of [
      "persistor",
      "fileManager",
      "controller",
      "onFinish",
      "secrets",
      "llmConfigs",
      "config",
      "args",
      "events",
    ] as const) {
      it(`${entry} rejects oversized input before reading ${key}`, async () => {
        const getter = vi.fn(() => {
          throw Error("host getter invoked");
        });
        const options: RunArgs = {
          cannoli: { nodes: new Array(1001), edges: [] },
        };
        Object.defineProperty(options, key, { enumerable: true, get: getter });
        if (entry === "Run")
          expect(() => new Run(options)).toThrow(CanvasResourceError);
        else if (entry === "run")
          expect(() => run(options)).toThrow(CanvasResourceError);
        else
          await expect(resultsRun(options)).rejects.toBeInstanceOf(
            CanvasResourceError,
          );
        expect(getter).not.toHaveBeenCalled();
      });
    }
  }
});
