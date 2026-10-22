// Run: pnpm test:bundle  (node --test; needs a production build: pnpm build)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkBundle, evaluate, readBudget } from "./check-bundle.mjs";

describe("check-bundle", () => {
	it("main.js within budget", () => {
		const result = checkBundle();
		assert.ok(result.ok, result.message);
	});

	it("fails when the bundle is over budget", () => {
		const budget = readBudget();
		const result = evaluate(budget.maxBytes + 1, budget);
		assert.equal(result.ok, false);
		assert.match(result.message, /over budget/);
	});

	it("passes at exactly the budget", () => {
		const budget = readBudget();
		assert.equal(evaluate(budget.maxBytes, budget).ok, true);
	});

	it("fails clearly when main.js is missing", () => {
		const result = checkBundle({ bundlePath: "does/not/exist/main.js" });
		assert.equal(result.ok, false);
		assert.match(result.message, /not found/);
	});

	it("runs as CLI through a symlinked path", () => {
		const script = join(dirname(fileURLToPath(import.meta.url)), "check-bundle.mjs");
		const dir = mkdtempSync(join(tmpdir(), "check-bundle-link-"));
		try {
			const link = join(dir, "check-bundle.mjs");
			symlinkSync(script, link);
			const run = spawnSync(process.execPath, [link], { encoding: "utf8" });
			assert.equal(run.status, 0, run.stderr || run.stdout);
			assert.match(run.stdout, /check-bundle OK:/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
