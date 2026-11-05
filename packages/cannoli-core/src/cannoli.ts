import {
  assertCanvasResourceLimits,
  resolveCanvasResourceLimits,
} from "./canvasLimits";
import { Run, RunArgs, Stoppage } from "./run";
import { RunController, StopError } from "./runtime/controller";

export function run(options: RunArgs): [Promise<Stoppage>, () => void] {
  // Reject before wrapper destructuring/spreads can evaluate optional host getters.
  assertCanvasResourceLimits(
    options.cannoli,
    resolveCanvasResourceLimits(options.resourceLimits),
  );
  const { onFinish, controller = new RunController(), ...args } = options;
  let resolver: (stoppage: Stoppage) => void;
  const done = new Promise<Stoppage>((resolve) => {
    resolver = resolve;
  });

  const run = new Run({
    ...args,
    controller,
    onFinish: (stoppage: Stoppage) => {
      resolver(stoppage);
      if (onFinish) onFinish(stoppage);
    },
  });

  run.start();

  return [done, () => controller.stop()];
}

export async function resultsRun(
  args: RunArgs,
): Promise<Record<string, string>> {
  const [done] = run(args);

  const stoppage = await done;

  if (stoppage.reason === "error") {
    throw new Error(`Error occurred during the run: ${stoppage.message}`);
  }

  // A stopped run (a subcannoli whose parent was stopped) has no results.
  if (stoppage.reason === "user") {
    throw new StopError("Stopped by user");
  }

  return stoppage.results;
}
