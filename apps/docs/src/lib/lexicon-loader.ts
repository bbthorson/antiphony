/**
 * Build-time loader for the canonical AT Protocol lexicon documents under
 * `lexicons/dev/antiphony/**\/*.json`.
 *
 * Reading the JSON files directly at Astro build time keeps the docs site
 * locked to the source of truth with zero manual duplication.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GITHUB_LEXICON_BASE = 'https://github.com/bbthorson/antiphony/blob/master/lexicons';

export type LexiconKind = 'record' | 'query' | 'procedure' | 'embed' | 'defs';

export type LexiconGroupId =
	| 'records-and-embeds'
	| 'hosted-audio-xrpc'
	| 'remote-posts-xrpc'
	| 'tenancy-and-server-xrpc'
	| 'shared-defs';

export interface TypeRefLink {
	label: string;
	href?: string;
}

export interface LexiconFieldRow {
	name: string;
	required: boolean;
	typeLabel: string;
	refs: TypeRefLink[];
	constraints: string[];
	description: string;
}

export interface LexiconErrorRow {
	name: string;
	description: string;
}

export interface LexiconBodyView {
	encoding: string;
	description?: string;
	schemaRef?: TypeRefLink;
	fields: LexiconFieldRow[];
}

export interface LexiconSubDefView {
	name: string;
	anchorId: string;
	type: string;
	description?: string;
	fields: LexiconFieldRow[];
}

export interface LexiconDocView {
	id: string;
	anchorId: string;
	kind: LexiconKind;
	kindLabel: string;
	httpMethod?: 'GET' | 'POST';
	xrpcPath?: string;
	recordKey?: string;
	description: string;
	mainDescription?: string;
	githubUrl: string;
	relativePath: string;
	parameters: LexiconFieldRow[];
	input?: LexiconBodyView;
	output?: LexiconBodyView;
	recordFields: LexiconFieldRow[];
	errors: LexiconErrorRow[];
	subDefs: LexiconSubDefView[];
}

export interface LexiconGroup {
	id: LexiconGroupId;
	title: string;
	summary: string;
	docs: LexiconDocView[];
}

export interface LexiconCatalog {
	groups: Record<LexiconGroupId, LexiconGroup>;
	allDocs: LexiconDocView[];
	counts: {
		total: number;
		xrpc: number;
		queries: number;
		procedures: number;
		recordsAndEmbeds: number;
		sharedDefs: number;
	};
}

interface RawLexiconProperty {
	type?: string;
	format?: string;
	description?: string;
	ref?: string;
	refs?: string[];
	items?: RawLexiconProperty;
	knownValues?: string[];
	enum?: string[];
	const?: string;
	default?: unknown;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	maxGraphemes?: number;
	maxSize?: number;
	accept?: string[];
}

interface RawLexiconObject {
	type?: string;
	description?: string;
	required?: string[];
	nullable?: string[];
	properties?: Record<string, RawLexiconProperty>;
	ref?: string;
	refs?: string[];
}

interface RawLexiconDef {
	type: string;
	description?: string;
	key?: string;
	record?: RawLexiconObject;
	parameters?: RawLexiconObject;
	input?: {
		encoding: string;
		description?: string;
		schema?: RawLexiconObject;
	};
	output?: {
		encoding: string;
		description?: string;
		schema?: RawLexiconObject;
	};
	errors?: Array<{ name: string; description?: string }>;
	required?: string[];
	properties?: Record<string, RawLexiconProperty>;
}

interface RawLexiconDoc {
	lexicon: number;
	id: string;
	description?: string;
	defs: Record<string, RawLexiconDef>;
}

const CURATED_GROUPS: Record<
	LexiconGroupId,
	{ title: string; summary: string; order: string[] }
> = {
	'records-and-embeds': {
		title: 'Records & embeds',
		summary:
			'Stored AT Protocol record schemas and audio embed attachments. These shapes enter content-addressed record CIDs.',
		order: [
			'dev.antiphony.audio.post',
			'dev.antiphony.audio.transcript',
			'dev.antiphony.embed.audio',
			'dev.antiphony.embed.recordWithAudio',
			'dev.antiphony.actor.profile',
		],
	},
	'hosted-audio-xrpc': {
		title: 'Hosted audio XRPC',
		summary:
			'Queries and procedures for audio posts hosted in a tenant repository on Antiphony.',
		order: [
			'dev.antiphony.audio.getPost',
			'dev.antiphony.audio.getThread',
			'dev.antiphony.audio.listPosts',
			'dev.antiphony.audio.getPlaybackUrl',
			'dev.antiphony.audio.uploadAudio',
			'dev.antiphony.audio.createPost',
			'dev.antiphony.audio.reprocessPost',
			'dev.antiphony.audio.deletePost',
			'dev.antiphony.audio.eraseAuthor',
		],
	},
	'remote-posts-xrpc': {
		title: 'Remote posts XRPC',
		summary:
			'Queries and procedures for registering, reading, and managing audio posts held in external AT Protocol repositories.',
		order: [
			'dev.antiphony.audio.registerPost',
			'dev.antiphony.audio.getRemotePost',
			'dev.antiphony.audio.getRemotePosts',
			'dev.antiphony.audio.getRemoteThread',
			'dev.antiphony.audio.listRemotePosts',
			'dev.antiphony.audio.reprocessRemotePost',
			'dev.antiphony.audio.unregisterPost',
			'dev.antiphony.audio.recheckRemoteSpace',
		],
	},
	'tenancy-and-server-xrpc': {
		title: 'Tenancy & server XRPC',
		summary: 'Service discovery and tenant-scoped operational statistics.',
		order: ['dev.antiphony.server.describeServer', 'dev.antiphony.tenant.getStats'],
	},
	'shared-defs': {
		title: 'Shared definitions',
		summary:
			'Reusable read-time views and request objects referenced across the XRPC surface.',
		order: ['dev.antiphony.audio.defs', 'dev.antiphony.tenant.defs'],
	},
};

function makeAnchorId(nsid: string, defName?: string): string {
	return defName && defName !== 'main' ? `${nsid}--${defName}` : nsid;
}

function makeRefLink(rawRef: string, currentNsid: string): TypeRefLink {
	if (rawRef.startsWith('#')) {
		const defName = rawRef.slice(1);
		return {
			label: rawRef,
			href: `#${makeAnchorId(currentNsid, defName)}`,
		};
	}

	const [nsid, defName] = rawRef.split('#');
	if (nsid.startsWith('dev.antiphony.')) {
		const shortLabel = rawRef.replace(/^dev\.antiphony\./, '');
		return {
			label: shortLabel,
			href: `#${makeAnchorId(nsid, defName)}`,
		};
	}

	return { label: rawRef };
}

function formatBytes(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	if (Number.isInteger(mb) && mb >= 1) return `${mb} MB`;
	const kb = bytes / 1024;
	if (Number.isInteger(kb) && kb >= 1) return `${kb} KB`;
	return `${bytes} B`;
}

function describeProperty(
	prop: RawLexiconProperty,
	currentNsid: string
): { typeLabel: string; refs: TypeRefLink[]; constraints: string[] } {
	const refs: TypeRefLink[] = [];
	const constraints: string[] = [];
	const type = prop.type ?? 'unknown';

	let typeLabel = type;
	if (type === 'string') {
		typeLabel = prop.format ? `string (${prop.format})` : 'string';
	} else if (type === 'ref' && prop.ref) {
		const link = makeRefLink(prop.ref, currentNsid);
		refs.push(link);
		typeLabel = 'ref';
	} else if (type === 'union' && prop.refs) {
		for (const r of prop.refs) {
			refs.push(makeRefLink(r, currentNsid));
		}
		typeLabel = 'union';
	} else if (type === 'array') {
		if (prop.items) {
			const inner = describeProperty(prop.items, currentNsid);
			refs.push(...inner.refs);
			if (inner.typeLabel === 'ref' && inner.refs.length === 1) {
				typeLabel = 'array<ref>';
			} else if (inner.typeLabel === 'union') {
				typeLabel = 'array<union>';
			} else {
				typeLabel = `array<${inner.typeLabel}>`;
			}
			constraints.push(...inner.constraints.map((c) => `item ${c}`));
		} else {
			typeLabel = 'array';
		}
	} else if (type === 'blob') {
		typeLabel = 'blob';
		if (prop.accept?.length) constraints.push(`accept: ${prop.accept.join(', ')}`);
		if (prop.maxSize !== undefined) constraints.push(`max ${formatBytes(prop.maxSize)}`);
	}

	if (prop.knownValues?.length) {
		constraints.push(`values: ${prop.knownValues.join(' | ')}`);
	}
	if (prop.enum?.length) {
		constraints.push(`enum: ${prop.enum.join(' | ')}`);
	}
	if (prop.const !== undefined) {
		constraints.push(`const: ${prop.const}`);
	}
	if (prop.minimum !== undefined && prop.maximum !== undefined) {
		constraints.push(`${prop.minimum}..${prop.maximum}`);
	} else if (prop.minimum !== undefined) {
		constraints.push(`min ${prop.minimum}`);
	} else if (prop.maximum !== undefined) {
		constraints.push(`max ${prop.maximum}`);
	}
	if (prop.minLength !== undefined) {
		constraints.push(`minLength ${prop.minLength}`);
	}
	if (prop.maxLength !== undefined) {
		constraints.push(`maxLength ${prop.maxLength}`);
	}
	if (prop.maxGraphemes !== undefined) {
		constraints.push(`maxGraphemes ${prop.maxGraphemes}`);
	}
	if (prop.default !== undefined) {
		constraints.push(`default: ${JSON.stringify(prop.default)}`);
	}

	return { typeLabel, refs, constraints };
}

function extractFields(
	obj: RawLexiconObject | undefined,
	currentNsid: string
): LexiconFieldRow[] {
	if (!obj?.properties) return [];
	const requiredSet = new Set(obj.required ?? []);
	return Object.entries(obj.properties).map(([name, prop]) => {
		const { typeLabel, refs, constraints } = describeProperty(prop, currentNsid);
		return {
			name,
			required: requiredSet.has(name),
			typeLabel,
			refs,
			constraints,
			description: prop.description ?? '',
		};
	});
}

function extractBody(
	body: { encoding: string; description?: string; schema?: RawLexiconObject } | undefined,
	currentNsid: string
): LexiconBodyView | undefined {
	if (!body) return undefined;
	const schema = body.schema;
	const schemaRef =
		schema?.type === 'ref' && schema.ref ? makeRefLink(schema.ref, currentNsid) : undefined;
	return {
		encoding: body.encoding,
		description: body.description,
		schemaRef,
		fields: extractFields(schema, currentNsid),
	};
}

function classifyKind(doc: RawLexiconDoc): {
	kind: LexiconKind;
	kindLabel: string;
	httpMethod?: 'GET' | 'POST';
} {
	const main = doc.defs.main;
	if (!main) {
		return { kind: 'defs', kindLabel: 'defs' };
	}
	if (main.type === 'query') {
		return { kind: 'query', kindLabel: 'query', httpMethod: 'GET' };
	}
	if (main.type === 'procedure') {
		return { kind: 'procedure', kindLabel: 'procedure', httpMethod: 'POST' };
	}
	if (main.type === 'record') {
		return { kind: 'record', kindLabel: 'record' };
	}
	if (doc.id.includes('.embed.')) {
		return { kind: 'embed', kindLabel: 'embed' };
	}
	return { kind: 'defs', kindLabel: main.type };
}

function findGroupForDoc(doc: LexiconDocView): LexiconGroupId {
	for (const [groupId, config] of Object.entries(CURATED_GROUPS) as Array<
		[LexiconGroupId, (typeof CURATED_GROUPS)[LexiconGroupId]]
	>) {
		if (config.order.includes(doc.id)) {
			return groupId;
		}
	}
	if (doc.kind === 'defs') return 'shared-defs';
	if (doc.kind === 'record' || doc.kind === 'embed') return 'records-and-embeds';
	if (doc.id.includes('Remote') || doc.id.endsWith('.registerPost') || doc.id.endsWith('.unregisterPost')) {
		return 'remote-posts-xrpc';
	}
	if (doc.id.startsWith('dev.antiphony.audio.')) return 'hosted-audio-xrpc';
	return 'tenancy-and-server-xrpc';
}

function collectJsonFiles(dir: string): string[] {
	const entries = readdirSync(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectJsonFiles(fullPath));
		} else if (entry.isFile() && entry.name.endsWith('.json')) {
			files.push(fullPath);
		}
	}
	return files.sort();
}

function parseLexiconDoc(filePath: string, lexiconsRoot: string): LexiconDocView {
	const raw = JSON.parse(readFileSync(filePath, 'utf8')) as RawLexiconDoc;
	const { kind, kindLabel, httpMethod } = classifyKind(raw);
	const main = raw.defs.main;
	const relPath = relative(lexiconsRoot, filePath).replaceAll('\\', '/');

	const subDefs: LexiconSubDefView[] = [];
	for (const [defName, def] of Object.entries(raw.defs)) {
		if (defName === 'main') {
			// Embed lexicons define `main` as an object rather than a record/query/procedure.
			if (def.type === 'object') {
				subDefs.push({
					name: 'main',
					anchorId: makeAnchorId(raw.id, 'main'),
					type: def.type,
					description: def.description,
					fields: extractFields(def, raw.id),
				});
			}
			continue;
		}
		subDefs.push({
			name: defName,
			anchorId: makeAnchorId(raw.id, defName),
			type: def.type,
			description: def.description,
			fields: extractFields(def, raw.id),
		});
	}

	const topDesc = raw.description?.trim() ?? '';
	const mainDesc = main?.description?.trim();
	const distinctMainDesc = mainDesc && mainDesc !== topDesc ? mainDesc : undefined;

	return {
		id: raw.id,
		anchorId: makeAnchorId(raw.id),
		kind,
		kindLabel,
		httpMethod,
		xrpcPath: kind === 'query' || kind === 'procedure' ? `/xrpc/${raw.id}` : undefined,
		recordKey: main?.type === 'record' ? main.key : undefined,
		description: topDesc,
		mainDescription: kind === 'embed' ? undefined : distinctMainDesc,
		githubUrl: `${GITHUB_LEXICON_BASE}/${relPath}`,
		relativePath: `lexicons/${relPath}`,
		parameters: extractFields(main?.parameters, raw.id),
		input: extractBody(main?.input, raw.id),
		output: extractBody(main?.output, raw.id),
		recordFields: extractFields(main?.record, raw.id),
		errors: (main?.errors ?? []).map((e) => ({
			name: e.name,
			description: e.description ?? '',
		})),
		subDefs,
	};
}

let cachedCatalog: LexiconCatalog | null = null;

function findLexiconsRoot(): string {
	const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
	for (const start of starts) {
		let dir = start;
		for (let i = 0; i < 8; i++) {
			const candidate = resolve(dir, 'lexicons', 'dev', 'antiphony');
			if (existsSync(candidate)) {
				return resolve(dir, 'lexicons');
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	throw new Error('Could not locate lexicons/dev/antiphony from docs build context.');
}

export function loadLexiconCatalog(): LexiconCatalog {
	if (cachedCatalog) return cachedCatalog;

	const lexiconsRoot = findLexiconsRoot();
	const antiphonyRoot = resolve(lexiconsRoot, 'dev', 'antiphony');

	const allDocs = collectJsonFiles(antiphonyRoot).map((f) => parseLexiconDoc(f, lexiconsRoot));

	const groupedDocs: Record<LexiconGroupId, LexiconDocView[]> = {
		'records-and-embeds': [],
		'hosted-audio-xrpc': [],
		'remote-posts-xrpc': [],
		'tenancy-and-server-xrpc': [],
		'shared-defs': [],
	};

	for (const doc of allDocs) {
		groupedDocs[findGroupForDoc(doc)].push(doc);
	}

	const groups = {} as Record<LexiconGroupId, LexiconGroup>;
	for (const [groupId, config] of Object.entries(CURATED_GROUPS) as Array<
		[LexiconGroupId, (typeof CURATED_GROUPS)[LexiconGroupId]]
	>) {
		const orderIndex = new Map(config.order.map((id, i) => [id, i]));
		const sorted = groupedDocs[groupId].sort((a, b) => {
			const ai = orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
			const bi = orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
			if (ai !== bi) return ai - bi;
			return a.id.localeCompare(b.id);
		});
		groups[groupId] = {
			id: groupId,
			title: config.title,
			summary: config.summary,
			docs: sorted,
		};
	}

	const queries = allDocs.filter((d) => d.kind === 'query').length;
	const procedures = allDocs.filter((d) => d.kind === 'procedure').length;

	cachedCatalog = {
		groups,
		allDocs,
		counts: {
			total: allDocs.length,
			xrpc: queries + procedures,
			queries,
			procedures,
			recordsAndEmbeds: groups['records-and-embeds'].docs.length,
			sharedDefs: groups['shared-defs'].docs.length,
		},
	};

	return cachedCatalog;
}
