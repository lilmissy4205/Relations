import { App, TFile, CachedMetadata, getAllTags, normalizePath } from "obsidian";
import {
	RelationsGraph,
	GraphNode,
	GraphEdge,
	RelationsSettings,
	RelationshipType,
	StatusRule,
} from "./types";
import { GraphCache } from "./graph-cache";

/**
 * Remove edges whose relationship type is in `disabled`, then drop any node left
 * with no remaining edges. `keepNodeId` (the active/center note, when there is
 * one) is always retained even if it becomes isolated, so the view never goes
 * empty on the very note you're looking at.
 *
 * Pure and side-effect-free — returns a new graph, leaving the input untouched —
 * so it's safe to apply to a cached graph without poisoning the cache. When
 * nothing is disabled it returns the original graph reference unchanged.
 */
export function filterGraphByTypes(
	graph: RelationsGraph,
	disabled: ReadonlySet<string>,
	keepNodeId?: string,
): RelationsGraph {
	if (disabled.size === 0) return graph;

	const edges = graph.edges.filter((e) => !disabled.has(e.type));
	const connected = new Set<string>();
	for (const e of edges) {
		connected.add(e.source);
		connected.add(e.target);
	}
	const nodes = graph.nodes.filter(
		(n) => connected.has(n.id) || n.id === keepNodeId,
	);
	return { nodes, edges };
}

/**
 * Distinct frontmatter property names referenced across a set of Node status
 * rules. This is what `buildNode` needs to know to populate `filterValues` —
 * and, symmetrically, the only part of `statusRules` that belongs in the
 * graph-cache signature (see graph-cache.ts): it determines what gets
 * snapshotted per node. Each rule's value/hide/mute/color is read live on
 * every render instead, so editing those needs no cache bust or rescan.
 */
export function distinctStatusProperties(rules: StatusRule[]): string[] {
	const set = new Set<string>();
	for (const r of rules) {
		const p = r.property?.trim();
		if (p) set.add(p);
	}
	return [...set];
}

/**
 * Extract every element of a frontmatter property's value as trimmed strings,
 * for Node status Hide/Mute matching. Unlike resolveFrontmatterString/
 * resolveRingColor (which take only the first element of a list-valued
 * property — correct for a single ring color or badge), Hide/Mute must catch
 * a match on ANY element: `char_condition: [Charmed, Poisoned]` should match a
 * rule on "Charmed" regardless of list order. Non-string scalars are
 * stringified for consistency with the other resolvers. Empty/blank elements
 * are dropped.
 */
export function nodePropertyValues(
	frontmatter: Record<string, unknown> | undefined,
	propertyName: string,
): string[] {
	const prop = propertyName?.trim();
	if (!prop || !frontmatter) return [];
	const raw: unknown = frontmatter[prop];
	if (raw == null) return [];
	const items: unknown[] = Array.isArray(raw) ? raw : [raw];
	const out: string[] = [];
	for (const item of items) {
		if (item == null) continue;
		const v = String(item).trim();
		if (v) out.push(v);
	}
	return out;
}

/**
 * Group a set of Node status rules' values by property, keeping only rules
 * where `flag` (hide or mute) is set. Used by filterGraphByNodeProperties to
 * build a per-property Set of "any of these values matches" for a quick
 * membership check across possibly-multiple rules sharing a property.
 */
function groupRuleValues(
	rules: StatusRule[],
	flag: "hide" | "mute",
): Map<string, Set<string>> {
	const byProperty = new Map<string, Set<string>>();
	for (const r of rules) {
		if (!r[flag]) continue;
		const prop = r.property?.trim();
		const val = r.value?.trim();
		if (!prop || !val) continue;
		if (!byProperty.has(prop)) byProperty.set(prop, new Set());
		byProperty.get(prop)!.add(val);
	}
	return byProperty;
}

/**
 * Node status "Hide": remove nodes matching any Hide rule (OR across rules —
 * a node hidden by any one rule is hidden), then their edges, then any other
 * node left with no remaining edges (mirrors filterGraphByTypes' pruning).
 * `keepNodeId` is always retained even if hidden or isolated, so the active/
 * center note never disappears from its own view.
 *
 * Matching reads each node's precomputed `filterValues` snapshot (see
 * GraphNode.filterValues) rather than re-deriving from frontmatter — a rule
 * matches if ANY element of the node's value list for that property equals
 * the rule's value.
 *
 * Callers are responsible for skipping this entirely in family-tree/family-
 * graph views — genealogy always shows full lineage, dead ancestors included.
 * See codeblock.ts for where that exemption is applied.
 *
 * Note on issue #28 (github.com/Obsidian-TTRPG-Community/Relations/issues/28):
 * buildLocalGraph/localSubgraph/buildConnectedGraph compute hop-distance
 * membership on the UNFILTERED full graph, before any post-hoc edge/node
 * filter (type filter, and now this one) runs. A node reachable only through
 * an edge this function removes can therefore still render, stranded, with
 * no path back to the center within the original hop window — the same root
 * cause #28 describes for the type filter. This function does NOT attempt to
 * work around that (it would require passing hop-context in here that this
 * pure function doesn't have); it's expected to become moot once #28 is
 * fixed upstream, the same way it will for the type filter.
 *
 * What this function DOES guard against, independent of #28: a node left
 * with literally zero edges once its only neighbor is hidden — mirroring
 * filterGraphByTypes' own pruning, so Hide doesn't strand a note with no
 * relationships at all floating in the graph.
 */
export function filterGraphByNodeProperties(
	graph: RelationsGraph,
	rules: StatusRule[],
	keepNodeId?: string,
): RelationsGraph {
	const hideValues = groupRuleValues(rules, "hide");
	if (hideValues.size === 0) return graph;

	const isHidden = (n: GraphNode): boolean => {
		if (n.id === keepNodeId) return false;
		for (const [prop, values] of hideValues) {
			const nodeValues = n.filterValues?.[prop];
			if (!nodeValues) continue;
			if (nodeValues.some((v) => values.has(v))) return true;
		}
		return false;
	};

	const survivors = graph.nodes.filter((n) => !isHidden(n));
	const survivorIds = new Set(survivors.map((n) => n.id));
	const edges = graph.edges.filter((e) => survivorIds.has(e.source) && survivorIds.has(e.target));

	// Second pass, mirroring filterGraphByTypes exactly: any node left with no
	// remaining edges is pruned too, unless it's the active/center note. This
	// catches a survivor whose only edge(s) went to a hidden node — without
	// it, that survivor would render as a dangling isolated node.
	const connected = new Set<string>();
	for (const e of edges) {
		connected.add(e.source);
		connected.add(e.target);
	}
	const nodes = survivors.filter((n) => connected.has(n.id) || n.id === keepNodeId);
	const kept = new Set(nodes.map((n) => n.id));
	const finalEdges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));
	return { nodes, edges: finalEdges };
}

/**
 * Node status "Mute": flag nodes matching any Mute rule with `muted: true`
 * and the winning rule's `mutedColor`, without ever removing them or their
 * edges. First matching rule wins when multiple rules match the same node
 * (same precedent as resolveRingColor). Returns a new graph — the input is
 * left untouched, so it's safe to apply on top of a cached graph.
 *
 * Applied everywhere, including family-tree/family-graph views — unlike Hide,
 * muting never removes a node so it can never fragment a lineage.
 */
export function applyMutedNodes(
	graph: RelationsGraph,
	rules: StatusRule[],
): RelationsGraph {
	const muteRules = rules.filter((r) => r.mute && r.property?.trim() && r.value?.trim());
	if (muteRules.length === 0) return graph;

	const nodes = graph.nodes.map((n) => {
		for (const r of muteRules) {
			const prop = r.property.trim();
			const val = r.value.trim();
			const nodeValues = n.filterValues?.[prop];
			if (nodeValues && nodeValues.includes(val)) {
				return { ...n, muted: true, mutedColor: r.muteColor };
			}
		}
		return n;
	});
	return { nodes, edges: graph.edges };
}

/**
 * Legend entries for currently-muted nodes. A mute color only shows up here
 * when a muted node bearing that exact color is actually present in `graph`
 * right now — not just because a mute rule with that color exists in
 * settings. Prevents an always-on "Dead" swatch cluttering every graph in a
 * vault where nobody happens to be dead in THIS view.
 *
 * Dedupes by color (first-appearance rule order): if two rules share a mute
 * color, that's a deliberate "these both mean the same visual thing" choice,
 * so one swatch is correct, not two. Label is the rule's value (falls back to
 * its property name, then "Muted", if value is blank).
 */
export function mutedLegendEntries(
	graph: RelationsGraph,
	rules: StatusRule[],
): { label: string; color: string }[] {
	const usedColors = new Set<string>();
	for (const n of graph.nodes) {
		if (n.muted && n.mutedColor) usedColors.add(n.mutedColor);
	}
	if (usedColors.size === 0) return [];

	const seenColors = new Set<string>();
	const entries: { label: string; color: string }[] = [];
	for (const r of rules) {
		if (!r.mute || !r.muteColor) continue;
		if (!usedColors.has(r.muteColor)) continue;
		if (seenColors.has(r.muteColor)) continue;
		seenColors.add(r.muteColor);
		const label = r.value?.trim() || r.property?.trim() || "Muted";
		entries.push({ label, color: r.muteColor });
	}
	return entries;
}

/**
 * Build the full relationship graph by scanning every markdown file in scope.
 *
 * If a `cache` is provided, it's consulted first — a hit returns the previously-
 * built graph immediately without rescanning the vault. On miss, the freshly-built
 * graph is stored. Callers that don't have a cache (or want to force a rebuild)
 * can pass `null` or omit the parameter.
 */
export function buildFullGraph(
	app: App,
	settings: RelationsSettings,
	cache: GraphCache | null = null,
): RelationsGraph {
	if (cache) {
		const hit = cache.get(settings);
		if (hit) return hit;
	}

	const typeMap = buildTypeMap(settings);
	const files = app.vault.getMarkdownFiles().filter((f) => inScope(f, settings));

	const notePaths = new Set<string>();
	const rawEdges: GraphEdge[] = [];

	for (const file of files) {
		const cache = app.metadataCache.getFileCache(file);
		if (!cache) continue;

		if (settings.requiredTags.length > 0 && !hasRequiredTag(cache, settings.requiredTags)) {
			continue;
		}

		const fm = cache.frontmatter;
		if (!fm) continue;

		let hasAnyRelationship = false;

		for (const key of Object.keys(fm)) {
			const type = typeMap.get(key.toLowerCase());
			if (!type) continue;

			const targets = extractLinkTargets(fm[key]);
			for (const target of targets) {
				const resolved = app.metadataCache.getFirstLinkpathDest(target, file.path);
				if (!resolved) continue;
				if (resolved.path === file.path) continue;
				if (!inScope(resolved, settings)) continue;

				// Genealogy edges are stored child→parent throughout the data
				// model (matching a `parent: [[X]]` declaration written on the
				// child's note). A declares-child type — `children: [[Kid]]`
				// written on the PARENT's note — arrives parent→child, so swap
				// it here at scan time. Everything downstream (family layouts,
				// co-parent inference, the render-layer arrow inversion) assumes
				// the child→parent convention. The type's own name is kept:
				// rewriting to a synthetic type would break every by-name lookup
				// (filtering, legend, symmetric handling, edge-label keys).
				let edgeSource = file.path;
				let edgeTarget = resolved.path;
				if (type.genealogy && type.declaresChild) {
					[edgeSource, edgeTarget] = [edgeTarget, edgeSource];
				}

				rawEdges.push({
					source: edgeSource,
					target: edgeTarget,
					type: type.name,
					color: type.color,
					symmetric: type.symmetric,
					pair: type.pair,
					lineStyle: type.lineStyle,
					genealogy: type.genealogy,
				});
				hasAnyRelationship = true;
				notePaths.add(file.path);
				notePaths.add(resolved.path);
			}
		}

		if (hasAnyRelationship) notePaths.add(file.path);
	}

	if (settings.requiredTags.length > 0) {
		for (const path of Array.from(notePaths)) {
			const f = app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) { notePaths.delete(path); continue; }
			const cache = app.metadataCache.getFileCache(f);
			if (!cache || !hasRequiredTag(cache, settings.requiredTags)) {
				notePaths.delete(path);
			}
		}
	}

	const nodes: GraphNode[] = [];
	for (const path of notePaths) {
		const f = app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) continue;
		const node = buildNode(app, f, settings);
		if (node) nodes.push(node);
	}

	const edges = dedupeEdges(rawEdges.filter(
		(e) => notePaths.has(e.source) && notePaths.has(e.target),
	));

	const result = { nodes, edges };
	if (cache) cache.set(settings, result);
	return result;
}

/**
 * Build a graph centered on a single file, expanding outward by `depth` hops.
 * BFS over the full graph's edge set.
 *
 * Both nodes AND edges respect the hop limit. A node is included when it is
 * within `depth` hops of the center; an edge is included only when it can be
 * reached within `depth` hops — i.e. its nearer endpoint is strictly closer
 * than `depth`. Traversing an edge from a node N hops out is hop N+1, so an
 * edge between two nodes that are both exactly `depth` hops away is NOT shown:
 * at depth 1 you see the center and its own relationships (hub-and-spoke),
 * not the cross-links between the center's neighbors — those belong to depth 2.
 *
 * The full graph is fetched via the same cache as `buildFullGraph` — local-graph
 * calls from multiple embeds on the same page reuse one scan.
 */
export function buildLocalGraph(
	app: App,
	settings: RelationsSettings,
	centerPath: string,
	depth: number,
	cache: GraphCache | null = null,
): RelationsGraph {
	const full = buildFullGraph(app, settings, cache);
	if (!full.nodes.some((n) => n.id === centerPath)) {
		// Center note isn't connected — return just it (if it exists) so the view can show "no relationships yet"
		const f = app.vault.getAbstractFileByPath(centerPath);
		if (f instanceof TFile) {
			const node = buildNode(app, f, settings);
			return { nodes: node ? [node] : [], edges: [] };
		}
		return { nodes: [], edges: [] };
	}

	return localSubgraph(full, centerPath, depth);
}

/**
 * Filter a graph to the neighborhood within `depth` hops of centerPath.
 * Pure function — no app/vault access — for testability.
 *
 * See `buildLocalGraph` for the hop semantics: nodes at distance <= depth,
 * edges whose nearer endpoint is at distance < depth.
 */
export function localSubgraph(
	full: RelationsGraph,
	centerPath: string,
	depth: number,
): RelationsGraph {
	if (depth < 0) depth = 0;
	if (!full.nodes.some((n) => n.id === centerPath)) {
		return { nodes: [], edges: [] };
	}

	// adjacency map (undirected for traversal purposes — we want hops regardless of edge direction)
	const adj = new Map<string, Set<string>>();
	for (const e of full.edges) {
		if (!adj.has(e.source)) adj.set(e.source, new Set());
		if (!adj.has(e.target)) adj.set(e.target, new Set());
		adj.get(e.source)!.add(e.target);
		adj.get(e.target)!.add(e.source);
	}

	const visited = new Map<string, number>(); // path -> distance
	visited.set(centerPath, 0);
	let frontier: string[] = [centerPath];
	for (let d = 1; d <= depth; d++) {
		const next: string[] = [];
		for (const cur of frontier) {
			const neighbors = adj.get(cur);
			if (!neighbors) continue;
			for (const nb of neighbors) {
				if (visited.has(nb)) continue;
				visited.set(nb, d);
				next.push(nb);
			}
		}
		frontier = next;
		if (frontier.length === 0) break;
	}

	const includedPaths = new Set(visited.keys());
	const nodes = full.nodes.filter((n) => includedPaths.has(n.id));
	// An edge is reachable in `depth` hops only if its nearer endpoint is
	// closer than `depth` (crossing the edge is one more hop). This drops
	// cross-links between two outermost-ring nodes, so depth 1 renders as
	// hub-and-spoke instead of the full induced subgraph.
	const edges = full.edges.filter((e) => {
		const ds = visited.get(e.source);
		const dt = visited.get(e.target);
		if (ds === undefined || dt === undefined) return false;
		return Math.min(ds, dt) < depth;
	});

	return { nodes, edges };
}

/**
 * Filter a graph to only the connected component containing centerPath.
 * Pure function — no app/vault access — for testability.
 *
 * If centerPath isn't a node in the graph, returns an empty graph.
 * Otherwise returns the subgraph of all nodes reachable from centerPath
 * (via any edge, treated as undirected) plus all edges between them.
 */
export function connectedComponent(
	graph: RelationsGraph,
	centerPath: string,
): RelationsGraph {
	if (!graph.nodes.some((n) => n.id === centerPath)) {
		return { nodes: [], edges: [] };
	}
	const adj = new Map<string, Set<string>>();
	for (const e of graph.edges) {
		if (!adj.has(e.source)) adj.set(e.source, new Set());
		if (!adj.has(e.target)) adj.set(e.target, new Set());
		adj.get(e.source)!.add(e.target);
		adj.get(e.target)!.add(e.source);
	}
	const visited = new Set<string>([centerPath]);
	const queue: string[] = [centerPath];
	while (queue.length > 0) {
		const cur = queue.shift()!;
		const neighbors = adj.get(cur);
		if (!neighbors) continue;
		for (const nb of neighbors) {
			if (visited.has(nb)) continue;
			visited.add(nb);
			queue.push(nb);
		}
	}
	return {
		nodes: graph.nodes.filter((n) => visited.has(n.id)),
		edges: graph.edges.filter((e) => visited.has(e.source) && visited.has(e.target)),
	};
}

/**
 * Build a graph containing every note reachable from a focus note via any
 * relationship edge. Equivalent to the connected component of the full graph
 * containing centerPath. No depth limit — walks until the queue is exhausted.
 *
 * Use case: a user looking at one character wants to see "everyone whose lives
 * touch theirs, however distantly," without including unrelated family trees
 * elsewhere in the vault. Different from `full` (which shows every note in
 * the vault including disconnected islands) and from `local` (which bounds
 * by hop count).
 *
 * Edge types are not filtered — any edge counts as a connection. A long
 * chain through friends-of-friends or mentor-of-rival will still be followed.
 * For tightly-bounded vaults this is the right thing; for vaults with lots
 * of weak side-relationships the connected component may grow large.
 */
export function buildConnectedGraph(
	app: App,
	settings: RelationsSettings,
	centerPath: string,
	cache: GraphCache | null = null,
): RelationsGraph {
	const full = buildFullGraph(app, settings, cache);
	if (!full.nodes.some((n) => n.id === centerPath)) {
		// Center note isn't part of any relationship — return just the focus note
		// (if it exists on disk) so the view can render a "no relationships yet" state.
		const f = app.vault.getAbstractFileByPath(centerPath);
		if (f instanceof TFile) {
			const node = buildNode(app, f, settings);
			return { nodes: node ? [node] : [], edges: [] };
		}
		return { nodes: [], edges: [] };
	}
	return connectedComponent(full, centerPath);
}

/**
 * Build a graph containing only the genealogy/partner neighbourhood of a focus
 * note: ancestors (transitively up the parent chain), descendants (transitively
 * down through children of children), and partners of anyone in that set.
 *
 * Used by family-graph mode. Without this, family-graph would show every
 * connected person in the vault — fine for "show me the whole dynasty" but
 * overwhelming when the user is looking at one character and just wants to see
 * who's their parent, who's their kid, and who their partners are.
 *
 * Allies, enemies, mentors etc. are dropped — those don't contribute to the
 * who-had-children-with-whom view that family-graph is for.
 */
export function buildFamilyNeighborhood(
	app: App,
	settings: RelationsSettings,
	focusPath: string,
	depth?: number,
	cache: GraphCache | null = null,
): RelationsGraph {
	const full = buildFullGraph(app, settings, cache);

	if (!full.nodes.some((n) => n.id === focusPath)) {
		const f = app.vault.getAbstractFileByPath(focusPath);
		if (f instanceof TFile) {
			const node = buildNode(app, f, settings);
			return { nodes: node ? [node] : [], edges: [] };
		}
		return { nodes: [], edges: [] };
	}

	return filterFamilyNeighborhood(full, focusPath, depth);
}

export function filterFamilyNeighborhood(
	full: RelationsGraph,
	focusPath: string,
	depth?: number,
): RelationsGraph {
	if (!full.nodes.some((n) => n.id === focusPath)) {
		return { nodes: [], edges: [] };
	}

	const childrenOf = new Map<string, Set<string>>();
	const parentsOf = new Map<string, Set<string>>();
	const partnersOf = new Map<string, Set<string>>();

	for (const e of full.edges) {
		if (e.genealogy) {
			if (!parentsOf.has(e.source)) parentsOf.set(e.source, new Set());
			if (!childrenOf.has(e.target)) childrenOf.set(e.target, new Set());
			parentsOf.get(e.source)!.add(e.target);
			childrenOf.get(e.target)!.add(e.source);
		}
		if (e.pair) {
			if (!partnersOf.has(e.source)) partnersOf.set(e.source, new Set());
			if (!partnersOf.has(e.target)) partnersOf.set(e.target, new Set());
			partnersOf.get(e.source)!.add(e.target);
			partnersOf.get(e.target)!.add(e.source);
		}
	}

	const maxGen = (depth != null && depth >= 0) ? depth : Infinity;
	const included = new Set<string>([focusPath]);
	let ancestorFrontier: string[] = [focusPath];
	for (let gen = 0; gen < maxGen && ancestorFrontier.length > 0; gen++) {
		const next: string[] = [];
		for (const cur of ancestorFrontier) {
			const parents = parentsOf.get(cur);
			if (!parents) continue;
			for (const p of parents) {
				if (included.has(p)) continue;
				included.add(p);
				next.push(p);
			}
		}
		ancestorFrontier = next;
	}
	let descendantFrontier: string[] = [focusPath];
	for (let gen = 0; gen < maxGen && descendantFrontier.length > 0; gen++) {
		const next: string[] = [];
		for (const cur of descendantFrontier) {
			const children = childrenOf.get(cur);
			if (!children) continue;
			for (const c of children) {
				if (included.has(c)) continue;
				included.add(c);
				next.push(c);
			}
		}
		descendantFrontier = next;
	}

	const focusFamily = new Set(included);
	for (const personId of focusFamily) {
		const kids = childrenOf.get(personId);
		if (!kids) continue;
		for (const kid of kids) {
			const kidParents = parentsOf.get(kid);
			if (!kidParents) continue;
			for (const coParent of kidParents) {
				included.add(coParent);
			}
		}
	}

	for (const personId of [...included]) {
		const partners = partnersOf.get(personId);
		if (!partners) continue;
		for (const p of partners) included.add(p);
	}

	const nodes = full.nodes.filter((n) => included.has(n.id));
	const edges = full.edges.filter(
		(e) => (e.genealogy || e.pair) && included.has(e.source) && included.has(e.target),
	);

	return { nodes, edges };
}

function buildTypeMap(settings: RelationsSettings): Map<string, RelationshipType> {
	const m = new Map<string, RelationshipType>();
	for (const t of settings.relationshipTypes) m.set(t.name.toLowerCase(), t);
	return m;
}

function buildNode(
	app: App,
	file: TFile,
	settings: RelationsSettings,
): GraphNode | null {
	const cache = app.metadataCache.getFileCache(file);
	const tags = cache ? (getAllTags(cache) ?? []) : [];
	const image = resolveImage(app, file, settings, cache);
	const fm = cache?.frontmatter;
	const ringColor = resolveRingColor(settings, fm);
	const topLeftIcon = resolveFrontmatterString(fm, settings.topLeftIconProperty);
	const topRightIcon = resolveFrontmatterString(fm, settings.topRightIconProperty);
	const bottomLeftIcon = resolveFrontmatterString(fm, settings.bottomLeftIconProperty);
	const bottomRightIcon = resolveFrontmatterString(fm, settings.bottomRightIconProperty);
	const subtext = resolveFrontmatterString(fm, settings.subtextProperty);
	const node: GraphNode = {
		id: file.path,
		label: file.basename,
		tags,
		image,
	};
	if (ringColor) node.ringColor = ringColor;
	if (topLeftIcon) node.topLeftIcon = topLeftIcon;
	if (topRightIcon) node.topRightIcon = topRightIcon;
	if (bottomLeftIcon) node.bottomLeftIcon = bottomLeftIcon;
	if (bottomRightIcon) node.bottomRightIcon = bottomRightIcon;
	if (subtext) node.subtext = subtext;

	const statusProps = distinctStatusProperties(settings.statusRules);
	if (statusProps.length > 0) {
		const filterValues: Record<string, string[]> = {};
		for (const prop of statusProps) {
			const values = nodePropertyValues(fm, prop);
			if (values.length > 0) filterValues[prop] = values;
		}
		if (Object.keys(filterValues).length > 0) node.filterValues = filterValues;
	}
	return node;
}

/**
 * Generic frontmatter-string resolver used by the node-badge features
 * (top-left icon, top-right icon, subtext). Returns the trimmed string value
 * of the property, or undefined if any of: property name is blank, property
 * isn't set, the value is array-or-scalar coerces to empty.
 *
 * Coercion matches resolveRingColor for consistency: arrays take their first
 * element; non-string scalars (numbers, booleans) are stringified; whitespace
 * is trimmed. The badge layer renders the result as text — emoji, abbreviation,
 * short title, whatever the user typed.
 */
export function resolveFrontmatterString(
	frontmatter: Record<string, unknown> | undefined,
	propertyName: string,
): string | undefined {
	const prop = propertyName?.trim();
	if (!prop) return undefined;
	if (!frontmatter) return undefined;
	const raw: unknown = frontmatter[prop];
	if (raw == null) return undefined;
	const first: unknown = Array.isArray(raw) ? raw[0] : raw;
	if (first == null) return undefined;
	const value = String(first).trim();
	if (!value) return undefined;
	return value;
}

/**
 * Resolve the ring color for a node based on settings.ringColorProperty and
 * settings.ringColorRules. Returns the matched color, or undefined if no rule
 * applies (feature disabled, property missing, value doesn't match any rule).
 *
 * Frontmatter values come in as strings, arrays, numbers, or booleans — we
 * coerce to a single string and trim before comparing. Array-valued properties
 * use the first element (multi-value matching would need a different settings
 * shape to express). Comparison is case-sensitive on purpose: users typing
 * `Enemy` vs `enemy` may genuinely intend different categories, and we shouldn't
 * silently collapse them. Users who want case-insensitive matching can lowercase
 * their rule values.
 */
export function resolveRingColor(
	settings: RelationsSettings,
	frontmatter: Record<string, unknown> | undefined,
): string | undefined {
	const prop = settings.ringColorProperty?.trim();
	if (!prop) return undefined;
	if (!settings.ringColorRules || settings.ringColorRules.length === 0) return undefined;
	if (!frontmatter) return undefined;
	const raw: unknown = frontmatter[prop];
	if (raw == null) return undefined;
	const first: unknown = Array.isArray(raw) ? raw[0] : raw;
	if (first == null) return undefined;
	const value = String(first).trim();
	if (!value) return undefined;
	for (const rule of settings.ringColorRules) {
		if (rule.value.trim() === value) {
			const c = rule.color?.trim();
			if (c) return c;
		}
	}
	return undefined;
}

/**
 * Resolve the portrait image for a node.
 * Accepts:
 *   - "[[portrait.png]]"   wikilink to a vault image
 *   - "portrait.png"       vault path (relative or absolute)
 *   - "https://..."        external URL
 *   - "data:image/..."     data URL
 * Returns a resource URL Cytoscape can load, or null.
 */
function resolveImage(
	app: App,
	file: TFile,
	settings: RelationsSettings,
	cache: CachedMetadata | null,
): string | null {
	const fm = cache?.frontmatter;
	if (!fm) return null;
	const raw: unknown = fm[settings.imageProperty];
	if (raw == null) return null;

	const value: unknown = Array.isArray(raw) ? raw[0] : raw;
	if (typeof value !== "string") return null;
	const v = value.trim();
	if (!v) return null;

	// External URL or data URL — pass through
	if (/^(https?:|data:)/i.test(v)) return v;

	// Wikilink form: [[file.png]] or [[file.png|alt]]
	const wikiMatch = v.match(/^\[\[([^\]]+)\]\]$/);
	const linkPath = wikiMatch ? stripAlias(wikiMatch[1]) : v;

	// Resolve via Obsidian's link resolver (handles relative paths)
	const resolved = app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
	if (resolved instanceof TFile) {
		return app.vault.getResourcePath(resolved);
	}

	// Fallback: try as a literal vault path
	const direct = app.vault.getAbstractFileByPath(normalizePath(linkPath));
	if (direct instanceof TFile) {
		return app.vault.getResourcePath(direct);
	}

	return null;
}

function inScope(file: TFile, settings: RelationsSettings): boolean {
	if (settings.folderScopes.length === 0) return true;
	return settings.folderScopes.some((folder) => {
		const normalized = folder.endsWith("/") ? folder : folder + "/";
		return file.path.startsWith(normalized) || file.path === folder;
	});
}

function hasRequiredTag(cache: CachedMetadata, requiredTags: string[]): boolean {
	const tags = getAllTags(cache) ?? [];
	const normalized = tags.map((t) => t.replace(/^#/, "").toLowerCase());
	return requiredTags.some((req) => {
		const r = req.replace(/^#/, "").toLowerCase();
		return normalized.includes(r);
	});
}

export function extractLinkTargets(value: unknown): string[] {
	if (value == null) return [];
	if (Array.isArray(value)) {
		return value.flatMap((v) => extractLinkTargets(v));
	}
	if (typeof value !== "string") return [];

	const s = value.trim();
	if (!s) return [];

	const wikiRegex = /\[\[([^\]]+)\]\]/g;
	const matches = [...s.matchAll(wikiRegex)];
	if (matches.length > 0) {
		return matches.map((m) => stripAlias(m[1]));
	}

	if (s.includes(",")) {
		return s.split(",").map((part) => stripAlias(part.trim())).filter(Boolean);
	}

	return [stripAlias(s)];
}

export function stripAlias(link: string): string {
	const pipeIdx = link.indexOf("|");
	if (pipeIdx >= 0) link = link.slice(0, pipeIdx);
	const hashIdx = link.indexOf("#");
	if (hashIdx >= 0) link = link.slice(0, hashIdx);
	return link.trim();
}

export function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
	const seen = new Set<string>();
	const out: GraphEdge[] = [];
	for (const e of edges) {
		let key: string;
		if (e.genealogy) {
			// A parent-child bond is one fact no matter how many notes declare
			// it or under which genealogy type name. After declares-child
			// normalization, "Varinka declares `parents: [[Amalayin]]`" and
			// "Amalayin declares `children: [[Varinka]]`" both arrive here as
			// Varinka→Amalayin — but with different type names, which the
			// per-type keys below would keep as two parallel edges (issue #21).
			// Key genealogy edges on the directed pair alone; first wins.
			key = `gen|${e.source}|${e.target}`;
		} else if (e.symmetric) {
			const [a, b] = [e.source, e.target].sort();
			key = `sym|${e.type}|${a}|${b}`;
		} else {
			key = `dir|${e.type}|${e.source}|${e.target}`;
		}
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(e);
	}
	return out;
}
