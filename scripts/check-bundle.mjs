#!/usr/bin/env node
// Fails if the built plugin bundle (main.js at the repo root) is bigger than the budget in
// scripts/bundle-budget.json. Usage: `pnpm build && pnpm check:bundle` (DESIGN §13.3).
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultBudgetPath = join(repoRoot, "scripts", "bundle-budget.json");

export function readBudget(budgetPath = defaultBudgetPath) {
	const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
	if (!Number.isInteger(budget.maxBytes) || budget.maxBytes <= 0) {
		throw new Error(`${budgetPath}: maxBytes must be a positive integer`);
	}
	return budget;
}

const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

export function evaluate(sizeBytes, budget) {
	const delta = sizeBytes - budget.maxBytes;
	const pct = ((sizeBytes / budget.maxBytes) * 100).toFixed(1);
	const ok = delta <= 0;
	const message = ok
		? `${budget.file}: ${sizeBytes} bytes (${kb(sizeBytes)}), ${pct}% of budget ${budget.maxBytes}`
		: `${budget.file}: ${sizeBytes} bytes is over budget ${budget.maxBytes} by ${delta} bytes (${kb(delta)})`;
	return { ok, sizeBytes, maxBytes: budget.maxBytes, message };
}

export function checkBundle({ bundlePath, budgetPath = defaultBudgetPath } = {}) {
	const budget = readBudget(budgetPath);
	const file = bundlePath ?? join(repoRoot, budget.file);
	if (!existsSync(file)) {
		return {
			ok: false,
			message: `${relative(repoRoot, file)} not found; run \`pnpm build\` first`,
		};
	}
	return evaluate(statSync(file).size, budget);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const result = checkBundle();
	console.log(`${result.ok ? "check-bundle OK" : "check-bundle FAIL"}: ${result.message}`);
	process.exit(result.ok ? 0 : 1);
}
