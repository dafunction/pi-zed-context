import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

type Position = { line: number; character: number };
type Range = { text: string; selection: { start: Position; end: Position } };
type ZedContext = { filePath: string; ranges: Range[]; workspacePath?: string };
type ActiveEditorRow = {
	item_kind: string;
	editor_id: number | null;
	workspace_id: number;
	workspace_paths: string | null;
	timestamp: string;
	buffer_path: string | null;
};
type SelectionRow = { selection_start: number | null; selection_end: number | null };
type ContentsRow = { contents: string | null };
type SelectionOffsets = { start: number; end: number };
type ZedContextInputs = {
	activeEditor: ActiveEditorRow;
	selections: SelectionOffsets[];
	contents: string;
};

const NO_CONTEXT_MESSAGE = "No active Zed editor selection found for this working directory.";

export default function zedContext(pi: ExtensionAPI) {
	pi.registerTool({
		name: "zed_context",
		label: "Zed Context",
		description: "Read the active Zed editor file and selection from Zed's local state database.",
		promptSnippet: "Read active Zed editor context when the user refers to their current editor selection or active file.",
		promptGuidelines: [
			"Use zed_context when the user refers to their Zed editor, active file, cursor, current selection, highlighted code, or says things like 'this code'.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const context = resolveZedContext(ctx.cwd);
			return {
				content: [{ type: "text", text: context ? formatContext(context) : NO_CONTEXT_MESSAGE }],
				details: context ?? { type: "empty" },
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("zed-context", resolveZedDbPath() ? "Zed context: available" : "Zed context: unavailable");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const context = resolveZedContext(ctx.cwd);
		ctx.ui.setStatus("zed-context", context ? `Zed: ${path.basename(context.filePath)}` : "Zed context: unavailable");
		if (!context) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Active Zed Editor Context\n\n${formatContext(context)}`,
		};
	});
}

function resolveZedContext(cwd: string): ZedContext | undefined {
	const dbPath = resolveZedDbPath();
	if (!dbPath) return;

	const inputs = readZedContextInputs(dbPath, cwd);
	if (!inputs) return;

	return buildZedContext(inputs.activeEditor, inputs.selections, inputs.contents, cwd);
}

function readZedContextInputs(dbPath: string, cwd: string): ZedContextInputs | undefined {
	const activeEditors = selectCandidateEditors(readActiveEditorRows(dbPath), cwd);
	const activeEditor = activeEditors[0];
	if (!activeEditor) return;

	const selections = normalizeSelections(readSelectionRows(dbPath, activeEditor));
	if (selections.length === 0) return;

	const contents = readEditorContents(dbPath, activeEditor) ?? readText(activeEditor.buffer_path ?? "");
	if (contents == null) return;

	return { activeEditor, selections, contents };
}

function readActiveEditorRows(dbPath: string): ActiveEditorRow[] {
	return queryJson<ActiveEditorRow>(
		dbPath,
		`select
			i.kind as item_kind,
			e.item_id as editor_id,
			i.workspace_id as workspace_id,
			w.paths as workspace_paths,
			w.timestamp as timestamp,
			e.buffer_path as buffer_path
		from items i
		join panes p on p.pane_id = i.pane_id and p.workspace_id = i.workspace_id
		join workspaces w on w.workspace_id = i.workspace_id
		left join editors e on e.item_id = i.item_id and e.workspace_id = i.workspace_id
		where i.active = 1 and p.active = 1
		order by w.timestamp desc`,
	);
}

function readSelectionRows(dbPath: string, editor: ActiveEditorRow): SelectionRow[] {
	return queryJson<SelectionRow>(
		dbPath,
		`select start as selection_start, end as selection_end
		from editor_selections
		where editor_id = ${editor.editor_id} and workspace_id = ${editor.workspace_id}`,
	);
}

function readEditorContents(dbPath: string, editor: ActiveEditorRow): string | undefined {
	return queryJson<ContentsRow>(
		dbPath,
		`select contents from editors where item_id = ${editor.editor_id} and workspace_id = ${editor.workspace_id}`,
	)[0]?.contents ?? undefined;
}

function selectCandidateEditors(rows: ActiveEditorRow[], cwd: string): ActiveEditorRow[] {
	return rows
		.filter(isUsableEditorRow)
		.map((item) => ({ item, score: scoreWorkspace(item.workspace_paths, cwd) }))
		.filter((item) => item.score > 0)
		.sort((left, right) => right.score - left.score || right.item.timestamp.localeCompare(left.item.timestamp))
		.map(({ item }) => item);
}

function isUsableEditorRow(row: ActiveEditorRow): boolean {
	return row.item_kind === "Editor" && row.editor_id != null && Boolean(row.buffer_path);
}

function normalizeSelections(rows: SelectionRow[]): SelectionOffsets[] {
	return rows
		.flatMap((selection) => {
			if (selection.selection_start == null || selection.selection_end == null) return [];
			return [{ start: Math.min(selection.selection_start, selection.selection_end), end: Math.max(selection.selection_start, selection.selection_end) }];
		})
		.sort((left, right) => left.start - right.start || left.end - right.end);
}

function buildZedContext(editor: ActiveEditorRow, selections: readonly SelectionOffsets[], contents: string, cwd: string): ZedContext {
	return {
		filePath: editor.buffer_path ?? "",
		workspacePath: workspacePaths(editor.workspace_paths).find((item) => pathContains(item, cwd)),
		ranges: selections.map((selection) => byteSelectionToRange(contents, selection)),
	};
}

function byteSelectionToRange(contents: string, selection: SelectionOffsets): Range {
	const start = utf8ByteOffsetToStringIndex(contents, selection.start);
	const end = utf8ByteOffsetToStringIndex(contents, selection.end);
	return { text: contents.slice(start, end), selection: offsetsToSelection(contents, start, end) };
}

function resolveZedDbPath() {
	return [
		process.env.OPENCODE_ZED_DB,
		process.env.PI_ZED_DB,
		path.join(os.homedir(), "Library", "Application Support", "Zed", "db", "0-stable", "db.sqlite"),
		path.join(os.homedir(), ".local", "share", "zed", "db", "0-stable", "db.sqlite"),
	]
		.filter((item): item is string => Boolean(item))
		.find(isFile);
}

function queryJson<T>(dbPath: string, sql: string): T[] {
	try {
		const output = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] });
		return JSON.parse(output || "[]") as T[];
	} catch {
		return [];
	}
}

function formatContext(context: ZedContext) {
	return [
		`Active Zed editor context:`,
		`File: ${context.filePath}`,
		context.workspacePath ? `Workspace: ${context.workspacePath}` : undefined,
		...context.ranges.flatMap((range, index) => [
			`Selection ${index + 1}: ${range.selection.start.line}:${range.selection.start.character}-${range.selection.end.line}:${range.selection.end.character}`,
			"```",
			range.text,
			"```",
		]),
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function scoreWorkspace(value: string | null, cwd: string) {
	return workspacePaths(value).reduce((score, item) => (pathContains(item, cwd) ? Math.max(score, path.resolve(item).length) : score), 0);
}

function workspacePaths(value: string | null) {
	if (!value) return [];
	const parsed = parseJson(value);
	if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
	return value.split(/\r?\n/).filter(Boolean);
}

function utf8ByteOffsetToStringIndex(text: string, byteOffset: number) {
	if (byteOffset <= 0) return 0;
	let bytes = 0;
	let index = 0;
	while (index < text.length) {
		const codePoint = text.codePointAt(index);
		if (codePoint === undefined) return text.length;
		const nextIndex = index + (codePoint > 0xffff ? 2 : 1);
		bytes += utf8ByteLength(codePoint);
		if (bytes >= byteOffset) return nextIndex;
		index = nextIndex;
	}
	return text.length;
}

function utf8ByteLength(codePoint: number) {
	if (codePoint <= 0x7f) return 1;
	if (codePoint <= 0x7ff) return 2;
	if (codePoint <= 0xffff) return 3;
	return 4;
}

function offsetsToSelection(text: string, startOffset: number, endOffset: number) {
	const start = Math.max(0, Math.min(startOffset, text.length));
	const end = Math.max(0, Math.min(endOffset, text.length));
	let line = 1;
	let lineStart = 0;
	let startPosition = position(line, lineStart, start);
	let endPosition = position(line, lineStart, end);
	for (let index = 0; index <= end; index++) {
		if (index === start) startPosition = position(line, lineStart, index);
		if (index === end) {
			endPosition = position(line, lineStart, index);
			break;
		}
		if (text[index] === "\n") {
			line += 1;
			lineStart = index + 1;
		}
	}
	return { start: startPosition, end: endPosition };
}

function position(line: number, lineStart: number, offset: number) {
	return { line, character: offset - lineStart + 1 };
}

function pathContains(parent: string, child: string) {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isFile(item: string) {
	try {
		return statSync(item).isFile();
	} catch {
		return false;
	}
}

function readText(item: string) {
	try {
		return readFileSync(item, "utf8");
	} catch {
		return undefined;
	}
}

function parseJson(value: string) {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}
