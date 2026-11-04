// usage: bun scripts/live/seed-vault.ts
// Creates (or resets) the live test vault under .scratch/live/vault: seed canvases plus
// Cannoli settings for the local Ollama provider (no API key). Re-running rewrites the seed
// canvases, so runs always start from empty output nodes; other vault files are left alone,
// except College/, which is reset to the Cannoli College assets (see the end of this file).
// Env: CANNOLI_LIVE_DIR (default <repo>/.scratch/live), OLLAMA_URL, OLLAMA_MODEL, SEED_COLLEGE.
import { mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const live = process.env.CANNOLI_LIVE_DIR ?? join(root, ".scratch/live");
const vault = join(live, "vault");
const pluginId: string = (await Bun.file(join(root, "manifest.json")).json())
  .id;
const ollamaBaseUrl = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const ollamaModel = process.env.OLLAMA_MODEL ?? "qwen3.5:4b";

for (const d of [".obsidian", `.obsidian/plugins/${pluginId}`, "Smoke"])
  mkdirSync(join(vault, d), { recursive: true });

// Cannoli canvas conventions (packages/cannoli-core/src/factory.ts, Cannoli College "1. Basics"):
// colourless node = AI call node, purple ("6") = content node; a call → content arrow writes the
// response into the content node; a labelled arrow into a call node fills {{label}}.
type Node = {
  id: string;
  type: "text";
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
};
type Edge = {
  id: string;
  fromNode: string;
  fromSide: string;
  toNode: string;
  toSide: string;
  label?: string;
  color?: string;
};
const node = (
  id: string,
  text: string,
  x: number,
  y: number,
  color?: string,
): Node => ({
  id,
  type: "text",
  text,
  x,
  y,
  width: 260,
  height: 120,
  ...(color ? { color } : {}),
});
const edge = (id: string, from: string, to: string, label?: string): Edge => ({
  id,
  fromNode: from,
  fromSide: "right",
  toNode: to,
  toSide: "left",
  ...(label ? { label } : {}),
});

const canvases: Record<string, { nodes: Node[]; edges: Edge[] }> = {
  // (a) content "prompt" → call node → content "output".
  "Smoke/hello.canvas": {
    nodes: [
      node("prompt", "Say hi in 3 words", 0, 0, "6"),
      node("call", "", 360, 0),
      node("output", "", 720, 0, "6"),
    ],
    edges: [edge("e1", "prompt", "call"), edge("e2", "call", "output")],
  },
  // (b) content "topic" → {{topic}} variable arrow → call node → content "output".
  "Smoke/variable.canvas": {
    nodes: [
      node("topic", "cannoli", 0, 0, "6"),
      node("call", "Describe {{topic}} in one short sentence.", 360, 0),
      node("output", "", 720, 0, "6"),
    ],
    edges: [edge("e1", "topic", "call", "topic"), edge("e2", "call", "output")],
  },
};
// (P0.2) a node carrying the engine's `cannoli` metadata field; checks whether Obsidian keeps it on edit.
// Expectations: scripts/live/expect/meta-preserve.json.
canvases["Smoke/meta.canvas"] = {
  nodes: [
    Object.assign(node("probe", "meta probe", 0, 0, "6"), {
      cannoli: { v: 1, probe: "x" },
    }),
  ],
  edges: [],
};
for (const [path, data] of Object.entries(canvases))
  await Bun.write(join(vault, path), JSON.stringify(data, null, "\t"));

// Cannoli settings (packages/cannoli-plugin/src/settings/settings.ts); merged over DEFAULT_SETTINGS on load.
const dataPath = join(vault, `.obsidian/plugins/${pluginId}/data.json`);
const existing = existsSync(dataPath) ? await Bun.file(dataPath).json() : {};
await Bun.write(
  dataPath,
  JSON.stringify(
    {
      ...existing,
      llmProvider: "ollama",
      ollamaBaseUrl,
      ollamaModel,
      ollamaTemperature: 0.7,
      requestThreshold: 20,
      seenVersion2Modal: true,
      seenVersion3Modal: true,
    },
    null,
    2,
  ),
);

const obs = (f: string, v: unknown) =>
  Bun.write(join(vault, ".obsidian", f), JSON.stringify(v, null, 2));
if (!existsSync(join(vault, ".obsidian/app.json")))
  await obs("app.json", { promptDelete: false, alwaysUpdateLinks: true });
if (!existsSync(join(vault, ".obsidian/community-plugins.json")))
  await obs("community-plugins.json", [pluginId]);
if (!existsSync(join(vault, ".obsidian/core-plugins.json")))
  await obs("core-plugins.json", [
    "file-explorer",
    "canvas",
    "command-palette",
    "global-search",
  ]);

console.log(
  JSON.stringify({
    vault,
    canvases: Object.keys(canvases),
    provider: "ollama",
    ollamaBaseUrl,
    ollamaModel,
  }),
);

// ---- College: the 36 Cannoli College canvases (plus their example notes) under College/ ----
// Source: packages/cannoli-plugin/assets/Cannoli College. Runs mutate canvases, so every seed
// rewrites each file from the source and deletes anything else under College/ (pristine reset).
// Env: SEED_COLLEGE=0 skips this section.
if (process.env.SEED_COLLEGE !== "0") {
  const src = join(root, "packages/cannoli-plugin/assets/Cannoli College");
  const dest = join(vault, "College");
  const walk = (dir: string, rel = ""): string[] =>
    readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(dir, join(rel, e.name))
        : e.name === ".DS_Store"
          ? []
          : [join(rel, e.name)],
    );
  const files = walk(src);
  for (const f of files) {
    mkdirSync(join(dest, f, ".."), { recursive: true });
    await Bun.write(join(dest, f), Bun.file(join(src, f)));
  }
  const keep = new Set(files);
  for (const f of walk(dest)) if (!keep.has(f)) rmSync(join(dest, f));
  console.log(
    JSON.stringify({
      college: dest,
      canvases: files.filter((f) => f.endsWith(".canvas")).length,
      files: files.length,
    }),
  );
}
