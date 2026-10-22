// Run: pnpm test:bundle  (node --test; needs a production build: pnpm build)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
});
