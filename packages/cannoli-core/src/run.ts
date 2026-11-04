import pLimit from "p-limit";
import {
  AllVerifiedCannoliCanvasNodeData,
  CallNodeType,
  CannoliGraph,
  CannoliObjectKind,
  CannoliObjectStatus,
  ContentNodeType,
  EdgeType,
  VerifiedCannoliCanvasData,
  VerifiedCannoliCanvasEdgeData,
} from "./graph";
import {
  GenericCompletionParams,
  GenericCompletionResponse,
  GenericFunctionCall,
  GenericModelConfig,
  LLMConfig,
  LLMProvider,
  LLMProvider as Llm,
} from "./providers";
import invariant from "tiny-invariant";
import { CannoliFactory } from "./factory";
import { FileManager } from "./fileManager";
import { CanvasData, Persistor, canvasDataSchema } from "./persistor";
import { CannoliObject } from "./graph/CannoliObject";
import { CannoliVertex } from "./graph/objects/CannoliVertex";
import { CannoliGroup } from "./graph/objects/vertices/CannoliGroup";
import { CannoliNode } from "./graph/objects/vertices/CannoliNode";
import { parseNamedNode } from "./utility";
import { resultsRun } from "./cannoli";
import { nanoid } from "nanoid";
import { createRng, pick, seedFromCanvas, type Rng } from "./util/rng";
import { type SecretResolver, toSecretResolver } from "./secrets";
import { lintSecretInPrompt } from "./language/lints";
import { redactingPersistor, redactRequest } from "./runtime/redact";
import { RunController, abortableStream, raceAbort } from "./runtime/controller";
import { warnExecutingNodes } from "./runtime/stop";
import { recordCall, type TokenUsage } from "./runtime/usage";

export interface HttpTemplate {
  id: string;
  name: string;
  url: string;
  method: string;
  headers?: string;
  body?: string; // New field for new templates
  bodyTemplate?: string; // Backward compatibility
}

export interface HttpRequest {
  url: string;
  method: string;
  headers?: string;
  body?: string;
}

export type ActionArgInfo = {
  category: "config" | "secret" | "arg" | "fileManager" | "fetcher" | "extra";
  type?: "string" | "number" | "boolean" | string[];
  displayName?: string;
  description?: string;
  prompt?: string;
};

export type ActionArgs = {
  [key: string]:
    | string
    | number
    | boolean
    | FileManager
    | ResponseTextFetcher
    | Record<string, string>
    | undefined;
};

export type ActionResponse =
  | string
  | string[]
  | Record<string, string | string[]>
  | void
  | Error
  | Promise<
      string | string[] | Record<string, string | string[]> | void | Error
    >;

export type Action = {
  name: string;
  function: (args: ActionArgs) => ActionResponse;
  receive?: (receiveInfo: ReceiveInfo) => ActionResponse;
  displayName?: string;
  description?: string;
  version?: string;
  argInfo?: Record<string, ActionArgInfo>;
  resultKeys?: string[];
  importInfo?: {
    name: string;
    path: string;
  };
};

export type ReceiveInfo = string | string[] | Record<string, string | string[]>;

export type Replacer = (
  content: string,
  isMock: boolean,
  node?: CannoliNode,
) => Promise<string>;

export type StoppageReason = "user" | "error" | "complete";

export type ResponseTextFetcher = (
  url: string,
  options: RequestInit,
) => Promise<string | Error>;

interface Limit {
  <T>(fn: () => Promise<T>): Promise<T>;
}

export interface Stoppage {
  reason: StoppageReason;
  usage: Record<string, ModelUsage>;
  results: { [key: string]: string };
  argNames: string[];
  resultNames: string[];
  actionsOrHttpTemplatesReferenced: {
    names: string[];
    includesDynamicReference: boolean;
  };
  providersReferenced: { names: string[]; includesDynamicReference: boolean };
  description?: string;
  message?: string; // Additional information, like an error message
}

export interface ModelUsage {
  numberOfCalls: number;
  promptTokens?: number;
  completionTokens?: number;
}

export type ChatRole = "user" | "assistant" | "system";

enum DagCheckState {
  UNVISITED,
  VISITING,
  VISITED,
}

export function isValidKey(
  key: string,
  config: GenericModelConfig,
): key is keyof GenericModelConfig {
  return key in config;
}

/**
 * Pass a stream through, calling release once it ends, fails or is closed
 * early by the consumer.
 */
async function* releaseWhenDone<T>(
  stream: AsyncIterable<T>,
  release: () => void,
): AsyncGenerator<T> {
  try {
    yield* stream;
  } finally {
    release();
  }
}

export interface RunArgs {
  cannoli: unknown;
  llmConfigs?: LLMConfig[];
  fetcher?: ResponseTextFetcher;
  config?: Record<string, unknown>;
  /** A plain record is deprecated, kept for previously baked code. */
  secrets?: SecretResolver | Record<string, string>;
  args?: Record<string, string>;
  onFinish?: (stoppage: Stoppage) => void;
  isMock?: boolean;
  persistor?: Persistor;
  fileManager?: FileManager;
  actions?: Action[];
  httpTemplates?: HttpTemplate[];
  replacers?: Replacer[];
  resume?: boolean;
  runName?: string;
  /** Seeds the RNG that mock runs use for choices. Defaults to a hash of the canvas. */
  seed?: number;
  /** Stops the run and cancels its calls. Defaults to a fresh controller. */
  controller?: RunController;
  cannoliServer?: {
    url: string;
    secret: string;
  };
}

export class Run {
  graph: Record<string, CannoliObject> = {};
  onFinish: (stoppage: Stoppage) => void;
  canvasData: VerifiedCannoliCanvasData | null = null;

  args: Record<string, string> | null;
  config: Record<string, unknown> | null;
  secrets: SecretResolver;
  fileManager: FileManager | null = null;
  fetcher: ResponseTextFetcher;
  actions: Action[] = [];
  httpTemplates: HttpTemplate[] = [];
  replacers: Replacer[] = [];
  llm: Llm | null = null;
  llmLimit: Limit = pLimit(1000);
  persistor: Persistor | null = null;
  isMock: boolean = false;
  /** Randomness for mock runs, seeded so the same canvas makes the same choices. */
  rng: Rng;
  stopTime: number | null = null;
  currentNote: string | null = null;
  selection: string | null = null;
  /** The run ID for this run. */
  runId: string;
  /** The run name for this run. Used to identify all runs from all executions of the same canvas. */
  runName: string;
  /** The run date for this run. The date in which this run was started, in epoch milliseconds. */
  runDateEpochMs: number;

  subcannoliCallback: (
    cannoli: unknown,
    inputVariables: Record<string, string>,
    scIsMock: boolean,
  ) => Promise<Record<string, string>> = () => Promise.resolve({});

  usage: Record<string, ModelUsage>;

  controller: RunController;

  forEachTracker: Map<string, number> = new Map();

  constructor({
    cannoli,
    isMock,
    onFinish,
    persistor,
    fileManager,
    llmConfigs,
    fetcher,
    actions,
    httpTemplates,
    replacers,
    config,
    secrets,
    args,
    runName,
    resume,
    cannoliServer,
    seed,
    controller,
  }: RunArgs) {
    this.onFinish = onFinish ?? ((stoppage: Stoppage) => {});
    this.controller = controller ?? new RunController();
    this.controller.signal.addEventListener("abort", () => this.stopped(), {
      once: true,
    });
    this.isMock = isMock ?? false;
    this.rng = createRng(seed ?? seedFromCanvas(cannoli));
    this.secrets = toSecretResolver(secrets);
    this.persistor = persistor
      ? redactingPersistor(persistor, this.secrets)
      : null;
    this.usage = {};
    this.runId = `${nanoid(16)}${isMock ? "-mock" : ""}`;
    this.runDateEpochMs = Date.now();
    this.runName = runName || "Unnamed Cannoli Run";

    const defaultFetcher: ResponseTextFetcher = async (url, options) => {
      const res = await fetch(url, options);
      return await res.text();
    };

    this.fetcher = fetcher ?? defaultFetcher;

    this.llm = llmConfigs
      ? new LLMProvider({
          configs: llmConfigs,
          valtownApiKey: this.secrets.get("VALTOWN_API_KEY") ?? undefined,
          runId: this.runId,
          runDateEpochMs: this.runDateEpochMs,
          runName: this.runName,
          cannoliServerUrl: cannoliServer?.url,
          cannoliServerSecret: cannoliServer?.secret,
        })
      : null;

    this.config = { ...(config ?? {}) };

    this.args = args ?? null;

    let parsedCannoliJSON: CanvasData;

    try {
      // Parse the JSON and get the settings and args
      parsedCannoliJSON = canvasDataSchema.parse(cannoli);
    } catch (error) {
      if (error instanceof Error) {
        this.error(error.message);
      } else {
        this.error("Invalid Cannoli JSON");
      }
      return;
    }

    // Bounds concurrent model calls, streaming included (DESIGN §11.5).
    const limit = this.config?.pLimit ?? 1000;
    this.llmLimit = pLimit(
      typeof limit === "number" && Number.isInteger(limit) && limit > 0
        ? limit
        : 1000,
    );

    // Remove these properties from the args object without affecting the saved values
    if (this.args) {
      const { obsidianCurrentNote, obsidianSelection, ...restArgs } = this.args;
      this.args = restArgs;

      // Extract currentNote and selection from args, with default values
      this.currentNote = obsidianCurrentNote ?? "No current note";
      this.selection = obsidianSelection ?? "No selection";
    }

    this.fileManager = fileManager ?? null;

    this.actions = actions ?? [];
    this.httpTemplates = httpTemplates ?? [];
    this.replacers = replacers ?? [];

    const factory = new CannoliFactory(
      parsedCannoliJSON,
      this.persistor ?? undefined,
      resume,
      this.config?.contentIsColorless as boolean,
      this.currentNote ?? "No current note",
    );

    const canvasData = factory.getCannoliData();

    // Find all nodes of type "input"
    const argNodes = canvasData.nodes.filter(
      (node) => node.cannoliData.type === "input",
    );

    // For each arg, check if the key matches the name of the input node
    for (const [key, value] of Object.entries(this.args ?? {})) {
      const matchingArgNodes = argNodes.filter((node) => {
        const { name } = parseNamedNode(node.cannoliData.text);
        return name === key;
      });

      if (matchingArgNodes.length > 0) {
        // If matching nodes are found, update their content
        matchingArgNodes.forEach((argNode) => {
          const { name } = parseNamedNode(argNode.cannoliData.text);
          argNode.cannoliData.text = `[${name}]\n${value}`;
        });
      } else {
        throw new Error(`Argument key "${key}" not found in input nodes.`);
      }
    }

    this.canvasData = canvasData;

    this.graph = new CannoliGraph(canvasData).graph;

    // Set this as the run for every object
    for (const object of Object.values(this.graph)) {
      object.setRun(this);
    }

    this.subcannoliCallback = (
      cannoli: unknown,
      inputVariables: Record<string, string>,
      scIsMock: boolean,
    ) => {
      return resultsRun({
        cannoli,
        llmConfigs,
        args: {
          ...inputVariables,
          obsidianCurrentNote: this.currentNote ?? "",
          obsidianSelection: this.selection ?? "",
        },
        fileManager,
        actions,
        httpTemplates,
        isMock: scIsMock,
        config,
        secrets: this.secrets,
        fetcher,
        replacers,
        controller: this.controller,
      });
    };
  }

  async start() {
    // Log the graph
    // this.logGraph();

    if (this.persistor !== null && this.canvasData !== null) {
      await this.persistor.start(JSON.parse(JSON.stringify(this.canvasData)));
    }

    // Setup listeners
    this.setupListeners();

    // Reset the graph
    this.reset();

    // Validate the graph
    this.validate();

    // Never send a secret value to an LLM: fail before any call executes.
    const secretLint = this.canvasData
      ? lintSecretInPrompt(this.canvasData, this.secrets.names())[0]
      : undefined;
    if (secretLint) {
      await this.persistor?.addError(secretLint.nodeId, secretLint.message);
      this.handleFinish("error", secretLint.message);
      return;
    }

    let executedObjectsCount = 0;

    // Call execute on all root objects
    for (const object of Object.values(this.graph)) {
      if (object.dependencies.length === 0) {
        object.startExecution();
        executedObjectsCount++;
      }
    }

    if (executedObjectsCount === 0) {
      this.error("No objects to execute");
    }
  }

  getArgNames(): string[] {
    const argNames: Set<string> = new Set();

    const argNodes = this.canvasData?.nodes.filter(
      (node) => node.cannoliData.type === "input",
    );

    if (!argNodes) {
      return Array.from(argNames);
    }

    for (const node of argNodes) {
      const { name } = parseNamedNode(node.cannoliData.text);
      if (name !== null) {
        argNames.add(name);
      }
    }

    return Array.from(argNames);
  }

  getResultNames(): string[] {
    const resultNames: Set<string> = new Set();

    const resultNodes = this.canvasData?.nodes.filter(
      (node) => node.cannoliData.type === "output",
    );

    if (!resultNodes) {
      return Array.from(resultNames);
    }

    for (const node of resultNodes) {
      const { name } = parseNamedNode(node.cannoliData.text);
      if (name !== null) {
        resultNames.add(name);
      }
    }

    return Array.from(resultNames);
  }

  getActionsOrHttpTemplatesReferenced(): {
    names: string[];
    includesDynamicReference: boolean;
  } {
    const names: string[] = [];
    let includesDynamicReference = false;

    // Get all action nodes
    const actionNodes = this.canvasData?.nodes.filter(
      (node) => node.cannoliData.type === ContentNodeType.Http,
    );

    if (!actionNodes) {
      return { names, includesDynamicReference };
    }

    for (const node of actionNodes) {
      const { name, content } = parseNamedNode(node.cannoliData.text);

      if (name !== null) {
        names.push(name);
      } else if (content.trim().split("\n").length === 1) {
        // If it's a single line without a name, treat the whole content as the name
        names.push(content.trim());
      }

      // Check for dynamic references
      if (
        node.cannoliData.text.includes("{{") &&
        node.cannoliData.text.includes("}}")
      ) {
        includesDynamicReference = true;
      }
    }

    return { names, includesDynamicReference };
  }

  getProvidersReferenced(): {
    names: string[];
    includesDynamicReference: boolean;
  } {
    const providersReferenced: string[] = [];
    let includesDynamicReference = false;

    const incomingConfigProviderEdges = this.canvasData?.edges
      .filter((edge) => edge.cannoliData.type === EdgeType.Config)
      .filter((edge) => edge.cannoliData.text === "provider");

    for (const edge of incomingConfigProviderEdges || []) {
      const sourceNode = this.canvasData?.nodes.find(
        (node) => node.id === edge.fromNode,
      );
      if (
        sourceNode &&
        (sourceNode.cannoliData.type === ContentNodeType.StandardContent ||
          sourceNode.cannoliData.type === ContentNodeType.Input)
      ) {
        const { name, content } = parseNamedNode(sourceNode.cannoliData.text);

        if (name !== null) {
          providersReferenced.push(name);
          includesDynamicReference = true;
        } else {
          providersReferenced.push(content.trim());
        }
      } else if (sourceNode) {
        includesDynamicReference = true;
      }
    }

    return { names: providersReferenced, includesDynamicReference };
  }

  getDescription(): string | undefined {
    // Find a node of type "variable" whose name is "DESCRIPTION"
    const descriptionNode = this.canvasData?.nodes.find(
      (node) =>
        node.cannoliData.type === "variable" &&
        node.cannoliData.text.split("\n")[0] === "[DESCRIPTION]",
    );
    if (descriptionNode) {
      return descriptionNode.cannoliData.text.split("\n").slice(1).join("\n");
    }
    return undefined;
  }

  private handleFinish(reason: StoppageReason, message?: string) {
    this.stopTime = Date.now();

    this.onFinish({
      reason,
      message,
      results: this.getResults(),
      argNames: this.getArgNames(),
      resultNames: this.getResultNames(),
      actionsOrHttpTemplatesReferenced:
        this.getActionsOrHttpTemplatesReferenced(),
      providersReferenced: this.getProvidersReferenced(),
      description: this.getDescription(),
      usage: this.usage,
    });
  }

  error(message: string) {
    this.handleFinish("error", message);
    throw new Error(message);
  }

  stop() {
    this.controller.stop();
  }

  /** The controller aborted: mark what was running, then finish as stopped. */
  private stopped() {
    if (this.stopTime) {
      return;
    }
    warnExecutingNodes(this, "Stopped by user");
    this.handleFinish("user");
  }

  reset() {
    this.stopTime = null;

    // Call reset on all objects
    for (const object of Object.values(this.graph)) {
      object.reset();
    }
  }

  validate() {
    // Call validate on each object
    for (const object of Object.values(this.graph)) {
      object.validate();
      if (this.stopTime) {
        return;
      }
    }

    // Check if the graph is a DAG
    if (!this.isDAG(this.graph)) {
      // Find a node and call error on it
      for (const object of Object.values(this.graph)) {
        if (object instanceof CannoliVertex)
          object.error(
            "Cycle detected in graph. Please make sure the graph is a DAG.\n(exception: edges between groups and their members)",
          );
        return;
      }
    }
  }

  setupListeners() {
    for (const object of Object.values(this.graph)) {
      // @ts-ignore
      object.addEventListener("update", (event: CustomEvent) => {
        this.objectUpdated(
          event.detail.obj,
          event.detail.status,
          event.detail.message,
        );
      });
    }
  }

  getDefaultConfig() {
    return this.llm?.getConfig() ?? {};
  }

  objectUpdated(
    object: CannoliObject,
    status: CannoliObjectStatus,
    message?: string,
  ) {
    const currentTime = Date.now();
    if (this.stopTime) {
      const elapsed = currentTime - this.stopTime;
      if (elapsed > 10) {
        return;
      }
    }

    switch (status) {
      case CannoliObjectStatus.Complete: {
        this.objectCompleted(object);
        break;
      }
      case CannoliObjectStatus.Rejected: {
        this.objectRejected(object);
        break;
      }
      case CannoliObjectStatus.Executing: {
        this.objectExecuting(object);
        break;
      }
      case CannoliObjectStatus.Pending: {
        this.objectPending(object);
        break;
      }
      case CannoliObjectStatus.VersionComplete: {
        this.objectVersionComplete(object, message);
        break;
      }
      case CannoliObjectStatus.Error: {
        this.objectError(object, message);
        break;
      }
      case CannoliObjectStatus.Warning: {
        this.objectWarning(object, message);
        break;
      }

      default: {
        throw new Error(`Unknown status: ${status}`);
      }
    }
  }

  updateObject(object: CannoliObject) {
    if (!this.isMock && this.persistor) {
      if (
        object.kind === CannoliObjectKind.Node ||
        object.kind === CannoliObjectKind.Group
      ) {
        const data = this.canvasData?.nodes.find(
          (node) => node.id === object.id,
        );
        this.persistor.editNode(
          JSON.parse(JSON.stringify(data)) as AllVerifiedCannoliCanvasNodeData,
        );
      } else if (object.kind === CannoliObjectKind.Edge) {
        const data = this.canvasData?.edges.find(
          (edge) => edge.id === object.id,
        );
        this.persistor.editEdge(
          JSON.parse(JSON.stringify(data)) as VerifiedCannoliCanvasEdgeData,
        );
      }
    }
  }

  objectCompleted(object: CannoliObject) {
    this.updateObject(object);
    this.updateOriginalParallelGroupLabel(object, "executing");

    if (this.allObjectsFinished() && !this.stopTime) {
      this.handleFinish("complete");
    }
  }

  objectRejected(object: CannoliObject) {
    this.updateObject(object);

    if (this.allObjectsFinished() && !this.stopTime) {
      this.handleFinish("complete");
    }
  }

  objectExecuting(object: CannoliObject) {
    this.updateObject(object);
  }

  objectPending(object: CannoliObject) {
    this.updateObject(object);

    this.updateOriginalParallelGroupLabel(object, "reset");

    if (
      this.persistor &&
      (object.type === CallNodeType.Choose ||
        object.type === CallNodeType.Form ||
        object.type === CallNodeType.StandardCall)
    ) {
      const editedNode = JSON.parse(
        JSON.stringify(
          this.canvasData?.nodes.find((node) => node.id === object.id),
        ),
      );

      if (!editedNode) {
        return;
      }

      editedNode.color = this.config?.contentIsColorless ? "6" : "0";

      this.persistor.editNode(editedNode);
    }
    // else if (
    // 	this.canvas &&
    // 	object instanceof ContentNode &&
    // 	object.text === ""
    // ) {
    // 	this.canvas.enqueueChangeNodeText(object.id, "");
    // } else if (
    // 	this.canvas &&
    // 	(object instanceof RepeatGroup)
    // ) {
    // 	this.canvas.enqueueChangeNodeText(object.id, `0/${object.maxLoops}`);
    // } else if (this.canvas && object instanceof CannoliGroup && object.fromForEach && object.originalObject) {
    // 	this.canvas.enqueueChangeNodeText(object.originalObject, `0/${object.maxLoops}`);
    // }
  }

  objectVersionComplete(object: CannoliObject, message?: string) {
    this.updateObject(object);

    this.updateOriginalParallelGroupLabel(object);
  }

  objectError(object: CannoliObject, message?: string) {
    // After a user stop, errors are the stop's echo (aborted calls).
    if (this.controller.signal.aborted) {
      return;
    }

    if (this.persistor && object instanceof CannoliVertex) {
      this.persistor.addError(object.id, message ?? "Unknown error");
    }

    // The first error ends the run; later ones still mark their node.
    if (this.stopTime) {
      return;
    }

    // Not this.error(): this runs inside the object's "update" event listener,
    // where a throw can't reach the run. Browsers only log it, but Node's
    // EventTarget re-raises it as an uncaught exception.
    this.handleFinish("error", message ?? "Unknown error");
  }

  /**
   * An object's execute() threw. End the run with an error stoppage, unless
   * it has already finished (stopped by the user, errored or completed).
   */
  nodeExecutionFailed(object: CannoliObject, error: unknown) {
    if (this.stopTime) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);

    if (this.persistor && object instanceof CannoliVertex) {
      this.persistor.addError(object.id, message);
    }

    this.handleFinish("error", message);
  }

  objectWarning(object: CannoliObject, message?: string) {
    if (this.persistor && object instanceof CannoliVertex) {
      this.persistor.addWarning(object.id, message ?? "Unknown warning");
    }
  }

  updateOriginalParallelGroupLabel(
    object: CannoliObject,
    flag?: "reset" | "executing",
  ) {
    if (this.persistor && !this.isMock) {
      if (
        object instanceof CannoliGroup &&
        object.fromForEach &&
        object.originalObject
      ) {
        const originalGroupId = object.originalObject;

        if (flag === "reset") {
          this.forEachTracker.delete(originalGroupId);
          this.persistor.editOriginalParallelGroupLabel(
            originalGroupId,
            `${object.maxLoops}`,
          );
          return;
        }

        // Nested parallel groups make maxLoops copies per copy of the
        // enclosing group, so count the copies rather than using maxLoops.
        const total = this.countParallelGroupCopies(originalGroupId);

        if (flag === "executing") {
          this.persistor.editOriginalParallelGroupLabel(
            originalGroupId,
            `0/${total}`,
          );
          return;
        }

        if (!this.forEachTracker.has(originalGroupId)) {
          this.forEachTracker.set(originalGroupId, 1);
        } else {
          const current = this.forEachTracker.get(originalGroupId);
          if (current !== undefined) {
            this.forEachTracker.set(originalGroupId, current + 1);
          }
        }

        this.persistor.editOriginalParallelGroupLabel(
          originalGroupId,
          `${this.forEachTracker.get(originalGroupId)}/${total}`,
        );
      }
    }
  }

  /** How many parallel-group copies in the graph came from this canvas group. */
  private countParallelGroupCopies(originalGroupId: string): number {
    let count = 0;
    for (const object of Object.values(this.graph)) {
      if (
        object instanceof CannoliGroup &&
        object.fromForEach &&
        object.originalObject === originalGroupId
      ) {
        count++;
      }
    }
    return count;
  }

  allObjectsFinished(): boolean {
    // Check if all objects are complete or rejected
    for (const object of Object.values(this.graph)) {
      if (
        object.status !== CannoliObjectStatus.Complete &&
        object.status !== CannoliObjectStatus.Rejected
      ) {
        return false;
      }
    }

    return true;
  }

  getResults(): { [key: string]: string } {
    const variableNodes = Object.values(this.graph).filter(
      (object) => object.type === "output" && object.kind === "node",
    );
    const results: { [key: string]: string } = {};

    for (const node of variableNodes) {
      const { name, content } = parseNamedNode(node.text);

      if (name !== null) {
        results[name] = content.trim();
      }
    }

    return results;
  }

  isDAG(objects: Record<string, CannoliObject>): boolean {
    const states = new Map<CannoliObject, DagCheckState>();

    function visit(obj: CannoliObject): boolean {
      if (states.get(obj) === DagCheckState.VISITING) {
        return false; // Cycle detected
      }

      if (states.get(obj) === DagCheckState.VISITED) {
        return true; // Already visited
      }

      states.set(obj, DagCheckState.VISITING);

      for (const dependency of obj.getAllDependencies()) {
        if (!visit(dependency)) {
          return false; // Cycle detected in one of the dependencies
        }
      }

      states.set(obj, DagCheckState.VISITED);
      return true;
    }

    for (const obj of Object.values(objects)) {
      if (states.get(obj) !== DagCheckState.VISITED) {
        if (!visit(obj)) {
          return false; // Cycle detected
        }
      }
    }

    return true;
  }

  async callLLM(
    request: GenericCompletionParams,
    verbose?: boolean,
  ): Promise<GenericCompletionResponse | Error> {
    request = redactRequest(request, this.secrets);
    return this.llmLimit(
      async (): Promise<GenericCompletionResponse | Error> => {
        // Only call LLM if we're not mocking
        if (this.isMock || !this.llm || !this.llm.initialized) {
          return this.createMockFunctionResponse(request);
        }

        const signal = this.controller.signal;
        // Catch any errors
        try {
          if (signal.aborted) throw signal.reason;
          let tokens: TokenUsage | undefined;
          const response = await raceAbort(
            this.llm.getCompletion(request, {
              signal,
              onUsage: (u) => (tokens = u),
            }),
            signal,
          );
          const completion = response;

          if (verbose) {
            console.log(
              "Input Messages:\n" +
                JSON.stringify(request.messages, null, 2) +
                "\n\nResponse Message:\n" +
                JSON.stringify(completion, null, 2),
            );
          }

          recordCall(this.usage, request.model, tokens);

          invariant(completion, "No message returned");

          return completion;
        } catch (e) {
          // A user stop rejects instead, so the node ends quietly.
          if (signal.aborted) throw signal.reason;
          return e as Error;
        }
      },
    );
  }

  async callGoalAgent({
    request,
    verbose,
    onReasoningMessagesUpdated,
  }: {
    request: GenericCompletionParams;
    verbose?: boolean;
    /**
     * Called for each message that is created during the reasoning process
     */
    onReasoningMessagesUpdated?: (
      messages: GenericCompletionResponse[],
    ) => void;
  }): Promise<GenericCompletionResponse | Error> {
    request = redactRequest(request, this.secrets);
    return this.llmLimit(
      async (): Promise<GenericCompletionResponse | Error> => {
        // Only call LLM if we're not mocking
        if (this.isMock || !this.llm || !this.llm.initialized) {
          return this.createMockFunctionResponse(request);
        }

        const signal = this.controller.signal;
        // Catch any errors
        try {
          if (signal.aborted) throw signal.reason;
          const response = await raceAbort(
            this.llm.getGoalCompletion(
              { ...request, onReasoningMessagesUpdated },
              { signal },
            ),
            signal,
          );
          const completion = response;

          if (verbose) {
            console.log(
              "Input Messages:\n" +
                JSON.stringify(request.messages, null, 2) +
                "\n\nResponse Message:\n" +
                JSON.stringify(completion, null, 2),
            );
          }

          // An agent makes several model calls; their tokens aren't summed yet.
          recordCall(this.usage, request.model);

          invariant(completion, "No message returned");

          return completion;
        } catch (e) {
          // A user stop rejects instead, so the node ends quietly.
          if (signal.aborted) throw signal.reason;
          return e as Error;
        }
      },
    );
  }

  async callLLMStream(request: GenericCompletionParams) {
    request = redactRequest(request, this.secrets);
    if (this.isMock || !this.llm || !this.llm.initialized) {
      // Return mock stream
      return "Mock response";
    }
    const llm = this.llm;
    const signal = this.controller.signal;

    // A streaming call holds its limiter slot until the stream ends, not just
    // until the stream object is returned (DESIGN §11.5). A stop frees it at
    // once: the provider's stream may not notice the abort until its next chunk.
    const acquired = await this.acquireLlmSlot();
    let tokens: TokenUsage | undefined;
    let started = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", finish);
      acquired();
      // Like callLLM, count calls that got a response, even a partial one.
      if (started) recordCall(this.usage, request.model, tokens);
    };
    signal.addEventListener("abort", finish, { once: true });
    try {
      if (signal.aborted) throw signal.reason;
      const response = await raceAbort(
        llm.getCompletionStream(request, {
          signal,
          onUsage: (u) => (tokens = u),
        }),
        signal,
      );

      invariant(response, "No message returned");
      started = true;

      return abortableStream(releaseWhenDone(response, finish), signal);
    } catch (e) {
      finish();
      // A user stop rejects instead, so the node ends quietly.
      if (signal.aborted) throw signal.reason;
      return e as Error;
    }
  }

  /** Wait for a free limiter slot; call the returned function to free it. */
  private acquireLlmSlot(): Promise<() => void> {
    return new Promise((acquired) => {
      void this.llmLimit(
        () => new Promise<void>((release) => acquired(() => release())),
      );
    });
  }

  createMockFunctionResponse(
    request: GenericCompletionParams,
  ): GenericCompletionResponse {
    let textMessages = "";

    // For each message, convert it to a string, including the role and the content, and a function call if present
    for (const message of request.messages) {
      if ("function_call" in message && message.function_call) {
        textMessages += `${message.role}: ${message.content} ${message.function_call} `;
      } else {
        textMessages += `${message.role}: ${message.content} `;
      }
    }

    // Estimate the tokens using the rule of thumb that 4 characters is 1 token
    const callPromptTokens = textMessages.length / 4;

    if (
      request.model
      // this.llm?.provider === "openai"
      // !this.usage[request.model]
    ) {
      const numberOfCalls = this.usage[request.model]?.numberOfCalls ?? 0;
      const promptTokens = this.usage[request.model]?.promptTokens ?? 0;

      this.usage[request.model] = {
        numberOfCalls: numberOfCalls + 1,
        promptTokens: promptTokens + callPromptTokens,
      };
    }

    let calledFunction = "";

    if (request.functions && request.functions.length > 0) {
      calledFunction = request.functions[0].name;
    }

    if (calledFunction) {
      if (calledFunction === "choice") {
        // Find the choice function
        const choiceFunction = request.functions?.find(
          (fn) => fn.name === "choice",
        );

        if (!choiceFunction) {
          throw Error("No choice function found");
        }

        return this.createMockChoiceFunctionResponse(choiceFunction);
      } else if (calledFunction === "form") {
        // Find the answers function
        const formFunction = request.functions?.find(
          (fn) => fn.name === "form",
        );

        if (!formFunction) {
          throw Error("No form function found");
        }

        return this.createMockFormFunctionResponse(formFunction);
      } else if (calledFunction === "note_select") {
        // Find the note name function
        const noteNameFunction = request.functions?.find(
          (fn) => fn.name === "note_select",
        );

        if (!noteNameFunction) {
          throw Error("No note select function found");
        }

        return this.createMockNoteNameFunctionResponse(noteNameFunction);
      }
    }

    return {
      role: "assistant",
      content: "Mock response",
    };
  }

  createMockChoiceFunctionResponse(choiceFunction: GenericFunctionCall) {
    const parsedProperties = JSON.parse(
      JSON.stringify(choiceFunction?.parameters?.["properties"] ?? {}),
    );

    // Pick one of the choices with the run's seeded RNG
    const randomChoice =
      pick(this.rng, parsedProperties?.choice?.enum) ?? "N/A";

    return {
      role: "assistant",
      content: "",
      function_call: {
        name: "choice",
        args: {
          choice: `${randomChoice}`,
        },
      },
    };
  }

  createMockFormFunctionResponse(listFunction: GenericFunctionCall) {
    const args: { [key: string]: string } = {};

    // Go through the properties of the function and enter a mock string
    for (const property of Object.keys(
      (listFunction?.parameters?.["properties"] ?? {}) as Record<
        string,
        string
      >,
    )) {
      args[property] = "Mock answer";
    }

    return {
      role: "assistant",
      content: "",
      function_call: {
        name: "form",
        args: args,
      },
    };
  }

  createMockNoteNameFunctionResponse(noteFunction: GenericFunctionCall) {
    const parsedProperties = JSON.parse(
      JSON.stringify(noteFunction?.parameters?.["properties"] ?? {}),
    );

    // Pick one of the options in note.enum with the run's seeded RNG.
    // (The index used to be unfloored, so this was almost always "N/A".)
    const randomNote = pick(this.rng, parsedProperties?.note?.enum) ?? "N/A";

    // One object, like the real note_select tool call: CallNode parses the
    // args as { note }. (They used to be an array, so mock runs failed here.)
    return {
      role: "assistant",
      content: "",
      function_call: {
        name: "note_select",
        args: { note: `${randomNote}` },
      },
    };
  }

  createChoiceFunction(choices: string[]): GenericFunctionCall {
    return {
      name: "choice",
      description: "Enter your choice using this function.",
      parameters: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            enum: choices,
          },
        },
        required: ["choice"],
      },
    };
  }

  createFormFunction(
    tags: { name: string; noteNames?: string[] }[],
  ): GenericFunctionCall {
    const properties: Record<string, { type: string; enum?: string[] }> = {};

    tags.forEach((tag) => {
      if (tag.noteNames) {
        properties[tag.name] = {
          type: "string",
          enum: tag.noteNames,
        };
        return;
      }
      properties[tag.name] = {
        type: "string",
      };
    });

    return {
      name: "form",
      description:
        "Use this function to enter the requested information for each key.",
      parameters: {
        type: "object",
        properties,
        required: tags.map((tag) => tag.name),
      },
    };
  }

  createNoteNameFunction(notes: string[]): GenericFunctionCall {
    return {
      name: "note_select",
      description: "Enter one of the provided valid note names.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            enum: notes,
          },
        },
        required: ["note"],
      },
    };
  }

  logGraph() {
    for (const node of Object.values(this.graph)) {
      console.log(node.logDetails());
    }
  }

  async executeHttpRequest(
    request: HttpRequest,
    timeout: number = 30000,
  ): Promise<string | Error> {
    if (this.isMock) {
      return "mock response";
    }

    // Try to parse the headers
    let headers: Record<string, string> | undefined;
    if (request.headers) {
      try {
        headers = JSON.parse(request.headers);
      } catch {
        return new Error(`Error parsing headers: ${request.headers}`);
      }
    }

    let body;

    if (request.body) {
      // Use the headers to decide whether to use json stringify. If the header defines json but it can't be parsed, error
      if (headers && headers["Content-Type"] === "application/json") {
        try {
          body = JSON.stringify(JSON.parse(request.body));
        } catch {
          return new Error(`Error parsing body: ${request.body}`);
        }
      } else {
        body = request.body;
      }
    }

    try {
      this.validateRequestParams(headers, request.body);
    } catch (error) {
      return new Error(`Error validating request params: ${error}`);
    }

    // Prepare fetch options
    const signal = this.controller.signal;
    const options: RequestInit = {
      method: request.method ?? "GET", // Default to GET if no body is provided
      headers: headers,
      body: body,
      signal,
    };

    try {
      if (signal.aborted) throw signal.reason;
      // The race covers fetchers that ignore the signal (Obsidian's requestUrl).
      const responseText = await raceAbort(
        Promise.race([
          this.fetcher(request.url, options),
          new Promise<Error>((_, reject) =>
            setTimeout(() => reject(new Error("Request timed out.")), timeout),
          ),
        ]),
        signal,
      );

      if (responseText instanceof Error) {
        return responseText;
      }

      let response;
      try {
        response = JSON.parse(responseText); // Try to parse as JSON
      } catch {
        response = responseText; // If parsing fails, return as string
      }

      if (response.status && response.status >= 400) {
        const errorMessage = `HTTP error ${response.status}: ${response.statusText}`;
        return new Error(errorMessage);
      }

      if (typeof response === "string") {
        return response;
      } else {
        // Ensure the response is formatted nicely for markdown
        return JSON.stringify(response, null, 2)
          .replace(/\\n/g, "\n") // Ensure newlines are properly formatted
          .replace(/\\t/g, "\t") // Ensure tabs are properly formatted
          .replace(/\\/g, "\\") // Ensure backslashes are properly formatted
          .replace(/\\"/g, '"'); // Ensure double quotes are properly formatted
      }
    } catch (error) {
      // A user stop rejects instead, so the node ends quietly.
      if (signal.aborted) throw signal.reason;
      if (error instanceof Error) {
        return new Error(`Error on HTTP request: ${error.message}`);
      } else {
        return new Error(`Error on HTTP request: ${error}`);
      }
    }
  }

  validateRequestParams(headers: unknown, body: unknown): void {
    if (headers) {
      // Validate headers
      if (Array.isArray(headers)) {
        try {
          Object.fromEntries(headers);
        } catch (error) {
          throw new Error("Invalid headers array format.");
        }
      } else if (headers instanceof Headers) {
        // Headers instance is valid
      } else if (typeof headers === "object" && headers !== null) {
        // Plain object is valid
      } else {
        throw new Error(
          "Invalid headers format. Expected an array, Headers instance, or plain object.",
        );
      }
    }
    // Validate body
    if (body !== null && body !== undefined) {
      if (typeof body !== "string" && !(body instanceof ArrayBuffer)) {
        throw new Error(
          "Invalid body format. Expected a string or ArrayBuffer.",
        );
      }
    }
  }
}
