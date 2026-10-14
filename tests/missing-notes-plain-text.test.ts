import { describe, it, expect } from "vitest";
import { App, TFile } from "obsidian";
import { buildFullGraph, buildLocalGraph, perspectiveLabel } from "../src/graph";
import type { RelationsGraph, RelationsSettings, RelationshipType } from "../src/types";
import { DEFAULT_SETTINGS } from "../src/types";

/**
 * Opt-in: plain-text names (`children: [Oren Miller]`, no [[ ]]) that don't
 * match a note also become faded "missing" nodes. Off by default, so the
 * wikilink-only behavior from issue #18 is unchanged.
 */

interface FakeNote {
	path: string;
	frontmatter: Record<string, unknown>;
	tags?: string[];
}

function makeFakeApp(notes: FakeNote[]): App {
	const files = notes.map((n) => {
		const f = new TFile();
		f.path = n.path;
		f.basename = n.path.replace(/\.md$/, "").split("/").pop() ?? n.path;
		return f;
	});
	const byPath = new Map(files.map((f) => [f.path, f]));
	const byBasename = new Map(files.map((f) => [f.basename.toLowerCase(), f]));
	const byNote = new Map(notes.map((n) => [n.path, n]));

	return {
		vault: {
			getMarkdownFiles: () => files,
			getAbstractFileByPath: (p: string) => byPath.get(p) ?? null,
			getResourcePath: (f: TFile) => `app://${f.path}`,
		},
		metadataCache: {
			getFileCache: (f: TFile) => {
				const n = byNote.get(f.path)!;
				return { frontmatter: n.frontmatter, tags: (n.tags ?? []).map((tag) => ({ tag: `#${tag}` })) };
			},
			getFirstLinkpathDest: (link: string, _from: string) =>
				byBasename.get(link.split("/").pop()!.toLowerCase()) ?? null,
		},
	} as unknown as App;
}

function type(name: string, overrides: Partial<RelationshipType> = {}): RelationshipType {
	return {
		name, color: "#888", symmetric: false, pair: false, treeLayout: false,
		lineStyle: "solid", genealogy: false, ...overrides,
	};
}

function settings(extra: Partial<RelationsSettings> = {}, types = [type("ally")]): RelationsSettings {
	return { ...DEFAULT_SETTINGS, relationshipTypes: types, ...extra };
}

const missing = (g: RelationsGraph) => g.nodes.filter((n) => n.missing);

describe("missing notes for plain-text names", () => {
	it("defaults to off", () => {
		expect(DEFAULT_SETTINGS.showMissingPlainText).toBe(false);
	});

	it("draws an unresolved plain name as a missing node with an edge when on", () => {
		const app = makeFakeApp([{ path: "Varinka.md", frontmatter: { ally: "Oren Miller" } }]);
		const g = buildFullGraph(app, settings({ showMissingPlainText: true }));

		expect(missing(g)).toEqual([{
			id: "missing:oren miller", label: "Oren Miller", tags: [], image: null,
			missing: true, linkText: "Oren Miller", linkSource: "Varinka.md",
		}]);
		expect(g.edges).toHaveLength(1);
		expect(g.edges[0]).toMatchObject({ source: "Varinka.md", target: "missing:oren miller" });
	});

	it("draws nothing for the same input when off (the default)", () => {
		const app = makeFakeApp([{ path: "Varinka.md", frontmatter: { ally: "Oren Miller" } }]);
		expect(buildFullGraph(app, settings()).nodes).toEqual([]);
		expect(buildFullGraph(app, settings({ showMissingPlainText: false })).nodes).toEqual([]);
	});

	it("shares one node between plain and [[wikilink]] forms, ignoring case", () => {
		const app = makeFakeApp([
			{ path: "A.md", frontmatter: { ally: "Callen Miller" } },
			{ path: "B.md", frontmatter: { ally: "[[Callen Miller]]" } },
			{ path: "C.md", frontmatter: { ally: ["callen miller"] } },
		]);
		const g = buildFullGraph(app, settings({ showMissingPlainText: true }));
		expect(missing(g)).toHaveLength(1);
		expect(missing(g)[0].label).toBe("Callen Miller");
		expect(g.edges).toHaveLength(3);
	});

	it("leaves a plain name that matches a real note unchanged", () => {
		const app = makeFakeApp([
			{ path: "A.md", frontmatter: { ally: "Bob" } },
			{ path: "Bob.md", frontmatter: {} },
		]);
		const on = buildFullGraph(app, settings({ showMissingPlainText: true }));
		const off = buildFullGraph(app, settings());
		expect(missing(on)).toEqual([]);
		expect(on.edges[0].target).toBe("Bob.md");
		expect(on).toEqual(off);
	});

	it("shows nothing when showMissingNotes is off, even with the new setting on", () => {
		const app = makeFakeApp([{ path: "A.md", frontmatter: { ally: ["Alice", "[[Bob]]"] } }]);
		const g = buildFullGraph(app, settings({ showMissingNotes: false, showMissingPlainText: true }));
		expect(g.nodes).toEqual([]);
	});

	it("never gives a plain name a nickname", () => {
		const app = makeFakeApp([{ path: "A.md", frontmatter: { ally: "Alice|The Enlightened One" } }]);
		const g = buildLocalGraph(app, settings({ showMissingPlainText: true }), "A.md", 1);
		const [m] = missing(g);
		expect(perspectiveLabel(g, m, "A.md")).toBe("Alice");
	});

	it("stays hidden when required tags are set", () => {
		const app = makeFakeApp([{ path: "A.md", frontmatter: { ally: "Alice" }, tags: ["npc"] }]);
		const g = buildFullGraph(app, settings({ showMissingPlainText: true, requiredTags: ["npc"] }));
		expect(missing(g)).toEqual([]);
	});
});
