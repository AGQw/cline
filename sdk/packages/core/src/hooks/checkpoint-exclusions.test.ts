import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CHECKPOINT_DEFAULT_EXCLUDES,
	CHECKPOINT_EXCLUSIONS_VERSION,
	resolveCheckpointExcludes,
} from "./checkpoint-exclusions";

describe("CHECKPOINT_DEFAULT_EXCLUDES", () => {
	it("excludes media, dependency trees, archives, and ML weights", () => {
		for (const pattern of [
			"*.mp4",
			"*.mov",
			"node_modules/",
			"*.zip",
			"*.safetensors",
			"*.gguf",
		]) {
			expect(CHECKPOINT_DEFAULT_EXCLUDES).toContain(pattern);
		}
	});

	it("does not exclude paths agents author or edit, which legacy excluded", () => {
		// Deliberate divergence from legacy: Reset Code must keep rewinding these.
		for (const pattern of [
			".vscode/",
			".idea/",
			".clinerules/",
			"bin/",
			"build/",
			"env/",
			"temp/",
			"*.lock",
			"*.svg",
		]) {
			expect(CHECKPOINT_DEFAULT_EXCLUDES).not.toContain(pattern);
		}
	});

	it("leaves data, env, and geospatial formats to a separate decision", () => {
		for (const pattern of ["*.csv", "*.sqlite", "*.env*", "*.geojson"]) {
			expect(CHECKPOINT_DEFAULT_EXCLUDES).not.toContain(pattern);
		}
	});

	it("has no duplicate patterns", () => {
		expect(new Set(CHECKPOINT_DEFAULT_EXCLUDES).size).toBe(
			CHECKPOINT_DEFAULT_EXCLUDES.length,
		);
	});
});

describe("resolveCheckpointExcludes", () => {
	let cwd = "";
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "checkpoint-excludes-"));
		execFileSync("git", ["-C", cwd, "init", "-q"]);
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	const excludesFileOf = (args: string[]): string =>
		(args[1] ?? "").replace(/^core\.excludesFile=/, "");

	it("adds nothing for a checkpoint from before exclusions", async () => {
		const withExcludes = await resolveCheckpointExcludes(cwd, undefined);

		expect(await withExcludes(async (args) => args)).toEqual([]);
	});

	it("hands git the defaults merged with the user's own excludes file", async () => {
		const userExcludes = join(cwd, ".git", "user-ignore");
		writeFileSync(userExcludes, "*.secret\n", "utf8");
		execFileSync("git", [
			"-C",
			cwd,
			"config",
			"core.excludesFile",
			userExcludes,
		]);

		const withExcludes = await resolveCheckpointExcludes(
			cwd,
			CHECKPOINT_EXCLUSIONS_VERSION,
		);
		const seen = await withExcludes(async (args) => ({
			args,
			content: readFileSync(excludesFileOf(args), "utf8"),
		}));

		expect(seen.args[0]).toBe("-c");
		expect(seen.content.split("\n")).toEqual(
			expect.arrayContaining(["*.secret", "*.mp4", "node_modules/"]),
		);
		expect(existsSync(excludesFileOf(seen.args))).toBe(false);
	});

	it("uses one set of rules for every command of an operation", async () => {
		// A restore runs several git commands and rewrites tracked files in
		// between. If the rules were re-read, a file the safety snapshot
		// skipped could be deleted by a later cleanup.
		const userExcludes = join(cwd, ".git", "user-ignore");
		writeFileSync(userExcludes, "*.secret\n", "utf8");
		execFileSync("git", [
			"-C",
			cwd,
			"config",
			"core.excludesFile",
			userExcludes,
		]);
		const withExcludes = await resolveCheckpointExcludes(
			cwd,
			CHECKPOINT_EXCLUSIONS_VERSION,
		);

		writeFileSync(userExcludes, "*.other\n", "utf8");
		const content = await withExcludes(async (args) =>
			readFileSync(excludesFileOf(args), "utf8"),
		);

		expect(content).toContain("*.secret");
		expect(content).not.toContain("*.other");
	});

	it("refuses a checkpoint made with a list this build does not know", async () => {
		// Guessing would treat files that checkpoint skipped as created after
		// it, and a restore would delete them.
		await expect(
			resolveCheckpointExcludes(cwd, CHECKPOINT_EXCLUSIONS_VERSION + 1),
		).rejects.toThrow(/newer version/);
	});
});
