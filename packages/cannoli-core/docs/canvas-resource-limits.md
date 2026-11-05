# Canvas admission

`RunArgs.resourceLimits?: Partial<CanvasResourceLimits>` overrides finite defaults.
`CanvasResourceError` is thrown synchronously by `new Run`/`run` (and becomes a
rejection in `resultsRun`) before hashing, JSON copying, schema parsing, secret
resolution, provider construction or persistor wrapping. Resource errors do not
invoke `onFinish`. Constructor and wrapper admission read only the canvas and resource
policy before optional host argument properties; the public wrappers recheck admission
without caching mutable input across host processing. Bounded schema-invalid JSON retains the existing error/stoppage
path. Options are copied and frozen; changing the caller's bag cannot affect a run
or its explicit subcannoli runs. Each child inherits the same policy, independently;
this is not a cumulative execution, graph expansion or concurrency budget.

| Limit | Default | Accounting |
| --- | ---: | --- |
| maxNodes | 1,000 | Root nodes array length, before visiting any element |
| maxEdges | 4,000 | Root edges array length, before visiting any element |
| maxEntries | 100,000 | Total enumerable object properties and array slots, including holes; repeated references counted on each occurrence |
| maxDepth | 64 | Root depth 0; each property/element adds 1, including scalar leaves |
| maxStringBytes | 1,048,576 | Individual key or string UTF-8 bytes, before escaping |
| maxInputBytes | 8,388,608 | Conservative compact JSON UTF-8 upper bound described below |

All supplied values must be positive safe integers: no null, undefined, zero,
Infinity, NaN, fractional or negative disabling sentinel. Depth has an absolute
ceiling of 256 because downstream JSON/schema/engine code can recurse. Other
finite limits may be raised deliberately by trusted hosts; large limits consume
more memory/time. Unknown option names have no effect.

The byte budget charges quotes and UTF-8 JSON escaping (all controls cost 6),
2 bytes per container, 2 bytes per object property for colon/comma (even the first),
5 bytes per array slot for separator/null plus each present value, 24 per finite
number, and 5 per boolean/null/undefined. Thus this is an upper bound, not an
exact file size: whitespace is not represented by object input and numbers/arrays
may be charged more than serialization uses. Lone surrogates cost 3 raw bytes and
6 escaped bytes. Strings are scanned without an input-sized encoded allocation.
The byte counter aborts as soon as the remaining budget is exceeded.

Defaults were selected against all 75 repository `.canvas` fixtures (including
college and plugin examples): maxima 45 nodes, 16 edges, 9,851 file bytes,
479 entries, depth 3, string length 2,288 characters (Python JSON scan). They leave substantial
headroom for saved metadata and larger workflows. The companion's workflow
capture default is 1,000,000 bytes (`mehrpele-cannoli/src/flows/workflow.ts`);
this core envelope is deliberately larger, so a host may retain that stricter
boundary. Neither envelope claims large graph execution is inexpensive.

Admission iterates depth-first with an ancestor set and lazy property iteration:
no recursive walk, child maps, schema visits or async sibling scheduling.
Shared acyclic data is permitted but charged per occurrence, bounding expansion.
Cycles, non-plain prototypes, functions, bigint, symbols as values, non-finite
numbers, enumerable object accessors, array-slot accessors (even non-enumerable), and
own serialization hooks (even non-enumerable) are rejected as non-JSON data without calling
getters or hooks. Undefined values and sparse slots are tolerated with conservative
charges and then normalized by JSON copying. Non-enumerable object fields, extra array properties and symbol
keys are omitted by that copy, so they cannot smuggle uninspected schema inputs.
Unknown enumerable JSON metadata survives within limits; malformed cache fields
still follow the schema's existing omission behavior.

Input must be ordinary data in an uncompromised JS realm. Proxies are not JSON
and cannot be safely identified/inspected without invoking their traps in portable
JavaScript. This API is not a sandbox for hostile executable objects or modified
global prototypes. JS engines may allocate internal enumeration state; the guard
does not allocate a complete key/child list. Host file/network byte caps must run
before JSON materialization where possible; this guard cannot reclaim an object
already allocated by a caller.

This is only the F1 canvas admission foundation. It does not patch Zod, migrate
v3/v4 or legacy dependencies, bound provider/tool/configuration input, provider
response JSON/SSE, execution-generated data, or establish zero-advisory closure.
