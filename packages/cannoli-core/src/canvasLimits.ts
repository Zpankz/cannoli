/** Finite per-canvas admission policy, also inherited by explicit child runs. */
export interface CanvasResourceLimits {
  maxNodes: number;
  maxEdges: number;
  /** Total object properties plus array slots (including holes), counting aliases again. */
  maxEntries: number;
  /** Root is depth zero; every property/array element adds one. */
  maxDepth: number;
  /** UTF-8 bytes of any individual key or string value, before JSON escaping. */
  maxStringBytes: number;
  /** Conservative compact JSON UTF-8 budget; see docs/canvas-resource-limits.md. */
  maxInputBytes: number;
}

export const DEFAULT_CANVAS_RESOURCE_LIMITS: Readonly<CanvasResourceLimits> =
  Object.freeze({
    maxNodes: 1000,
    maxEdges: 4000,
    maxEntries: 100_000,
    maxDepth: 64,
    maxStringBytes: 1024 * 1024,
    maxInputBytes: 8 * 1024 * 1024,
  });

export class CanvasResourceError extends Error {
  constructor(readonly limit: keyof CanvasResourceLimits | "jsonData") {
    super(`Canvas admission rejected: ${limit}`);
    this.name = "CanvasResourceError";
  }
}

/** No disabling sentinel: supplied options must be positive finite safe integers. */
export function resolveCanvasResourceLimits(
  options?: Partial<CanvasResourceLimits>,
): Readonly<CanvasResourceLimits> {
  if (
    options !== undefined &&
    (options === null || typeof options !== "object" || Array.isArray(options))
  ) {
    throw new CanvasResourceError("jsonData");
  }
  const limits = { ...DEFAULT_CANVAS_RESOURCE_LIMITS };
  // Only six known keys are read; do not enumerate an untrusted option bag.
  for (const key of Object.keys(limits) as (keyof CanvasResourceLimits)[]) {
    const descriptor = options && Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor) continue;
    if (
      !("value" in descriptor) ||
      !Number.isSafeInteger(descriptor.value) ||
      descriptor.value <= 0 ||
      (key === "maxDepth" && descriptor.value > 256)
    ) {
      throw new CanvasResourceError(key);
    }
    limits[key] = descriptor.value;
  }
  return Object.freeze(limits);
}

/** Lazy enumeration: never map children or allocate an Object.keys(input) array. */
function* properties(value: object): Generator<string> {
  if (Array.isArray(value)) {
    // JSON reads every slot, even non-enumerable accessors. Do not use for-in here.
    for (let i = 0; i < value.length; i++) yield String(i);
    return;
  }
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) yield key;
  }
}

/**
 * Admit ordinary JSON data before serialization, hashing, parsing or host work.
 * No recursion, callbacks, encoders with input-sized output, or async scheduling.
 * Proxies are outside the JSON-data contract: JS cannot inspect one without traps.
 */
export function assertCanvasResourceLimits(
  canvas: unknown,
  limits: Readonly<CanvasResourceLimits>,
): void {
  let entries = 0;
  let bytes = 0;
  const addBytes = (amount: number) => {
    bytes += amount;
    if (bytes > limits.maxInputBytes) {
      throw new CanvasResourceError("maxInputBytes");
    }
  };
  const addEntries = (amount: number) => {
    entries += amount;
    if (entries > limits.maxEntries) {
      throw new CanvasResourceError("maxEntries");
    }
  };
  const string = (value: string) => {
    // UTF-8 is at least one byte per code unit, except pairs (4 bytes for 2).
    if (value.length > limits.maxStringBytes) {
      throw new CanvasResourceError("maxStringBytes");
    }
    let raw = 0;
    addBytes(2); // quotes
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      let encoded = 0;
      let escaped = 0;
      if (
        c >= 0xd800 &&
        c <= 0xdbff &&
        i + 1 < value.length &&
        value.charCodeAt(i + 1) >= 0xdc00 &&
        value.charCodeAt(i + 1) <= 0xdfff
      ) {
        encoded = 4;
        i++;
      } else if (c >= 0xd800 && c <= 0xdfff) {
        encoded = 3; // UTF-8 replacement; JSON escapes lone surrogates.
        escaped = 6;
      } else {
        encoded = c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
        escaped = c < 0x20 ? 6 : c === 0x22 || c === 0x5c ? 2 : encoded;
      }
      raw += encoded;
      if (raw > limits.maxStringBytes) {
        throw new CanvasResourceError("maxStringBytes");
      }
      addBytes(escaped || encoded);
    }
  };
  type Frame = {
    value: object;
    keys: Generator<string>;
    depth: number;
    array: boolean;
  };
  const stack: Frame[] = [];
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number) => {
    if (depth > limits.maxDepth) throw new CanvasResourceError("maxDepth");
    if (typeof value === "string") return string(value);
    if (value === null || value === undefined || typeof value === "boolean") {
      addBytes(5);
      return;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      addBytes(24); // upper bound for a finite number's JSON representation
      return;
    }
    if (typeof value !== "object" || value === null) {
      throw new CanvasResourceError("jsonData");
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== (array ? Array.prototype : Object.prototype) &&
      !(prototype === null && !array)
    ) {
      throw new CanvasResourceError("jsonData");
    }
    // Includes non-enumerable toJSON; never invoke serialization hooks.
    const hook = Object.getOwnPropertyDescriptor(value, "toJSON");
    if (hook && (!("value" in hook) || typeof hook.value === "function")) {
      throw new CanvasResourceError("jsonData");
    }
    if (ancestors.has(value)) throw new CanvasResourceError("jsonData");
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, "length")!
        .value as number;
      addEntries(length);
      addBytes(length * 5); // nulls and separators, including sparse slots
    }
    if (depth === 0) {
      for (const key of ["nodes", "edges"] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && !("value" in descriptor))
          throw new CanvasResourceError("jsonData");
        if (Array.isArray(descriptor?.value)) {
          const limit = key === "nodes" ? "maxNodes" : "maxEdges";
          if (descriptor.value.length > limits[limit])
            throw new CanvasResourceError(limit);
        }
      }
    }
    addBytes(2);
    ancestors.add(value);
    stack.push({ value, keys: properties(value), depth, array });
  };
  visit(canvas, 0);
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const next = frame.keys.next();
    if (next.done) {
      ancestors.delete(frame.value);
      stack.pop();
      continue;
    }
    const key = next.value;
    const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
    if (!descriptor) continue; // sparse array slot
    if (!("value" in descriptor)) throw new CanvasResourceError("jsonData");
    if (!frame.array) {
      addEntries(1);
      string(key);
      addBytes(2); // colon and separator (also charged for first property)
    }
    visit(descriptor.value, frame.depth + 1);
  }
}
