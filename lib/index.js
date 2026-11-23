import { randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import { ReasoningEffortId, boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { HarnessError } from "@deepseek-ai/dsh-error";
import { CommandDefinitionId } from "@deepseek-ai/dsh-commands";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, readlink, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import z from "@deepseek-ai/schemastery";
import { canonicalizeTimeZone, parseLocalCalendar, resolveLocalInstant } from "@deepseek-ai/dsh-util-time";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { ToolArgsError, ToolContextUnavailableError, defineTool } from "@deepseek-ai/dsh-tools";
import { z as z$1 } from "zod";
import { DomainError, defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { assertNever } from "@deepseek-ai/dsh-util-values";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region lib/types/errors.js
/**
* Failure vocabulary of the sleep plugin.
*
* Each failure is a {@link HarnessError} with a stable code, so command results,
* tool failures, and runtime reports route on the code instead of the message
* text.
* @module @deepseek-ai/dsh-sleep/errors
*/
/** Coded failure raised by the sleep plugin. */
var SleepError = class extends HarnessError {
	/** Stable machine-routable failure class. */
	code;
	/**
	* @param message - Diagnostic naming the failed operation and the rejected value.
	* @param code - Stable machine-routable failure class.
	* @param options - Standard error options carrying the underlying cause.
	*/
	constructor(message, code, options) {
		super(message, code, options);
		this.code = code;
	}
};
/**
* Report one configuration value that violates the plugin contract.
* @param field - Configuration field name as it appears in `cordis.yml` or `cordis.patch.yml`.
* @param detail - What the rejected value fails to satisfy.
* @returns The coded configuration failure.
*/
function invalidConfigError(field, detail) {
	return new SleepError(`sleep config ${field}: ${detail}`, "SLEEP_CONFIG_INVALID");
}
/**
* Report one note path that does not stay inside the configured sleep directory.
* @param path - Caller-supplied path exactly as received.
* @param detail - Why the path is refused, such as the resolved target outside the root.
* @returns The coded path-confinement failure.
*/
function unsafePathError(path, detail) {
	return new SleepError(`sleep note path ${JSON.stringify(path)}: ${detail}`, "SLEEP_PATH_UNSAFE");
}
/**
* Report one note that the filesystem or its content refuses.
*
* Absence, a permission failure, a directory passed as a note, a note above the
* byte cap, and a file that is not UTF-8 text all land here; `SLEEP_PATH_UNSAFE`
* stays reserved for a path that leaves the notes directory.
* @param path - Caller-supplied note path exactly as received.
* @param detail - What the filesystem or the note content refused.
* @param options - Standard error options carrying the underlying cause.
* @returns The coded note failure.
*/
function noteUnavailableError(path, detail, options) {
	return new SleepError(`sleep note ${JSON.stringify(path)}: ${detail}`, "SLEEP_NOTE_UNAVAILABLE", options);
}
/**
* Report a sleep run requested while another run is still active.
*
* The message carries the wait the caller can act on, so the command reports
* this text as it stands.
* @param sessionId - Session that owns the active run, or `null` while that run has not created one yet.
* @returns The coded concurrency failure.
*/
function runInProgressError(sessionId) {
	return new SleepError(sessionId === null ? "a sleep run is already active and has not created its Session yet; wait for it to finish" : `a sleep run is already active in Session ${sessionId}; wait for it to finish`, "SLEEP_RUN_IN_PROGRESS");
}
/**
* Report a run requested after the runtime began to unload.
*
* The store and the timer are already closing, so a run accepted here would
* outlive the composition that owns it.
* @returns The coded stopping failure.
*/
function runtimeStoppingError() {
	return new SleepError("the sleep runtime is stopping", "SLEEP_RUNTIME_STOPPING");
}
/**
* Report durable sleep state that could not be opened.
*
* The notes injection and the command's status read no store, so the runtime
* keeps serving them; every attempt that would read the saved state or record
* its outcome is refused instead, and the next attempt opens the domain again.
* @param cause - Failure the store open reported.
* @returns The coded store failure.
*/
function storeUnavailableError(cause) {
	return new SleepError("the durable sleep state could not be opened, so no sleep run can start; the next run retries it", "SLEEP_STORE_UNAVAILABLE", { cause });
}
/**
* Report that the sleep preset cannot be mounted because no preset service is available.
* @returns The coded missing-service failure.
*/
function presetsUnavailableError() {
	return new SleepError("the agent preset service is unavailable, so the sleep preset cannot be mounted", "SLEEP_PRESETS_UNAVAILABLE");
}
/**
* Report that the sleep preset is registered but failed to activate.
*
* The registry keeps the activation failure of a preset row, and a later check
* cannot repair it, so the run reports that diagnostic instead of the sentence
* for a preset that never appeared.
* @param presetId - Configured sleep preset name.
* @param diagnostic - Activation failure the Agent preset registry reports.
* @returns The coded preset-activation failure.
*/
function presetBrokenError(presetId, diagnostic) {
	return new SleepError(`the sleep preset ${JSON.stringify(presetId)} failed to activate: ${diagnostic}`, "SLEEP_PRESETS_UNAVAILABLE");
}
/**
* Report Session history that could not be read for a sleep run.
* @param operation - `SessionQuery` operation that failed.
* @param cause - Underlying failure kept for diagnosis.
* @returns The coded Session-history failure.
*/
function sessionQueryError(operation, cause) {
	return new SleepError(`cannot read Session history through ${operation}`, "SLEEP_SESSION_QUERY_FAILED", { cause });
}
//#endregion
//#region lib/types/session-query.js
/**
* Session-history reads of the sleep plugin, with one failure boundary.
*
* Every `ctx.sessionQuery` call the runtime, the tools, and the activity
* resolver make goes through here: one wrapper names the operation that failed
* and raises the plugin's coded failure, so no caller repeats it.
* @module @deepseek-ai/dsh-sleep/session-query
*/
/**
* Run one Session-query operation and report its failure as a sleep failure.
* @param ctx - Host context carrying `sessionQuery` and the logger that records the failure.
* @param operation - `SessionQuery` operation name, such as `listSessions`.
* @param invoke - Call that performs the operation.
* @returns The operation's answer.
* @throws SleepError with code `SLEEP_SESSION_QUERY_FAILED` when the operation fails.
*/
async function sleepSessionQuery(ctx, operation, invoke) {
	try {
		return await invoke();
	} catch (error) {
		ctx.logger.warn(`sleep: ${operation} failed: ${String(error)}`);
		throw sessionQueryError(operation, error);
	}
}
//#endregion
//#region lib/types/activity.js
/**
* Session activity and preset resolution for sleep decisions.
*
* A sleep run must consider every working Session with activity newer than
* the last completed sleep, including a Session created before it that stayed
* in use after it. `SessionHeader` records only the creation instant, so the
* activity instant comes from the `sessionListMetadata` projection when the
* Host projects it, from the latest activity event otherwise, and from the
* header when the log holds no activity yet.
*
* That projection records the last human prompt, which is a lower bound of the
* latest activity rather than the latest activity itself: the assistant reply
* and the turn end that followed the prompt are newer. A caller that only asks
* whether a Session was active after some instant is answered by a projected
* prompt above it, while a caller that sorts, pages, or reports one instant
* reads the durable log.
*
* A persisted projection is also a checkpoint, not the log: the projection cache
* writes it at Session creation, at `turn/end`, and at disposal, and every write
* is fail-soft, so a crash between a committed prompt and the next checkpoint
* leaves the stored instant older than the durable log. A caller that asks about
* one lower bound therefore has the durable log confirm a stored instant that
* cannot prove the Session was active. The same applies to the preset: a
* checkpoint that has not folded a turn start, or that holds no preset value,
* cannot prove the preset a Session runs under, because a selection made before
* the first turn is written to the log alone, so the preset resolution reads the
* log at that point.
* @module @deepseek-ai/dsh-sleep/activity
*/
var __addDisposableResource = function(env, value, async) {
	if (value !== null && value !== void 0) {
		if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
		var dispose, inner;
		if (async) {
			if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
			dispose = value[Symbol.asyncDispose];
		}
		if (dispose === void 0) {
			if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
			dispose = value[Symbol.dispose];
			if (async) inner = dispose;
		}
		if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/** Projection key that carries the persisted Session-list metadata. */
const LIST_METADATA_KEY = "sessionListMetadata";
/** Projection key the preset registry records the preset a Session runs under. */
const PRESET_KEY = "agentPreset";
/**
* Event types whose timestamp counts as Session activity.
*
* A Session that was only created, renamed, or resumed has no such event and
* keeps its creation instant as its activity.
*/
const ACTIVITY_EVENT_TYPES = new Set([
	"user/message",
	"assistant/message",
	"turn/end"
]);
/**
* Whether a projected prompt instant answers the caller's question.
* @param projected - Last prompt instant in epoch milliseconds.
* @param options - Activity bound the caller asks about.
* @returns `true` when the projection proves the requested activity.
*/
function provesActivity(projected, options) {
	return options.after === void 0 || projected > options.after;
}
/**
* Whether a stored Session ran under the sleep preset.
*
* The creation header records only the preset the Session started with: a blank
* Session can switch preset before its first turn, and the `agentPreset`
* projection records the preset its turns actually ran under. A live Session
* answers from the projection registry, a cold one from the durable log when its
* persisted checkpoint cannot prove the preset, and the header is the fallback
* for a composition that projects neither.
* @param ctx - Host context carrying the Session store, the Session query engine, and the projection services when composed.
* @param record - Session record as listed by `ctx.sessionQuery`.
* @param presetId - Configured sleep preset name.
* @returns `true` when the Session runs, or last ran, under the sleep preset.
* @throws SleepError with code `SLEEP_SESSION_QUERY_FAILED` when the preset needs the Session log and it cannot be read.
*/
async function isSleepSessionRecord(ctx, record, presetId) {
	return await resolveSessionPreset(ctx, record) === presetId;
}
/**
* Resolve the preset a Session runs, or last ran, under.
*
* The answer is the preset its turns actually used: the live projection for a
* live Session, and for a cold Session the persisted checkpoint when that
* checkpoint recorded one. A checkpoint proves the preset only when it folded a
* turn start and recorded a preset, because a Session that has started cannot
* switch preset; a checkpoint written before the first turn, or one that holds
* no preset value at all, can lag an `agent-preset/selected` event that exists
* only in the durable log, so the log answers instead. The creation header is
* the fallback when neither names a preset.
* @param ctx - Host context carrying the Session store, the Session query engine, and the projection services when composed.
* @param record - Session record as listed by `ctx.sessionQuery`.
* @returns The preset id, or `undefined` when no source names one.
* @throws SleepError with code `SLEEP_SESSION_QUERY_FAILED` when the preset needs the Session log and it cannot be read.
*/
async function resolveSessionPreset(ctx, record) {
	const live = ctx.get("sessions")?.get(record.header.id);
	if (live !== void 0) return ctx.get("sessionProjections")?.snapshot(live, [PRESET_KEY]).values[PRESET_KEY] ?? record.header.agentPreset;
	const cached = ctx.get("sessionProjectionCache")?.cachedSnapshot(record.header, [PRESET_KEY, LIST_METADATA_KEY]);
	const projected = cached?.values[PRESET_KEY];
	const metadata = cached?.values[LIST_METADATA_KEY];
	if (metadata !== void 0 && !metadata.blank && projected !== void 0 && projected !== null) return projected;
	return await lastSelectedPreset(ctx, record.header.id) ?? projected ?? record.header.agentPreset;
}
/**
* Whether a Session was created under the sleep preset.
*
* This reads the frozen creation header, so it does not follow a preset
* switched before the first turn; {@link isSleepSessionRecord} is the
* classification that does.
* @param header - Session header as listed by `ctx.sessionQuery`.
* @param presetId - Configured sleep preset name.
* @returns `true` when the Session was created for the sleep preset.
*/
function isSleepSessionHeader(header, presetId) {
	return header.agentPreset === presetId;
}
/**
* Whether a live Agent runs under the sleep preset.
*
* A live Agent reports the preset its registry composed for it, so a blank
* Session moved to another preset before its first turn stops counting as a
* sleep Session. The durable header is the fallback for a composition without
* the registry: it names the preset the Session started under.
* @param ctx - Host context carrying the preset registry when one is composed.
* @param agent - Agent to classify.
* @param presetId - Configured sleep preset name.
* @returns `true` when the Agent belongs to the sleep preset.
*/
function isSleepAgent(ctx, agent, presetId) {
	const composed = ctx.get("agentPresets")?.composedPreset(agent.ctx);
	if (composed !== void 0) return composed === presetId;
	return isSleepSessionHeader(agent.session.header, presetId);
}
/**
* Read the last human prompt instant one Session projects, without reading its log.
*
* The answer is a lower bound of the Session's latest activity and is `null`
* when no composed projection records one. A caller that excludes a Session by
* a lower bound must compare it as such: the assistant reply and the turn end
* that followed the prompt are newer.
* @param ctx - Host context carrying the projection services when composed.
* @param record - Session record as listed by `ctx.sessionQuery`.
* @returns The projected last prompt instant in epoch milliseconds, or `null` when none is projected.
*/
function projectedPromptAt(ctx, record) {
	const live = ctx.get("sessions")?.get(record.header.id);
	const projections = ctx.get("sessionProjections");
	if (live !== void 0) {
		const projected = projections?.snapshot(live, [LIST_METADATA_KEY]).values[LIST_METADATA_KEY];
		return projected?.lastPromptAt === void 0 || projected.lastPromptAt === null ? null : projected.lastPromptAt;
	}
	const lastPromptAt = (ctx.get("sessionProjectionCache")?.cachedSnapshot(record.header, [LIST_METADATA_KEY]))?.values[LIST_METADATA_KEY]?.lastPromptAt;
	return lastPromptAt === void 0 || lastPromptAt === null ? null : lastPromptAt;
}
/**
* Resolve the activity instant of one Session, in epoch milliseconds.
*
* Without `exact`, a projected prompt above the requested bound proves the
* Session was active after it, and the answer costs no log read. The exact
* answer, and every answer the projection cannot prove, comes from the latest
* activity event in the durable log; the header covers a Session whose log holds
* no activity yet. A persisted checkpoint that cannot prove activity after the
* questioned bound is therefore confirmed from the log, so a Session the cache
* left behind a crash still counts.
* @param ctx - Host context carrying `sessions`, `sessionQuery`, and optionally the projection services.
* @param record - Session record as listed by `ctx.sessionQuery`.
* @param options - Activity bound the answer must prove, and whether the exact latest instant is required.
* @returns The activity instant in epoch milliseconds, never `null`.
* @throws SleepError with code `SLEEP_SESSION_QUERY_FAILED` when the event fallback cannot read the log.
*/
async function resolveSessionActivityAt(ctx, record, options = {}) {
	const projected = projectedPromptAt(ctx, record);
	if (options.exact !== true && projected !== null && provesActivity(projected, options)) return projected;
	const eventAt = await lastActivityTime(ctx, record.header.id);
	if (eventAt !== null) return eventAt;
	return projected ?? record.header.createdAt;
}
/**
* Read the preset the latest durable selection event names.
*
* A preset can be selected only before the first turn, so the last selection in
* the log is the preset the Session runs under. A Session that never selected
* one keeps its creation preset, which the caller reads from its own source.
* @param ctx - Host context carrying `sessionQuery`.
* @param sessionId - Session whose log is read.
* @returns The last selected preset id, or `undefined` when the log records no selection.
* @throws SleepError with code `SLEEP_SESSION_QUERY_FAILED` when the log cannot be read.
*/
async function lastSelectedPreset(ctx, sessionId) {
	const env_1 = {
		stack: [],
		error: void 0,
		hasError: false
	};
	try {
		const observation = __addDisposableResource(env_1, await sleepSessionQuery(ctx, "observeSession", () => ctx.sessionQuery.observeSession(sessionId, { projectionMode: "none" })), false);
		let selected;
		for (const event of observation.events) if (event.type === "agent-preset/selected") selected = event.data.agentPreset;
		return selected;
	} catch (e_1) {
		env_1.error = e_1;
		env_1.hasError = true;
	} finally {
		__disposeResources(env_1);
	}
}
/**
* Read the timestamp of the latest activity event in one Session log.
*
* The exact Session is observed by identity, so a cold Session costs its own
* log read and never re-lists the persisted corpus. Calling `listEvents` here
* would list the corpus again for every cache miss and make a cold history
* quadratic.
* @param ctx - Host context carrying `sessionQuery`.
* @param sessionId - Session whose log is read.
* @returns The latest activity instant in epoch milliseconds, or `null` when the log holds none.
* @throws SleepError with code `SLEEP_SESSION_QUERY_FAILED` when the log cannot be read.
*/
async function lastActivityTime(ctx, sessionId) {
	const env_2 = {
		stack: [],
		error: void 0,
		hasError: false
	};
	try {
		const observation = __addDisposableResource(env_2, await sleepSessionQuery(ctx, "observeSession", () => ctx.sessionQuery.observeSession(sessionId, { projectionMode: "none" })), false);
		let latest = null;
		for (const event of observation.events) {
			if (!ACTIVITY_EVENT_TYPES.has(event.type)) continue;
			if (latest === null || event.time > latest) latest = event.time;
		}
		return latest;
	} catch (e_2) {
		env_2.error = e_2;
		env_2.hasError = true;
	} finally {
		__disposeResources(env_2);
	}
}
//#endregion
//#region lib/types/frame.js
/**
* The `<system-reminder>` frame of the saved-notes block.
*
* The memory injector owns the complete frame, so only the closing tag a note
* carries is escaped: an opening tag inside note text cannot end the block
* early. The injection budget prices the escaped text, because that is what the
* block carries.
* @module @deepseek-ai/dsh-sleep/frame
*/
/** Opening tag of the frame. */
const FRAME_OPEN = "<system-reminder>";
/** Closing tag of the frame, and the tag carried text must not repeat. */
const FRAME_CLOSE = "</system-reminder>";
/** What a closing tag inside carried text becomes. */
const FRAME_CLOSE_ESCAPED = "<\\/system-reminder>";
/**
* Keep carried text from closing the frame early.
* @param body - Rendered block content, without the frame.
* @returns The content with every closing tag escaped.
*/
function escapeFrameBody(body) {
	return body.replaceAll(FRAME_CLOSE, FRAME_CLOSE_ESCAPED);
}
//#endregion
//#region lib/types/notes-fs.js
/**
* Filesystem of the sleep notes directory.
*
* Every operation takes a note path from a model tool argument and refuses
* anything that canonicalizes outside the notes directory: a `..` segment or a
* NUL byte is refused before the filesystem is touched, and containment is
* checked on the `realpath` of the nearest existing ancestor, so a symbolic
* link inside the tree cannot redirect a read, write, move, or delete to
* another location.
*
* The canonical path is checked again immediately before each filesystem call,
* and a path that now resolves elsewhere is refused. A read also proves that the
* opened file is the file that check described, so an ancestor swapped for a
* symbolic link after the check is detected instead of followed. Node has no
* descriptor-relative operation, so a directory swapped inside the remaining gap
* between that check and the call is not preventable, and a platform that
* reports no file identity cannot prove the opened file at all; reads
* additionally refuse a final symbolic link through `O_NOFOLLOW` where the
* platform provides it. The residual race is documented in the package README.
*
* A note path is split on the separators the host filesystem uses: a backslash
* names a directory on Windows and is an ordinary character in a POSIX filename,
* so the two are not interchangeable.
*
* A symbolic link that stays inside the notes directory is a listed entry, so a
* move or a delete acts on that entry rather than on the note the link points
* at, and deleting a duplicate listing cannot destroy the note it duplicates.
* For the same reason, a recursive delete never reports the note a removed link
* named among the notes it removed. A relative link is read from the directory
* that holds it, and the text is resolved in the order the operating system
* resolves it, so a move is refused when the new directory would leave it naming
* another path or no path at all, instead of placing such a link. For the same
* reason, a move refuses a link whose text would resolve through the entry it
* replaces: that entry would hold the link and become part of its own
* resolution. A move also refuses a link whose text resolves through the entry
* it leaves, because that text names no note once the link moved from that path.
*
* A recursive delete waits for every removal it starts before it returns or
* fails, and it starts them one at a time so a wide tree cannot exhaust the
* process's file descriptors. It proves each entry again immediately before it
* opens or removes it, and it proves the emptied directory again before it
* removes that too, so a directory replaced by a symbolic link during the walk is
* refused instead of followed. A removal that fails reports that the
* deletion may be partial: the next sleep run starts when the call returns, so
* no removal may still run beside it.
*
* A move reads the note it reports before the rename and before the last check
* of both paths: a rename cannot be undone, so a failure afterwards must not
* report a move that already happened as a failed one, and no await may separate
* the checks from the rename. The new name stays as the caller spelled it, so a
* host that compares names without case still renames the entry.
*
* A note is UTF-8 text. A file holding a NUL byte or bytes that are not valid
* UTF-8 is reported as not text instead of decoded, and a write of text with a
* NUL byte is refused so it cannot turn a readable note into a binary one.
*
* Writes go through `writeFileAtomic`, so a reader observes either the previous
* note or the complete new text.
* @module @deepseek-ai/dsh-sleep/notes-fs
*/
/** Permission bits of a note file: notes are private user data. */
const NOTE_FILE_MODE = 384;
/** Permission bits of a note directory, for the same reason. */
const NOTE_DIR_MODE = 448;
/** A NUL byte cannot name a file, and its presence alone marks a note as binary. */
const NUL_BYTE = 0;
/** The same NUL byte as note text, which a write must refuse. */
const NUL_CHARACTER = "\0";
/**
* `O_NOFOLLOW` where the platform defines it, and `0` where it has no such
* flag, as on Windows.
*/
/* v8 ignore next -- `O_NOFOLLOW` exists on one platform only, so one arm is unreachable on every host */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
/**
* Open flags of a note read: `O_NOFOLLOW` refuses a symbolic link at the final
* path element, so a target swapped after the canonical check cannot redirect
* the read. Windows has no such flag, so the read there falls back to a plain
* open and the check before it is the only defence.
*/
const NOTE_READ_FLAGS = constants.O_RDONLY | O_NOFOLLOW;
/** Path segment that leaves the notes directory. */
const PARENT_SEGMENT = "..";
/** Path segment that names the directory it sits in. */
const CURRENT_SEGMENT = ".";
/**
* Separators that split one note path.
*
* A backslash separates directories on Windows, so both spellings name the same
* note there. POSIX treats a backslash as an ordinary filename character, so
* splitting on it would address a different note than the one the scan lists.
*/
/* v8 ignore next -- the separator set is fixed per platform, so one arm never runs on a given host */
const PATH_SEPARATOR$1 = process.platform === "win32" ? /[\\/]/u : /\//u;
/** One trailing line terminator closes the last line instead of opening another. */
const TRAILING_LINE_BREAK = /\r?\n$/u;
/** Line separator of note text. */
const LINE_BREAK = /\r?\n/u;
/** Encoding every note is read and written as. */
const NOTE_ENCODING = "utf8";
/** Most symbolic links one target chain may hold before the walk stops. */
const MAX_LINK_DEPTH = 40;
/** Most removed note paths one deletion reports, so a removed tree stays a bounded result. */
const DELETED_PATHS_LIMIT = 20;
/** Empty injection collection, shared by every missing notes directory. */
const NO_NOTES = Object.freeze({
	included: [],
	remaining: []
});
/**
* List every note file under the notes directory.
*
* A directory that does not exist has no notes. Directories are entered, plain
* files are listed, and a symbolic link is listed only when it resolves to a
* regular file inside the directory. Each subdirectory is proved again
* immediately before it is opened, so a directory replaced by a link after it
* was listed is skipped instead of entered. The result is ordered by path, which
* keeps the memory injection deterministic.
* @param rootDir - Configured notes directory.
* @returns The notes found, ordered by path.
* @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when the directory cannot be read.
*/
async function listNotes(rootDir) {
	const root = await existingRoot(rootDir);
	if (root === void 0) return [];
	return await scanNotes(root, "");
}
/**
* Read one note, optionally a line window of it.
*
* At most `maxBytes` are read, so an oversized note cannot exhaust memory; a
* note cut by that cap reports `truncated` and never reaches `eof`.
* @param rootDir - Configured notes directory.
* @param notePath - Note path relative to the directory, or an absolute path inside it.
* @param options - Line window and byte cap.
* @returns The requested note window.
* @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path leaves the
* directory, or `SLEEP_NOTE_UNAVAILABLE` when the note is absent, unreadable,
* or not UTF-8 text.
*/
async function readNote(rootDir, notePath, options) {
	const root = await requiredRoot(rootDir);
	const target = await confinedTarget(root, notePath);
	const loaded = await loadNote(await confirmedTarget(root, target), options.maxBytes, { read: 0 });
	if (loaded.text === void 0) throw noteUnavailableError(target.path, "not UTF-8 text");
	const lines = splitLines(loaded.text);
	const offset = options.offset ?? 1;
	const limit = options.limit ?? lines.length;
	const window = lines.slice(offset - 1, offset - 1 + limit);
	return {
		path: target.path,
		text: window.join("\n"),
		offset,
		total: lines.length,
		shown: window.length,
		eof: !loaded.truncated && offset - 1 + window.length >= lines.length,
		truncated: loaded.truncated
	};
}
/**
* Write one note, creating the note and its directories.
*
* An existing note of that path is replaced in one atomic step. Text above
* `maxBytes` is refused before the file is touched, so a note cannot grow past
* the byte cap later reads and injections rely on. The written bytes are
* reported even when the modification time cannot be read back afterwards.
* @param rootDir - Configured notes directory, created when it does not exist.
* @param notePath - Note path relative to the directory, or an absolute path inside it.
* @param text - Complete next content of the note.
* @param options - Byte limit of the written text.
* @returns The written note.
* @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path leaves the
* directory, or `SLEEP_NOTE_UNAVAILABLE` when the text exceeds the byte limit
* or the file cannot be written.
*/
async function writeNote(rootDir, notePath, text, options) {
	const bytes = Buffer.byteLength(text, NOTE_ENCODING);
	if (text.includes(NUL_CHARACTER)) throw noteUnavailableError(notePath, "would not be readable text because it contains a NUL byte");
	const root = await ensureNotesDirectory(rootDir);
	const target = await confinedTarget(root, notePath);
	if (bytes > options.maxBytes) throw noteUnavailableError(notePath, `would hold ${bytes} bytes, above the ${options.maxBytes} byte note limit`);
	try {
		await writeFileAtomic((await confirmedTarget(root, target)).target, text, {
			mode: NOTE_FILE_MODE,
			dirMode: NOTE_DIR_MODE
		});
	} catch (error) {
		throw noteFailure(notePath, "write", error);
	}
	return {
		path: target.path,
		bytes,
		...await writtenMtime(target)
	};
}
/**
* Move or rename one note, creating the directories of its new path.
*
* A path that names a symbolic link moves the link entry, not the note the link
* resolves to, so the note keeps its own location and the moved link still names
* it; a link whose text would stop resolving to that note from the new directory,
* or would resolve through the new path itself, is refused, because `rename`
* moves the link text verbatim. An existing entry at
* the new path is replaced, and the result says so, because the replaced note or
* link is gone; a new path that names the entry the note already occupies
* replaces nothing. The note is described before the rename, so a completed move
* is never reported as a failure.
* @param rootDir - Configured notes directory.
* @param fromPath - Current note path.
* @param toPath - New note path.
* @returns The note at its new path, with whether it replaced one there.
* @throws SleepError with code `SLEEP_PATH_UNSAFE` when either path leaves the
* directory, or `SLEEP_NOTE_UNAVAILABLE` when the note cannot be moved.
*/
async function moveNote(rootDir, fromPath, toPath) {
	const root = await requiredRoot(rootDir);
	const sourceLink = await namedLink(root, fromPath);
	const destinationLink = await namedLink(root, toPath);
	let sourceEntry;
	let sourcePath;
	if (sourceLink === void 0) {
		const source = await confinedTarget(root, fromPath);
		sourceEntry = source.target;
		sourcePath = source.path;
	} else {
		sourceEntry = sourceLink.entry;
		sourcePath = sourceLink.path;
	}
	let destinationEntry;
	let destinationPath;
	if (destinationLink === void 0) {
		const destination = await confinedDestination(root, toPath);
		destinationEntry = destination.target;
		destinationPath = destination.path;
		if (sourceLink !== void 0 && samePath(destinationEntry, sourceLink.target)) throw noteUnavailableError(fromPath, "would replace the note its link names");
	} else {
		destinationEntry = destinationLink.entry;
		destinationPath = destinationLink.path;
	}
	try {
		if (sourceLink !== void 0) {
			const problem = await movedLinkProblem(sourceLink, destinationEntry);
			if (problem !== void 0) throw noteUnavailableError(fromPath, `${problem}, so ${destinationPath} would name no note`);
		}
		await confirmedDestination(root, destinationEntry, destinationPath, destinationLink !== void 0);
		await mkdir(dirname(destinationEntry), {
			recursive: true,
			mode: NOTE_DIR_MODE
		});
		const replaced = !samePath(destinationEntry, sourceEntry) && await noteExists(destinationEntry);
		const described = await describeNote({
			target: sourceEntry,
			path: destinationPath
		});
		await rename(await confirmedEntry(root, sourceEntry, sourcePath, sourceLink !== void 0), await confirmedDestination(root, destinationEntry, destinationPath, destinationLink !== void 0));
		return {
			...described,
			replaced
		};
	} catch (error) {
		throw noteFailure(fromPath, "move", error);
	}
}
/**
* Why moving one symbolic link would leave it naming no note.
*
* A symbolic link keeps its text, and that text is read from the directory that
* holds the link, so the move changes what the text resolves to. A text that
* reaches the destination entry would resolve through the moved link itself,
* which is why such a move is refused. A text that resolves through the entry
* the rename removes would stop resolving at all, because the old path is gone
* once the link moved; both checks therefore run while the move can still be
* refused. A relative text can also name another path from the new directory,
* and that path is the one the operating system resolves: every link on the way
* is followed before a `..` segment climbs. An absolute text names its note
* wherever the link goes.
* @param link - Link the caller named.
* @param destinationEntry - Absolute path the link would move to.
* @returns Why the move would leave the link naming no note, or `undefined` when it keeps naming its note.
* @throws The filesystem failure that stopped a resolution.
*/
async function movedLinkProblem(link, destinationEntry) {
	const text = await readlink(link.entry);
	const directory = dirname(destinationEntry);
	if (await resolutionVisits(directory, text, destinationEntry)) return "names a symbolic link whose target resolves through its new path";
	if (await resolutionVisits(directory, text, link.entry)) return "names a symbolic link whose target resolves through the entry it leaves";
	if (directory === dirname(link.entry)) return void 0;
	if (isAbsolute(text)) return void 0;
	return await landingPath(directory, text) === link.target ? void 0 : "names a relative symbolic link that would not resolve from its new directory";
}
/**
* Resolve one link text the way the operating system resolves it from a directory.
*
* The walk follows every symbolic link it meets, so a `..` segment climbs from the
* directory the walk has reached rather than from the directory the text is
* spelled in: a directory link before that segment moves where the text lands.
* Collapsing the text lexically first would answer a path the operating system
* never visits.
* @param fromDir - Canonical directory the text is read from.
* @param text - Link text.
* @returns The canonical path the text names, or `undefined` when a segment does
* not exist or the link depth is spent.
* @throws The filesystem failure that stopped the walk.
*/
async function landingPath(fromDir, text) {
	const walked = await walkResolution(resolutionBase(fromDir, text), splitPathSegments(text), void 0, MAX_LINK_DEPTH);
	if (walked.landing === void 0) return void 0;
	return await realpath(walked.landing);
}
/**
* Directory one link text is resolved from.
* @param fromDir - Canonical directory that holds the text.
* @param text - Link text.
* @returns The filesystem root for an absolute text, or the holding directory.
*/
function resolutionBase(fromDir, text) {
	return isAbsolute(text) ? parse(text).root : fromDir;
}
/**
* Whether resolving one link text from a directory visits one entry.
* @param fromDir - Canonical directory the text is read from.
* @param text - Link text.
* @param entry - Absolute path the resolution must not visit.
* @returns `true` when the text resolves through that entry.
* @throws The filesystem failure that is not an absent path.
*/
async function resolutionVisits(fromDir, text, entry) {
	return (await walkResolution(resolutionBase(fromDir, text), splitPathSegments(text), entry, MAX_LINK_DEPTH)).visited;
}
/**
* Walk one path in the order the operating system resolves it.
*
* Each segment is examined in order, and a `..` segment climbs from the
* directory the walk has reached, not from the directory the text is spelled in:
* once a symbolic link is followed, that directory is the link's target. A
* lexical collapse of `..` before the links are followed would erase the
* segments that pass through the entry, so the walk keeps the operating system's
* order. Every symbolic link it meets is followed together with the segments
* that remain after it, because the operating system resolves those from the
* link's target rather than from the link's own path. A path segment that does
* not exist ends the walk, and the depth bound stops a chain of links that could
* never resolve.
* @param base - Canonical directory the first segment is resolved from.
* @param segments - Path segments in the order the operating system resolves them.
* @param entry - Absolute path the walk must not visit, or `undefined` to resolve without that check.
* @param depth - Symbolic links the walk may still follow.
* @returns Whether the walk visited that entry, and the canonical path it reached.
* @throws The filesystem failure that is not an absent path.
*/
async function walkResolution(base, segments, entry, depth) {
	if (depth === 0) return {
		visited: false,
		landing: void 0
	};
	let current = base;
	for (const [index, segment] of segments.entries()) {
		if (segment === CURRENT_SEGMENT) continue;
		if (segment === PARENT_SEGMENT) {
			current = dirname(current);
			continue;
		}
		current = join(current, segment);
		if (current === entry) return {
			visited: true,
			landing: void 0
		};
		let info;
		try {
			info = await lstat(current);
		} catch (error) {
			if (errnoCode(error) === "ENOENT") return {
				visited: false,
				landing: void 0
			};
			throw error;
		}
		if (!info.isSymbolicLink()) continue;
		const text = await readlink(current);
		return await walkResolution(resolutionBase(dirname(current), text), [...splitPathSegments(text), ...segments.slice(index + 1)], entry, depth - 1);
	}
	return {
		visited: false,
		landing: current
	};
}
/**
* Split one path into the segments it names.
* @param path - Absolute or relative path.
* @returns The segments, without the path root and without an empty segment.
*/
function splitPathSegments(path) {
	const root = isAbsolute(path) ? parse(path).root : "";
	return path.slice(root.length).split(sep).filter((segment) => segment !== "");
}
/**
* Prove again, immediately before a filesystem call, that the entry an operation
* acts on still resolves to the same place.
*
* A note path is re-resolved exactly as every other operation does. A named
* symbolic link is proved through its parent instead, because resolving the link
* itself would answer its target, which is not the entry being moved.
* @param root - Canonical notes directory.
* @param entry - Absolute path of the note or link entry.
* @param path - Entry path relative to the directory, used in failures.
* @param link - Whether the entry is a symbolic link rather than a resolved note.
* @returns The entry path, after resolving it or its parent again.
* @throws SleepError with code `SLEEP_PATH_UNSAFE` when a note now resolves to a
* different location, or `SLEEP_NOTE_UNAVAILABLE` when the parent cannot be resolved.
*/
async function confirmedEntry(root, entry, path, link) {
	if (!link) return (await confirmedTarget(root, {
		target: entry,
		path
	})).target;
	await confirmedParent(root, entry, path);
	return entry;
}
/**
* Prove again, immediately before the rename, that the destination still names
* the entry the move prepared.
*
* A destination that names a symbolic link is proved through that entry, exactly
* as a removal proves the link it removes. A plain path is proved through its
* parent: its own name is the one the move creates and keeps the spelling the
* caller asked for, so the parent is what the move acts through.
* @param root - Canonical notes directory.
* @param entry - Absolute destination path.
* @param path - Destination path relative to the directory, used in failures.
* @param link - Whether the destination names a symbolic link.
* @returns The destination path, after resolving the entry the move acts through.
* @throws SleepError with code `SLEEP_PATH_UNSAFE` when the destination now
* resolves to a different location, or `SLEEP_NOTE_UNAVAILABLE` when it cannot be resolved.
*/
async function confirmedDestination(root, entry, path, link) {
	if (link) return await confirmedEntry(root, entry, path, true);
	await confirmedParent(root, entry, path);
	return entry;
}
/**
* Prove again, immediately before a filesystem call, that the directory an entry
* lives in still resolves to the same place.
*
* A link entry is acted on through its own path, so its parent is what a swapped
* directory would redirect: resolving the link itself would answer its target,
* which is not the entry being moved or removed.
* @param root - Canonical notes directory.
* @param entry - Absolute path of the entry.
* @param path - Entry path relative to the directory, used in failures.
* @throws SleepError with code `SLEEP_PATH_UNSAFE` when the parent now resolves
* to a different location, or `SLEEP_NOTE_UNAVAILABLE` when it cannot be resolved.
*/
async function confirmedParent(root, entry, path) {
	let parent;
	try {
		parent = await canonicalPath(dirname(entry));
	} catch (error) {
		throw noteFailure(path, "confirm", error);
	}
	if (parent !== dirname(entry) || parent !== root && !isInside(root, parent)) throw unsafePathError(path, "resolves to a different path after validation");
}
/**
* Delete one note or one directory of notes.
*
* A directory is removed with everything under it, and the result reports how
* many note files and bytes went with it, so the caller sees the blast radius of
* one delete call. Every removal the call starts settles before it returns or
* fails, because the next sleep run starts when the call returns and must not
* share the notes directory with removals that are still running; a removal that
* fails reports that the deletion may be partial. The removals run one at a
* time, and each entry is proved again immediately before it is opened or
* removed, so a wide tree cannot exhaust descriptors and a parent swapped for a
* symbolic link during the walk cannot redirect a removal. A symbolic link is
* removed as the link it is: the path it resolves to names the note the link
* points at, so removing that path would delete the note and leave the link
* dangling. For the same reason, a link inside a removed directory is not
* reported among the removed notes, and the bytes of the note it names are not
* counted.
* @param rootDir - Configured notes directory.
* @param notePath - Note path relative to the directory, or an absolute path inside it.
* @returns The removed path, its kind, and the entries removed with it.
* @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path leaves the
* directory, or `SLEEP_NOTE_UNAVAILABLE` when the note cannot be deleted.
*/
async function deleteNote(rootDir, notePath) {
	const root = await requiredRoot(rootDir);
	const link = await namedLink(root, notePath);
	if (link !== void 0) return await removeNamedLink(link, notePath);
	const target = await confinedTarget(root, notePath);
	let kind = "file";
	let removed;
	try {
		const checked = await confirmedTarget(root, target);
		const info = await stat(checked.target);
		kind = info.isDirectory() ? "directory" : "file";
		removed = kind === "directory" ? await scanRemovedEntries(root, checked.path) : [{
			path: checked.path,
			bytes: info.size,
			kind: "file"
		}];
		const failures = await removeEntry(root, (await confirmedTarget(root, checked)).target, checked.path);
		if (failures.length > 0) {
			const first = failures[0];
			throw noteUnavailableError(notePath, `${failures.length} of its entries could not be removed (${first.path}: ${first.code}), so the deletion may be partial`);
		}
	} catch (error) {
		throw noteFailure(notePath, "delete", error);
	}
	return {
		path: target.path,
		kind,
		...deleteSummary(removed)
	};
}
/**
* Remove one note entry, every entry below it, and nothing else.
*
* `fs.rm` starts the removal of every sibling at once and rejects as soon as one
* of them fails, so a caller that observes the rejection starts the next sleep
* run while sibling removals are still running. This walk awaits every removal
* it starts and reports the ones that failed instead, so a failed delete states
* that it may be partial. It removes one entry at a time, so a wide directory
* cannot hold a descriptor open for every sibling and drain the process's file
* descriptors. Each entry is read without following a symbolic link, so a link
* is removed as the link it is and a directory swapped for a link is not
* entered, and each entry is proved again immediately before it is opened or
* removed, because a parent replaced by a symbolic link during the walk would
* otherwise make the removal act outside the notes directory.
* @param root - Canonical notes directory.
* @param entry - Absolute path of the entry to remove.
* @param entryPath - Entry path relative to the notes directory, used in the report.
* @returns The entries the walk could not remove, in path order.
*/
async function removeEntry(root, entry, entryPath) {
	let info;
	try {
		info = await lstat(entry);
	} catch (error) {
		const code = errnoCode(error);
		return code === "ENOENT" ? [] : [{
			path: entryPath,
			code
		}];
	}
	let checked;
	try {
		checked = await confirmedEntry(root, entry, entryPath, info.isSymbolicLink());
	} catch (error) {
		return [{
			path: entryPath,
			code: errnoCode(error)
		}];
	}
	if (!info.isDirectory()) {
		const problem = await removeOneEntry(checked);
		return problem === void 0 ? [] : [{
			path: entryPath,
			code: problem
		}];
	}
	let names;
	try {
		const handle = await opendir(checked);
		names = [];
		for await (const name of handle) names.push(name.name);
	} catch (error) {
		return [{
			path: entryPath,
			code: errnoCode(error)
		}];
	}
	const failures = [];
	for (const name of names) failures.push(...await removeEntry(root, join(checked, name), `${entryPath}/${name}`));
	if (failures.length === 0) try {
		await rmdir(await confirmedEntry(root, entry, entryPath, false));
	} catch (error) {
		const code = errnoCode(error);
		if (code !== "ENOENT") failures.push({
			path: entryPath,
			code
		});
	}
	return failures;
}
/**
* Remove one file or one symbolic link entry.
* @param entry - Absolute path of the entry.
* @returns The errno code that stopped the removal, or `undefined` when the entry is gone.
*/
async function removeOneEntry(entry) {
	try {
		await rm(entry);
		return;
	} catch (error) {
		const code = errnoCode(error);
		return code === "ENOENT" ? void 0 : code;
	}
}
/**
* Scan the notes directory for the memory injection pass.
*
* Text notes are collected in path order until the rendered block reaches
* `injectMaxBytes`; the budget charges each carried note's heading and path as
* well as its text. Text notes that do not fit are listed by path and size
* instead. The pass reads to classify, so it bounds that work twice over: at
* most `inspectMaxBytes` of note content, and at most `inspectMaxEntries`
* directory entries examined by the walk, which stops when that count is spent. A note
* neither read nor listed appears in neither list, so the pass never offers the
* model a note it cannot open, and {@link CollectedNotes.partial} names the
* budget that stopped it examining the whole tree.
*
* The scan and the read are separate steps, so each note is resolved again
* immediately before it is read: a directory swapped for a symbolic link after
* the walk cannot redirect a read outside the directory. The read itself is
* capped by what is left of the inspection budget, and the pass charges the
* bytes it actually read, so a note that grew after the scan cannot make it
* read past `inspectMaxBytes`.
* @param rootDir - Configured notes directory.
* @param budget - Text, per-note, inspection-byte, and inspection-entry limits of the pass.
* @returns The notes to embed, the ones to list, and why the pass stayed partial.
* @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when the directory cannot be read.
*/
async function collectNotesForInjection(rootDir, budget) {
	const root = await existingRoot(rootDir);
	if (root === void 0) return NO_NOTES;
	const included = [];
	const remaining = [];
	const window = {
		remaining: budget.inspectMaxEntries,
		stopped: false
	};
	let includedBytes = 0;
	let inspectedBytes = 0;
	let unclassified = false;
	for (const entry of await scanNotes(root, "", window)) {
		const left = budget.inspectMaxBytes - inspectedBytes;
		if (left <= 0) {
			unclassified = true;
			continue;
		}
		const target = await confirmedScannedNote(root, entry);
		if (target === void 0) continue;
		const cap = Math.min(budget.maxSourceBytes, left);
		const inspected = await inspectNote(target.target, entry.path, cap);
		inspectedBytes += inspected.spent;
		const loaded = inspected.note;
		if (loaded === void 0) continue;
		if (loaded.size > cap && cap < budget.maxSourceBytes) {
			unclassified = true;
			continue;
		}
		const textBytes = Buffer.byteLength(loaded.text, NOTE_ENCODING);
		const carriedBytes = Buffer.byteLength(escapeFrameBody(loaded.text), NOTE_ENCODING) + Buffer.byteLength(escapeFrameBody(entry.path), NOTE_ENCODING) + budget.headingBytes;
		if (textBytes === 0 || includedBytes + carriedBytes > budget.injectMaxBytes) {
			remaining.push(entry);
			continue;
		}
		includedBytes += carriedBytes;
		included.push({
			...entry,
			text: loaded.text,
			truncated: loaded.truncated
		});
	}
	const partial = window.stopped ? "entries" : unclassified ? "bytes" : void 0;
	return {
		included,
		remaining,
		...partial === void 0 ? {} : { partial }
	};
}
/**
* Resolve a note path and prove the result stays inside the notes directory.
* @param root - Canonical notes directory.
* @param notePath - Note path as the caller supplied it.
* @returns The absolute target and its path relative to the directory.
* @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path names the
* directory itself or resolves outside it, or `SLEEP_NOTE_UNAVAILABLE` when it
* cannot be resolved.
*/
async function confinedTarget(root, notePath) {
	const segments = noteSegments(notePath);
	const candidate = isAbsolute(notePath) ? resolve(notePath) : join(root, ...segments);
	let target;
	try {
		target = await canonicalPath(candidate);
	} catch (error) {
		throw noteFailure(notePath, "resolve", error);
	}
	if (target === root) throw unsafePathError(notePath, "names the sleep notes directory itself");
	if (!isInside(root, target)) throw unsafePathError(notePath, "resolves outside the sleep notes directory");
	return {
		target,
		path: relative(root, target).split(sep).join("/")
	};
}
/**
* Resolve a destination note path and keep the spelling the caller asked for.
*
* The parent is canonicalized, so a link inside the tree cannot redirect the
* rename and a path that leaves the directory is refused. The final name stays as
* the caller spelled it: a name that already exists resolves to the spelling the
* filesystem keeps, which would erase a requested change of that spelling, and a
* case-insensitive host would then rename the entry onto itself and report a move
* that changed nothing.
* @param root - Canonical notes directory.
* @param notePath - New note path as the caller supplied it.
* @returns The requested path and its path relative to the directory.
* @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path names the
* directory itself or resolves outside it, or `SLEEP_NOTE_UNAVAILABLE` when it
* cannot be resolved.
*/
async function confinedDestination(root, notePath) {
	const segments = noteSegments(notePath);
	const candidate = isAbsolute(notePath) ? resolve(notePath) : join(root, ...segments);
	let parent;
	try {
		parent = await canonicalPath(dirname(candidate));
	} catch (error) {
		throw noteFailure(notePath, "resolve", error);
	}
	if (parent !== root && !isInside(root, parent)) throw unsafePathError(notePath, "resolves outside the sleep notes directory");
	const target = join(parent, basename(candidate));
	return {
		target,
		path: relative(root, target).split(sep).join("/")
	};
}
/**
* Prove again, immediately before the filesystem call, that a resolved target
* still spells the same path.
*
* Resolution and the operation are separate steps, so a parent directory
* replaced by a symbolic link between them would redirect the operation. The
* operation therefore re-resolves the target and refuses a different answer;
* it acts only on the path this function confirms. Node exposes no
* descriptor-relative call, so an ancestor swapped inside this function's own
* final gap remains possible, as the module documentation states.
* @param root - Canonical notes directory.
* @param target - Target resolved when the operation was prepared.
* @returns The same target, after resolving every segment again.
* @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path now resolves
* to a different location, or `SLEEP_NOTE_UNAVAILABLE` when it cannot be resolved.
*/
async function confirmedTarget(root, target) {
	let fresh;
	try {
		fresh = await canonicalPath(target.target);
	} catch (error) {
		throw noteFailure(target.path, "confirm", error);
	}
	if (fresh !== target.target || !isInside(root, fresh)) throw unsafePathError(target.path, "resolves to a different path after validation");
	return {
		target: fresh,
		path: target.path
	};
}
/**
* Prove one note the scan reported still resolves inside the notes directory.
*
* The injection pass scans the tree and then reads it, so a directory replaced
* by a symbolic link in between would make the read follow a path the scan
* never validated. The answer is the path the note resolves to now, which may
* be the note a link inside the tree names; a note that no longer resolves
* inside the directory is left out of the pass, exactly like a note the pass
* cannot classify.
* @param root - Canonical notes directory.
* @param entry - Note the scan reported.
* @returns The confirmed target, or `undefined` when it no longer stays inside.
*/
async function confirmedScannedNote(root, entry) {
	try {
		const fresh = await canonicalPath(absoluteNotePath(root, entry.path));
		return isInside(root, fresh) ? {
			target: fresh,
			path: entry.path
		} : void 0;
	} catch (error) {
		return;
	}
}
/**
* Read the symbolic link one note path names, if it names one.
*
* Resolution follows a link, so a path that names a listed link would otherwise
* be read as the note the link points at. The answer keeps the link's own
* spelling by canonicalizing its parent instead, and only a link that resolves
* inside the notes directory is answered; the operations that follow keep
* refusing a link that leaves it, or that names no existing file.
* @param root - Canonical notes directory.
* @param notePath - Note path as the caller supplied it.
* @returns The named link, or `undefined` when the path names any other kind of entry.
* @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path or the link leaves the
* directory, or `SLEEP_NOTE_UNAVAILABLE` when the entry cannot be read.
*/
async function namedLink(root, notePath) {
	const segments = noteSegments(notePath);
	const named = isAbsolute(notePath) ? resolve(notePath) : join(root, ...segments);
	let parent;
	try {
		parent = await canonicalPath(dirname(named));
	} catch (error) {
		throw noteFailure(notePath, "resolve", error);
	}
	if (parent !== root && !isInside(root, parent)) throw unsafePathError(notePath, "resolves outside the sleep notes directory");
	const entry = join(parent, basename(named));
	let info;
	try {
		info = await lstat(entry);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return void 0;
		throw noteFailure(notePath, "resolve", error);
	}
	if (!info.isSymbolicLink()) return void 0;
	let resolved;
	try {
		resolved = await realpath(entry);
	} catch (error) {
		return;
	}
	if (!isInside(root, resolved)) throw unsafePathError(notePath, "resolves outside the sleep notes directory");
	return {
		entry,
		path: relative(root, entry).split(sep).join("/"),
		target: resolved
	};
}
/**
* Remove one symbolic link entry without touching the note it names.
*
* The link's parent was canonicalized when the link was read; the removal proves
* it again immediately before the call, exactly as every other operation does.
* @param link - Link the caller named.
* @param notePath - Note path as the caller supplied it, used in failures.
* @returns The removed link entry, with no note files removed with it.
* @throws SleepError with code `SLEEP_PATH_UNSAFE` when the parent now resolves
* elsewhere, or `SLEEP_NOTE_UNAVAILABLE` when the link cannot be removed.
*/
async function removeNamedLink(link, notePath) {
	try {
		if (await canonicalPath(dirname(link.entry)) !== dirname(link.entry)) throw unsafePathError(notePath, "resolves to a different path after validation");
		await rm(link.entry);
	} catch (error) {
		throw noteFailure(notePath, "delete", error);
	}
	return {
		path: link.path,
		kind: "link",
		removedFiles: 0,
		removedBytes: 0,
		removedPaths: [],
		omittedPaths: 0
	};
}
/**
* Split a note path into its segments, refusing forms that could leave the directory.
* @param notePath - Note path as the caller supplied it.
* @returns The path segments, without empty or current-directory segments.
* @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path holds a NUL byte, a `..` segment, or no name at all.
*/
function noteSegments(notePath) {
	if (notePath.includes(NUL_CHARACTER)) throw unsafePathError(notePath, "contains a NUL byte");
	if (notePath.trim() === "") throw unsafePathError(notePath, "names no note");
	const segments = notePath.split(PATH_SEPARATOR$1);
	if (segments.includes(PARENT_SEGMENT)) throw unsafePathError(notePath, "must not contain a \"..\" segment");
	const named = segments.filter((segment) => segment !== "" && segment !== CURRENT_SEGMENT);
	if (named.length === 0) throw unsafePathError(notePath, "names no note");
	return named;
}
/**
* Resolve a path to its canonical spelling, including a part that does not exist yet.
*
* The nearest existing ancestor is the one realpath resolves, and the missing
* segments are re-appended, so the answer is stable before and after the
* intermediate directories are created.
* @param path - Absolute path to resolve.
* @returns The canonical path.
* @throws The filesystem failure that stopped the walk.
*/
async function canonicalPath(path) {
	const missing = [];
	let current = path;
	for (;;) {
		try {
			return join(await realpath(current), ...missing);
		} catch (error) {
			if (errnoCode(error) !== "ENOENT") throw error;
		}
		const parent = dirname(current);
		/* v8 ignore next -- the filesystem root always exists, so the walk stops before it. */
		if (parent === current) return path;
		missing.unshift(basename(current));
		current = parent;
	}
}
/**
* Whether one canonical path sits strictly inside the notes directory.
* @param root - Canonical notes directory.
* @param target - Canonical path to test.
* @returns `true` when the target is a path below the directory.
*/
function isInside(root, target) {
	const relativePath = relative(root, target);
	/* v8 ignore next -- POSIX never escapes through a drive letter; only a target on another Windows drive answers absolutely. */
	if (isAbsolute(relativePath)) return false;
	return relativePath !== "" && relativePath !== PARENT_SEGMENT && !relativePath.startsWith(`${PARENT_SEGMENT}${sep}`);
}
/**
* Whether two canonical paths name one entry on this host.
*
* A host that compares path names without case resolves a requested change of
* spelling to the file that is already there, so both spellings then name the
* entry the note occupies; on a case-sensitive host the spellings differ exactly
* when the entries do.
* @param left - First canonical path.
* @param right - Second canonical path.
* @returns `true` when both name one entry.
*/
function samePath(left, right) {
	/* v8 ignore next -- the platform fixes this comparison, so only one arm runs on any host */
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
/**
* Read the note directory as it is, without creating it.
* @param rootDir - Configured notes directory.
* @returns The canonical directory, or `undefined` when it does not exist.
* @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when the directory exists but cannot be resolved.
*/
async function existingRoot(rootDir) {
	try {
		return await realpath(resolve(rootDir));
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return void 0;
		throw noteFailure(rootDir, "open the notes directory", error);
	}
}
/**
* Read the note directory as it is, refusing a directory that does not exist.
* @param rootDir - Configured notes directory.
* @returns The canonical directory.
* @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when the directory is absent or cannot be resolved.
*/
async function requiredRoot(rootDir) {
	const root = await existingRoot(rootDir);
	if (root === void 0) throw noteUnavailableError(rootDir, "the notes directory does not exist");
	return root;
}
/**
* Create the notes directory when it is missing and read its canonical spelling.
*
* The directories are created with user-only permissions, so other local users
* cannot list note names where the platform enforces modes. An existing
* directory keeps the mode it has: this operation creates, and never changes
* permissions of, a directory the user already owns.
* @param rootDir - Configured notes directory.
* @returns The canonical directory.
* @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when the directory cannot be created or resolved.
*/
async function ensureNotesDirectory(rootDir) {
	try {
		await mkdir(resolve(rootDir), {
			recursive: true,
			mode: NOTE_DIR_MODE
		});
	} catch (error) {
		throw noteFailure(rootDir, "create the notes directory", error);
	}
	return await requiredRoot(rootDir);
}
/**
* List the regular files below one directory of the notes tree.
* @param root - Canonical notes directory.
* @param relativeDir - Directory being listed, relative to the root, or `''` for the root itself.
* @param window - Entry budget of a bounded walk, or `undefined` for an unbounded one.
* @returns The notes found below that directory, ordered by path.
* @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when a directory cannot be read.
*/
async function scanNotes(root, relativeDir, window) {
	const label = relativeDir === "" ? "." : relativeDir;
	try {
		return await scanDirectory(root, relativeDir, window);
	} catch (error) {
		throw noteFailure(label, "read the directory", error);
	}
}
/**
* List the entries a recursive delete removes below one directory.
*
* The report must state what actually went: a symbolic link inside the removed
* directory is removed as the entry it is, so the note it names outside the
* deleted tree stays and is not counted. Each subdirectory is proved again
* before it is opened, exactly as the note scan does.
* @param root - Canonical notes directory.
* @param relativeDir - Directory being removed, relative to the root.
* @returns The removed entries in path order.
* @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when a directory cannot be read.
*/
async function scanRemovedEntries(root, relativeDir) {
	try {
		return await walkRemovedEntries(root, relativeDir);
	} catch (error) {
		throw noteFailure(relativeDir, "read the directory", error);
	}
}
/**
* Walk one directory of the tree a recursive delete removes.
* @param root - Canonical notes directory.
* @param relativeDir - Directory being walked, relative to the root.
* @returns The removed entries under that directory, ordered by path.
* @throws The filesystem failure that stopped the walk.
*/
async function walkRemovedEntries(root, relativeDir) {
	const directory = absoluteNotePath(root, relativeDir);
	const openedDirectory = await containedDirectory(root, directory);
	if (openedDirectory === void 0) return [];
	const handle = await opendir(openedDirectory);
	const entries = [];
	for await (const entry of handle) {
		const path = `${relativeDir}/${entry.name}`;
		if (entry.isDirectory()) entries.push(...await scanRemovedEntries(root, path));
		else if (entry.isSymbolicLink()) entries.push({
			path,
			bytes: 0,
			kind: "link"
		});
		else {
			const info = await stat(join(directory, entry.name));
			entries.push({
				path,
				bytes: info.size,
				kind: "file"
			});
		}
	}
	return entries.sort((left, right) => compareNotePaths(left.path, right.path));
}
/**
* Walk one directory of the notes tree and collect the notes below it.
*
* A subdirectory is proved again immediately before it is opened: the entry that
* reported it as a directory can have been replaced by a symbolic link since the
* listing, and opening it would otherwise list names and sizes outside the notes
* directory.
* @param root - Canonical notes directory.
* @param relativeDir - Directory being listed, relative to the root, or `''` for the root itself.
* @param window - Entry budget of a bounded walk, or `undefined` for an unbounded one.
* @returns The notes found below that directory, ordered by path.
* @throws The filesystem failure that stopped the walk.
*/
async function scanDirectory(root, relativeDir, window) {
	const directory = relativeDir === "" ? root : absoluteNotePath(root, relativeDir);
	const openedDirectory = relativeDir === "" ? directory : await containedDirectory(root, directory);
	if (openedDirectory === void 0) return [];
	const handle = await opendir(openedDirectory);
	const notes = [];
	for await (const entry of handle) {
		if (window !== void 0) {
			if (window.remaining === 0) {
				window.stopped = true;
				break;
			}
			window.remaining -= 1;
		}
		const notePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
		const target = join(directory, entry.name);
		if (entry.isDirectory()) {
			notes.push(...await scanNotes(root, notePath, window));
			if (window?.stopped === true) break;
		} else if (entry.isSymbolicLink()) {
			const linked = await linkedNote(root, target, notePath);
			if (linked !== void 0) notes.push(linked);
		} else {
			let info;
			try {
				info = await stat(target);
			} catch (error) {
				if (errnoCode(error) === "ENOENT") continue;
				throw error;
			}
			if (info.isFile()) notes.push({
				path: notePath,
				bytes: info.size,
				mtimeMs: info.mtimeMs
			});
		}
	}
	return notes.sort((left, right) => compareNotePaths(left.path, right.path));
}
/**
* Resolve one subdirectory of the scan and prove it stays inside the notes directory.
*
* The scan lists the tree and then enters each directory it found, so a
* directory replaced by a symbolic link in between would make the walk list a
* location the scan never validated.
* @param root - Canonical notes directory.
* @param directory - Absolute directory the scan is about to open.
* @returns The canonical directory, or `undefined` when it leaves the notes directory.
* @throws The filesystem failure that stopped the resolution.
*/
async function containedDirectory(root, directory) {
	const resolved = await canonicalPath(directory);
	return isInside(root, resolved) ? resolved : void 0;
}
/**
* Describe a symbolic link that resolves to a regular file inside the directory.
* @param root - Canonical notes directory.
* @param target - Absolute path of the link.
* @param notePath - Link path relative to the notes directory.
* @returns The note the link names, or `undefined` when it leaves the directory or names no regular file.
*/
async function linkedNote(root, target, notePath) {
	try {
		const resolved = await realpath(target);
		if (!isInside(root, resolved)) return void 0;
		const info = await stat(resolved);
		if (!info.isFile()) return void 0;
		return {
			path: notePath,
			bytes: info.size,
			mtimeMs: info.mtimeMs
		};
	} catch (error) {
		return;
	}
}
/**
* Order two note paths.
*
* The order is by Unicode code unit, which is total: two distinct paths never
* compare equal. A collation order cannot page a listing, because
* `localeCompare` reports two canonically equivalent spellings as equal and
* depends on the runtime locale, so a page cursor compared with it would drop
* the note on the other side of that tie.
* @param left - First note path.
* @param right - Second note path.
* @returns A negative number when the first path sorts first, `0` for the same path, or a positive number.
*/
function compareNotePaths(left, right) {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}
/**
* Read the size and modification time of a note.
* @param note - Resolved note.
* @returns The note with its current size and modification time.
* @throws The filesystem failure that stopped the read.
*/
async function describeNote(note) {
	const info = await stat(note.target);
	return {
		path: note.path,
		bytes: info.size,
		mtimeMs: info.mtimeMs
	};
}
/**
* Read the modification time of a note that was just written.
*
* The write already landed, so a metadata read that fails reports no time
* instead of turning the committed write into a failed one.
* @param note - Resolved note.
* @returns The modification time, or nothing when the note cannot be read.
*/
async function writtenMtime(note) {
	try {
		return { mtimeMs: (await stat(note.target)).mtimeMs };
	} catch (error) {
		return {};
	}
}
/**
* Whether one destination path already holds a note.
*
* A dangling symbolic link at that path is not a note, so it reports false; a
* rename still replaces the link entry, which removes nothing a reader could
* open.
* @param target - Absolute destination path.
* @returns `true` when the path names an existing note.
* @throws The filesystem failure that is not an absent path.
*/
async function noteExists(target) {
	try {
		await stat(target);
		return true;
	} catch (error) {
		/* v8 ignore next -- a non-ENOENT stat failure on a canonicalized destination is an external I/O fault */
		if (errnoCode(error) !== "ENOENT") throw error;
		return false;
	}
}
/**
* Summarize the note files one deletion removed.
*
* Only note files count: a symbolic link inside the removed tree went with it,
* but the note it named did not, so neither its path nor its target's bytes
* belong in a report about removed notes.
* @param removed - Removed entries in path order.
* @returns The note-file counts, the total size, and the removed note paths up to the reporting bound.
*/
function deleteSummary(removed) {
	const files = removed.filter((entry) => entry.kind === "file");
	let removedBytes = 0;
	for (const note of files) removedBytes += note.bytes;
	return {
		removedFiles: files.length,
		removedBytes,
		removedPaths: files.slice(0, DELETED_PATHS_LIMIT).map((note) => note.path),
		omittedPaths: Math.max(0, files.length - DELETED_PATHS_LIMIT)
	};
}
/**
* Read a note as UTF-8 text, at most `maxBytes` of it.
* @param note - Resolved note.
* @param maxBytes - Maximum bytes read.
* @param progress - Receives the bytes read so far, so a failed read still reports its cost.
* @returns The decoded text, the byte cap's verdict, the note's size, and the bytes read.
* @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when the note is absent, not a regular file, or unreadable.
*/
async function loadNote(note, maxBytes, progress) {
	const loaded = await readNoteBytes(note, maxBytes, progress);
	const truncated = loaded.size > maxBytes;
	return {
		text: decodeNoteText(loaded.bytes, truncated),
		truncated,
		size: loaded.size,
		read: loaded.bytes.byteLength
	};
}
/**
* Read one note for the injection pass, charging the bytes the attempt cost.
*
* A note the pass cannot offer is reported without text, so the caller leaves
* it out of both lists. The read window bounds every attempt, so a note that
* grew after the scan cannot cost more than the budget still holds, and a read
* that fails partway charges the bytes it did consume.
* @param target - Absolute path of the note.
* @param notePath - Note path relative to the notes directory.
* @param maxBytes - Maximum bytes the read window holds.
* @returns The note, or why the pass cannot offer it, and the bytes charged.
*/
async function inspectNote(target, notePath, maxBytes) {
	const progress = { read: 0 };
	let loaded;
	try {
		loaded = await loadNote({
			target,
			path: notePath
		}, maxBytes, progress);
	} catch (error) {
		return {
			note: void 0,
			spent: progress.read
		};
	}
	if (loaded.text === void 0) return {
		note: void 0,
		spent: loaded.read
	};
	return {
		note: {
			text: loaded.text,
			truncated: loaded.truncated,
			size: loaded.size
		},
		spent: loaded.read
	};
}
/**
* Read the first bytes of a note.
*
* The file is proved again after the open: an ancestor directory replaced by a
* symbolic link between the containment check and the open would make the open
* read a different file, and that file reports a different identity. The size
* comes from the opened file rather than the check before it, so a note whose
* content grew between those two steps is read as it is now.
* @param note - Resolved note.
* @param maxBytes - Maximum bytes read.
* @param progress - Receives the bytes read so far, including a read that fails partway.
* @returns The bytes read, which can be fewer when the note shrank, and the size of the opened file.
* @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when the note is absent,
* not a regular file, not the file the path check described, or unreadable.
*/
async function readNoteBytes(note, maxBytes, progress) {
	let handle;
	try {
		const info = await stat(note.target);
		if (!info.isFile()) throw noteUnavailableError(note.path, "not a regular file");
		handle = await open(note.target, NOTE_READ_FLAGS);
		const opened = await handle.stat();
		if (!sameFile(info, opened)) throw noteUnavailableError(note.path, "the opened file is not the one the path check described");
		const count = Math.min(opened.size, maxBytes);
		const buffer = new Uint8Array(count);
		let read = 0;
		while (read < count) {
			const part = await handle.read(buffer, read, count - read, read);
			/* v8 ignore next -- a regular file that did not shrink since the descriptor was read fills the range */
			if (part.bytesRead === 0) break;
			read += part.bytesRead;
			progress.read = read;
		}
		return {
			bytes: buffer.subarray(0, read),
			size: opened.size
		};
	} catch (error) {
		throw noteFailure(note.path, "read", error);
	} finally {
		await handle?.close().catch((error) => {});
	}
}
/**
* Whether two filesystem stat results describe the same file.
*
* `dev` and `ino` are the identity a stat reports. A platform or filesystem that
* reports no inode number cannot answer, so the check accepts the pair and the
* containment check before the open stays the only defence there.
* @param before - Stat of the note path taken before the open.
* @param opened - Stat of the opened descriptor.
* @returns `true` when both results describe one file.
*/
function sameFile(before, opened) {
	if (before.ino === 0 || opened.ino === 0) return true;
	return before.ino === opened.ino && before.dev === opened.dev;
}
/**
* Decode note bytes, refusing anything that is not UTF-8 text.
* @param bytes - Bytes read from the note.
* @param truncated - Whether the byte cap cut the note, so its tail may end inside one character.
* @returns The text, or `undefined` when the bytes are not UTF-8 text.
*/
function decodeNoteText(bytes, truncated) {
	if (bytes.includes(NUL_BYTE)) return void 0;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	try {
		return truncated ? decoder.decode(bytes, { stream: true }) : decoder.decode(bytes);
	} catch (error) {
		return;
	}
}
/**
* Split note text into its lines.
* @param text - Note text.
* @returns The lines, without the terminator of the last one.
*/
function splitLines(text) {
	if (text === "") return [];
	return text.replace(TRAILING_LINE_BREAK, "").split(LINE_BREAK);
}
/**
* Report one failed note operation, naming the errno the filesystem reported.
* @param notePath - Note path as the caller supplied it.
* @param operation - Operation that failed, in the imperative voice.
* @param error - Failure the filesystem raised.
* @returns The coded note failure, with the original failure as its cause.
*/
function noteFailure(notePath, operation, error) {
	if (error instanceof SleepError) return error;
	return noteUnavailableError(notePath, `cannot ${operation} (${errnoCode(error)})`, { cause: error });
}
/**
* Read the errno code of a filesystem failure.
* @param error - Failure the filesystem raised.
* @returns The errno code, or `unknown` when the failure carries none.
*/
function errnoCode(error) {
	const code = error?.code;
	/* v8 ignore next -- a Node filesystem call reports an errno string; the fallback only keeps a foreign failure readable. */
	return typeof code === "string" ? code : "unknown";
}
/**
* Join a directory and a relative note path.
* @param root - Canonical notes directory.
* @param notePath - Note path relative to the directory, with `/` separators.
* @returns The absolute path of the note.
*/
function absoluteNotePath(root, notePath) {
	return join(root, ...notePath.split("/"));
}
//#endregion
//#region lib/types/command.js
/**
* Human-facing `/sleep` command.
*
* `/sleep` and `/sleep now` start one manual sleep, and `/sleep status` reports
* what the runtime already knows without starting anything. The status text
* names the schedule, the last attempt, the next slot, the run in progress, and
* the notes directory, so a user can check the cycle from the composer.
*
* A manual run ignores `enabled` and `minSessions`: the user asked for it. A
* run that cannot start - because one is already active, or because the plugin
* is unloading - becomes an error result instead of a rejected command.
* @module @deepseek-ai/dsh-sleep/command
*/
/** Every accepted spelling, in the order the usage line and the input hint list them. */
const SLEEP_ARGUMENTS = [
	{
		spelling: "",
		action: "run"
	},
	{
		spelling: "now",
		action: "run"
	},
	{
		spelling: "status",
		action: "status"
	}
];
/** Accepted spellings between brackets, as the input hint and the usage line spell them. */
const ARGUMENT_HINT = `[${SLEEP_ARGUMENTS.map((argument) => argument.spelling).filter((spelling) => spelling !== "").join("|")}]`;
/** Usage line for an invocation no spelling accepts. */
const USAGE = `Usage: /sleep ${ARGUMENT_HINT}`;
/** Milliseconds in one minute, for the pending-delay wording. */
const MS_PER_MINUTE = 6e4;
/** Minutes in one hour, for the pending-delay wording. */
const MINUTES_PER_HOUR = 60;
/**
* Register `/sleep` wherever a command registry is composed.
*
* The registration belongs to an injected child, so a Host without a command
* surface keeps the scheduled sleep and the memory injection and simply has no
* `/sleep` to answer.
* @param ctx - Host context carrying the runtime.
* @param service - Runtime the command reports on and starts.
*/
function installSleepCommand(ctx, service) {
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.commands.register({
			definitionId: CommandDefinitionId("@deepseek-ai/dsh-sleep"),
			name: "sleep",
			description: "Run the daily reflective sleep now, or show its status",
			input: { hint: ARGUMENT_HINT },
			handler: (invocation) => executeSleepCommand(service, invocation.rawInput.trim())
		});
	});
}
/**
* Answer one `/sleep` invocation.
* @param service - Runtime the command reports on and starts.
* @param request - Trimmed text after the command name.
* @returns The command result for this invocation.
*/
async function executeSleepCommand(service, request) {
	const argument = SLEEP_ARGUMENTS.find((candidate) => candidate.spelling === request);
	if (argument === void 0) return {
		kind: "error",
		text: USAGE
	};
	return argument.action === "status" ? await reportStatus(service) : await startSleep(service);
}
/**
* Start one manual run and report it without waiting for the reflection.
*
* A sleep run takes minutes, while the surface that ran `/sleep` waits for this
* handler. The run therefore outlives the invocation: the command answers with
* the Session the run started, and `/sleep status` reports how it ended. Only an
* attempt that ended before it had a Session is awaited to completion, because
* its outcome is already known and a started-run answer would hide a failure.
* @param service - Runtime that owns the run.
* @returns A result naming the started run, the finished attempt, or a refusal.
*/
async function startSleep(service) {
	try {
		const run = service.startNow();
		const sessionId = await run.started;
		if (sessionId === null) return describeRun(await run.settled);
		return {
			kind: "success",
			text: `Sleep started in Session ${sessionId}; /sleep status reports how it ends.`
		};
	} catch (error) {
		if (error instanceof SleepError) return {
			kind: "error",
			text: error.message
		};
		throw error;
	}
}
/**
* Render one finished attempt.
*
* A skipped run failed at nothing, so it settles as a success that says nothing
* happened; only a failed run reports an error.
* @param result - The attempt's result.
* @returns The command result describing the attempt.
*/
function describeRun(result) {
	const where = result.sessionId === null ? "" : ` in Session ${result.sessionId}`;
	if (result.status === "completed") return {
		kind: "success",
		text: `Sleep completed${where}.`
	};
	if (result.status === "skipped") return {
		kind: "success",
		text: `Sleep skipped${where}: ${result.reason ?? "no reason was recorded"}.`
	};
	return {
		kind: "error",
		text: `Sleep failed${where}: ${result.reason ?? "no reason was recorded"}.`
	};
}
/**
* Report the runtime's schedule, history, and notes.
*
* Every line is read from the service on this call: the durable state, the
* slot the timer is waiting for, and a fresh scan of the notes directory. A
* notes directory this Host cannot read is reported instead of failing the
* status.
* @param service - Runtime that reports the status.
* @returns The status text.
*/
async function reportStatus(service) {
	const { config, state } = service;
	const stateError = service.stateError;
	return {
		kind: "success",
		text: [
			`Schedule: ${describeSchedule(service)}`,
			`Last completed sleep: ${state.lastSleepAt ?? "never"}`,
			`Last outcome: ${describeOutcome(state.lastOutcome)}`,
			...stateError === null ? [] : [`Durable state: unavailable (${stateError})`],
			`Next slot: ${describeNextSlot(service)}`,
			`Active run: ${describeActiveRun(service)}`,
			`Notes: ${await describeNotes(config.dir)}`
		].join("\n")
	};
}
/**
* Describe the run that holds the runtime's slot.
*
* A run claims the slot before it creates its Session, so a status read in that
* window names the starting run instead of reporting that no run is active.
* @param service - Runtime that owns the run.
* @returns The Session the run drives, the starting state before it has one, or none.
*/
function describeActiveRun(service) {
	if (!service.activeRun) return "none";
	return service.activeSessionId ?? "starting";
}
/**
* Describe the configured slot.
* @param service - Runtime that carries the configuration.
* @returns The slot and its zone, or the disabled state.
*/
function describeSchedule(service) {
	const { config } = service;
	return config.enabled ? `daily at ${config.time} ${config.timeZone}` : "off; /sleep now still runs a manual sleep";
}
/**
* Describe the last attempt.
* @param outcome - Recorded outcome, or `null` before the first attempt.
* @returns One line naming what happened.
*/
function describeOutcome(outcome) {
	if (outcome === null) return "none yet";
	const where = outcome.sessionId === void 0 ? "" : ` in Session ${outcome.sessionId}`;
	const reason = outcome.reason === void 0 ? "" : `: ${outcome.reason}`;
	return `${outcome.status} at ${outcome.at} (${outcome.trigger})${where}${reason}`;
}
/**
* Describe when the timer next fires.
* @param service - Runtime that arms the timer.
* @returns The next slot's instant and delay, the due-now case, or the disabled state.
*/
function describeNextSlot(service) {
	const slot = service.nextSlot();
	if (slot === null) return "scheduled runs are off";
	if (slot.delayMs === 0) return "due now; today's slot passed without a recorded run";
	return `${new Date(slot.at).toISOString()} (in ${formatDelay(slot.delayMs)})`;
}
/**
* Render a delay as whole minutes and hours.
* @param delayMs - Delay in milliseconds.
* @returns The delay, such as `3 h 5 min`.
*/
function formatDelay(delayMs) {
	const minutes = Math.round(delayMs / MS_PER_MINUTE);
	const hours = Math.floor(minutes / MINUTES_PER_HOUR);
	return hours === 0 ? `${minutes} min` : `${hours} h ${minutes % MINUTES_PER_HOUR} min`;
}
/**
* Describe the notes directory as it stands.
* @param dir - Absolute notes directory.
* @returns The file count, the total bytes, and the directory.
*/
async function describeNotes(dir) {
	try {
		const notes = await listNotes(dir);
		const bytes = notes.reduce((total, note) => total + note.bytes, 0);
		return `${notes.length} files, ${bytes} bytes in ${dir}`;
	} catch (error) {
		/* v8 ignore next -- listNotes reports every filesystem failure as a SleepError, so only that class reaches here */
		if (!(error instanceof SleepError)) throw error;
		return `unavailable (${error.message}) in ${dir}`;
	}
}
//#endregion
//#region lib/types/schedule-math.js
/**
* Daily schedule arithmetic for the sleep plugin.
*
* The plugin stores one wall-clock slot and asks this module when that slot is
* due in an explicit IANA zone. Zone and calendar rules come from
* `@deepseek-ai/dsh-util-time`: `parseLocalCalendar` validates the clock text,
* `resolveLocalInstant` turns a local wall clock into an instant, and
* `canonicalizeTimeZone` refuses a zone name the platform cannot use. Every
* entry takes the caller's clock reading as epoch milliseconds, so a test never
* reads the system time.
* @module @deepseek-ai/dsh-sleep/schedule-math
*/
/**
* Date the shared clock parser needs to validate an `HH:mm` slot. The parser
* takes a date and a time together, so this leap-year date stands in; only the
* clock fields are read back.
*/
const CLOCK_ANCHOR_DATE = "2000-01-01";
/**
* Consecutive local dates {@link nextDelayMs} inspects for an existing
* wall-clock slot. A forward transition removes a given clock time on at most
* one date, so the second date answers; the bound only stops a hypothetical
* zone that removes the slot on every date.
*/
const SLOT_SEARCH_DAYS = 8;
/**
* Parse the configured `HH:mm` daily slot into clock fields.
*
* The shared local-calendar parser validates the text, so the plugin row and
* the daily timer accept exactly the same spelling.
* @param value - Slot text, such as `03:00`, after trimming.
* @returns The hour and minute of the slot.
* @throws SleepError with code `SLEEP_CONFIG_INVALID` when the text is not a zero-padded 24-hour clock time.
*/
function parseDailyTime(value) {
	const parsed = parseLocalCalendar(CLOCK_ANCHOR_DATE, `${value}:00`);
	if (parsed.kind === "rejected") throw invalidConfigError("time", `expected a 24-hour HH:mm slot, received ${JSON.stringify(value)}`);
	return {
		hour: parsed.time.hour,
		minute: parsed.time.minute
	};
}
/**
* Project one instant onto the local calendar date of an explicit zone.
*
* The key is the spelling the plugin stores for the day of the last scheduled
* run, so the fixed `YYYY-MM-DD` form compares correctly as text.
* @param ms - Instant in epoch milliseconds.
* @param timeZone - IANA zone the sleep schedule follows.
* @returns The zone-local calendar date as `YYYY-MM-DD`.
* @throws SleepError with code `SLEEP_CONFIG_INVALID` when the zone is unusable.
*/
function localDateKey(ms, timeZone) {
	return formatLocalDate(localCalendarDate(ms, scheduleZone(timeZone)));
}
/**
* Milliseconds until the next run of the daily slot.
*
* A slot that passed before today's run was recorded answers `0`, so the caller
* starts the catch-up at once instead of waiting for the next date. A record
* dated later than today means the host clock moved back: the run waits for the
* first date the record leaves open instead of repeating a recorded date. A slot
* that the zone removed on a date - a forward transition can drop a wall-clock
* time - is skipped.
* @param nowMs - Current instant in epoch milliseconds.
* @param time - Daily slot as `HH:mm`.
* @param timeZone - IANA zone the sleep schedule follows.
* @param lastScheduledDate - Zone-local date key of the last scheduled run, or `null` when none is recorded.
* @returns The delay in milliseconds, from `0` through `MAX_TIMER_DELAY_MS`. The
* delay is never negative and never exceeds the largest delay the platform timer
* accepts: a record the clock moved far behind, and a zone that hides the slot
* on every searched date, both answer that maximum, and the caller re-plans when
* the timer fires.
* @throws SleepError when the slot text or the zone is unusable.
*/
function nextDelayMs(nowMs, time, timeZone, lastScheduledDate) {
	const zone = scheduleZone(timeZone);
	const daily = parseDailyTime(time);
	const today = localCalendarDate(nowMs, zone);
	let delay = MAX_TIMER_DELAY_MS;
	let date = firstPendingDate(today, lastScheduledDate);
	for (let step = 0; step < SLOT_SEARCH_DAYS; step += 1) {
		const slot = slotInstant(date, daily, zone);
		if (slot !== void 0) {
			delay = Math.min(Math.max(slot - nowMs, 0), MAX_TIMER_DELAY_MS);
			break;
		}
		date = addDays(date, 1);
	}
	return delay;
}
/**
* First local date the schedule may still act on.
*
* Today is pending until a run is recorded for it. When the record names today
* or a later date - the clock moved back behind it - the next date is the day
* after the later of the two, so a recorded date is never armed again.
* @param today - Zone-local calendar date of the current instant.
* @param lastScheduledDate - Stored date key, or `null` when none is recorded.
* @returns The earliest date that can carry the next run.
*/
function firstPendingDate(today, lastScheduledDate) {
	const todayKey = formatLocalDate(today);
	if (lastScheduledDate === null || lastScheduledDate < todayKey) return today;
	return addDays(lastScheduledDate > todayKey ? parseLocalDate(lastScheduledDate) : today, 1);
}
/**
* Read a stored local date key back into its calendar date.
* @param dateKey - Date as `YYYY-MM-DD`.
* @returns The calendar date the key spells.
*/
function parseLocalDate(dateKey) {
	return {
		year: Number(dateKey.slice(0, 4)),
		month: Number(dateKey.slice(5, 7)),
		day: Number(dateKey.slice(8, 10))
	};
}
/**
* Resolve the schedule zone once, so an unusable name fails as a sleep failure
* instead of as an `Intl` range error.
* @param timeZone - Zone text from the plugin row.
* @returns The canonical IANA zone.
* @throws SleepError with code `SLEEP_CONFIG_INVALID` when the name is not a zone the platform knows.
*/
function scheduleZone(timeZone) {
	const resolved = canonicalizeTimeZone(timeZone);
	if (resolved.kind === "rejected") throw invalidConfigError("timeZone", `expected an IANA zone, received ${JSON.stringify(timeZone)} (${resolved.reason})`);
	return resolved.timeZone;
}
/**
* Project one instant onto its local calendar date in an explicit zone.
* @param ms - Instant in epoch milliseconds.
* @param timeZone - Canonical IANA zone.
* @returns The zone-local calendar date.
*/
function localCalendarDate(ms, timeZone) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).formatToParts(ms);
	const fields = {};
	for (const part of parts) fields[part.type] = part.value;
	return {
		year: Number(fields["year"]),
		month: Number(fields["month"]),
		day: Number(fields["day"])
	};
}
/**
* Render one local calendar date as the stored date key.
* @param date - Zone-local calendar date.
* @returns The date as `YYYY-MM-DD`.
*/
function formatLocalDate(date) {
	return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}
/**
* Shift one local calendar date by whole days.
* @param date - Zone-local calendar date.
* @param days - Number of days to add; a negative value moves back.
* @returns The shifted calendar date.
*/
function addDays(date, days) {
	const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth() + 1,
		day: shifted.getUTCDate()
	};
}
/**
* Resolve the daily slot on one local date.
* @param date - Zone-local calendar date.
* @param daily - Clock fields of the slot.
* @param timeZone - Canonical IANA zone.
* @returns The slot instant in epoch milliseconds, or `undefined` when the zone does not have that wall-clock time.
*/
function slotInstant(date, daily, timeZone) {
	return resolveLocalInstant({
		year: date.year,
		month: date.month,
		day: date.day,
		hour: daily.hour,
		minute: daily.minute,
		second: 0,
		millisecond: 0
	}, timeZone);
}
//#endregion
//#region lib/types/config.js
/**
* Configuration contract of the daily sleep plugin.
*
* The Cordis row supplies a partially defaulted {@link Config}; {@link resolveConfig}
* turns it into the runtime values every other module reads. Time, zone, the
* notes directory, byte limits, and the two identity names are normalized once
* here, so no consumer repeats a default or re-validates a value.
* @module @deepseek-ai/dsh-sleep/config
*/
/** Scheduled runs are enabled unless the row disables them. */
const DEFAULT_ENABLED = true;
/** Fallback daily slot, written to the same `HH:mm` form the row accepts. */
const DEFAULT_TIME = "03:00";
/** One new non-sleep Session is enough evidence that the day holds something to reflect on. */
const DEFAULT_MIN_SESSIONS = 1;
/** Note texts loaded into a working Session start here; 16 KiB keeps the injected block small. */
const DEFAULT_INJECT_MAX_BYTES = 16384;
/** Ceiling for one note read, matching the workspace instruction loader's per-file cap. */
const DEFAULT_MAX_SOURCE_BYTES = 1048576;
/**
* Bytes of note content one injection pass may read to classify notes as text
* or binary. The pass drops a note it cannot classify within the budget, so a
* large notes tree cannot stall a step.
*/
const DEFAULT_INSPECT_MAX_BYTES = 4194304;
/**
* Directory entries one injection pass may examine while it lists the notes
* tree. The walk stops when the count is spent, so many small notes cost the
* same bounded work as a few large ones.
*/
const DEFAULT_INSPECT_MAX_ENTRIES = 1024;
/** Preset name the shipped `cordis.patch.yml` composes. */
const DEFAULT_PRESET_ID = "sleep";
/** Highest reasoning effort the sleep Session requests. */
const DEFAULT_REASONING_EFFORT = "max";
/** Zone used when neither the row nor the host names a usable IANA zone. */
const FALLBACK_TIME_ZONE = "UTC";
/** Loader-validated sleep row; defaults are applied again by {@link resolveConfig}. */
const Config = z.object({
	dir: z.string().required(),
	enabled: z.boolean().default(DEFAULT_ENABLED),
	time: z.string().default(DEFAULT_TIME),
	timeZone: z.string(),
	minSessions: z.number().step(1).min(0).default(DEFAULT_MIN_SESSIONS),
	injectMaxBytes: z.number().step(1).min(1).default(DEFAULT_INJECT_MAX_BYTES),
	maxSourceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_BYTES),
	inspectMaxBytes: z.number().step(1).min(1).default(DEFAULT_INSPECT_MAX_BYTES),
	inspectMaxEntries: z.number().step(1).min(1).default(DEFAULT_INSPECT_MAX_ENTRIES),
	presetId: z.string().default(DEFAULT_PRESET_ID),
	reasoningEffort: z.string().default(DEFAULT_REASONING_EFFORT)
});
/**
* Normalize the plugin row into runtime values.
*
* Defaults apply to omitted fields only. A configured value that violates the
* contract fails here instead of degrading later, so a bad `time` or a
* misspelled zone stops the plugin at load.
* @param config - Plugin row after loader validation.
* @param options - Host zone used when the row leaves `timeZone` blank.
* @returns Every field required, with `timeZone` canonical.
* @throws SleepError with code `SLEEP_CONFIG_INVALID` when a value cannot be used.
*/
function resolveConfig(config, options = {}) {
	return {
		dir: resolveDir(config.dir),
		enabled: config.enabled ?? DEFAULT_ENABLED,
		time: resolveTime(config.time),
		timeZone: resolveTimeZone(config.timeZone, options.hostTimeZone),
		minSessions: resolveInteger(config.minSessions, DEFAULT_MIN_SESSIONS, "minSessions", 0),
		injectMaxBytes: resolveInteger(config.injectMaxBytes, DEFAULT_INJECT_MAX_BYTES, "injectMaxBytes", 1),
		maxSourceBytes: resolveInteger(config.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES, "maxSourceBytes", 1),
		inspectMaxBytes: resolveInteger(config.inspectMaxBytes, DEFAULT_INSPECT_MAX_BYTES, "inspectMaxBytes", 1),
		inspectMaxEntries: resolveInteger(config.inspectMaxEntries, DEFAULT_INSPECT_MAX_ENTRIES, "inspectMaxEntries", 1),
		presetId: resolveName(config.presetId, DEFAULT_PRESET_ID, "presetId"),
		reasoningEffort: resolveName(config.reasoningEffort, DEFAULT_REASONING_EFFORT, "reasoningEffort")
	};
}
/**
* Read the note directory.
* @param value - Configured directory text.
* @returns The directory as an absolute path.
* @throws SleepError when the text is empty.
*/
function resolveDir(value) {
	const dir = value.trim();
	if (dir === "") throw invalidConfigError("dir", "must name the directory that holds the sleep notes");
	return resolve(dir);
}
/**
* Read the daily slot.
* @param value - Configured `HH:mm` text, or `undefined` to take the default.
* @returns The slot in zero-padded `HH:mm` form.
* @throws SleepError when the text is not a 24-hour clock time.
*/
function resolveTime(value) {
	const time = (value ?? DEFAULT_TIME).trim();
	parseDailyTime(time);
	return time;
}
/**
* Read the schedule zone.
*
* A configured zone must canonicalize, because the stored schedule and every
* later comparison depend on one spelling. The host zone is only a
* convenience, so an unusable host value degrades to `UTC` instead of failing.
* @param configured - Configured zone text, or `undefined` when the row omits it.
* @param hostTimeZone - Zone the running host reports.
* @returns The canonical zone, or `UTC` when nothing usable is configured.
* @throws SleepError when a configured zone is not a known IANA zone.
*/
function resolveTimeZone(configured, hostTimeZone) {
	const explicit = configured?.trim() ?? "";
	if (explicit !== "") {
		const resolved = canonicalizeTimeZone(explicit);
		if (resolved.kind === "rejected") throw invalidConfigError("timeZone", `expected an IANA zone or UTC, received ${JSON.stringify(explicit)} (${resolved.reason})`);
		return resolved.timeZone;
	}
	const host = hostTimeZone?.trim() ?? "";
	if (host !== "") {
		const resolved = canonicalizeTimeZone(host);
		if (resolved.kind === "accepted") return resolved.timeZone;
	}
	return FALLBACK_TIME_ZONE;
}
/**
* Read one integer bound with a lower limit.
* @param value - Configured value, or `undefined` to take the default.
* @param fallback - Default applied to an omitted field.
* @param field - Field name used in the diagnostic.
* @param minimum - Smallest accepted value.
* @returns The configured or default value.
* @throws SleepError when the value is not an integer of at least `minimum`.
*/
function resolveInteger(value, fallback, field, minimum) {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < minimum) throw invalidConfigError(field, `expected an integer of at least ${minimum}, received ${String(value)}`);
	return resolved;
}
/**
* Read one required non-empty name.
* @param value - Configured text, or `undefined` to take the default.
* @param fallback - Default applied to an omitted field.
* @param field - Field name used in the diagnostic.
* @returns The trimmed name.
* @throws SleepError when the configured text is empty.
*/
function resolveName(value, fallback, field) {
	const name = (value ?? fallback).trim();
	if (name === "") throw invalidConfigError(field, "must not be empty");
	return name;
}
//#endregion
//#region lib/types/execution-drain.js
/**
* Admitted tool executions of one sleep run.
*
* The run that mounted the sleep tools owns the notes directory, so the slot may
* not pass to the next run while an execution it admitted still runs: a note
* write that landed afterwards would overwrite what the next run wrote. The
* drain answers the two waits the run needs: the plugin fiber stops at a short
* bound, because a Host teardown must not wait on it, and the slot waits longer,
* because an execution admitted before the unload is normally a note write that
* must land first. Each wait is bounded, so an execution that never settles ends
* the longer one too instead of holding the slot for the life of the process.
* @module @deepseek-ai/dsh-sleep/execution-drain
*/
/**
* Create one execution drain.
* @returns The drain a run shares between the tool registrations it mounts.
*/
function createExecutionDrain() {
	let admitted = 0;
	let closed = false;
	let idle;
	return {
		admit() {
			if (closed) throw new ToolContextUnavailableError("the sleep run ended, so its tools are unavailable");
			admitted += 1;
			return () => {
				admitted -= 1;
				if (admitted === 0) idle?.resolve();
			};
		},
		async close(boundMs) {
			closed = true;
			if (admitted === 0) return true;
			idle ??= Promise.withResolvers();
			const deadline = Promise.withResolvers();
			const timer = setTimeout(() => {
				deadline.resolve(false);
			}, boundMs);
			try {
				return await Promise.race([idle.promise.then(() => true), deadline.promise]);
			} finally {
				clearTimeout(timer);
			}
		}
	};
}
//#endregion
//#region lib/types/instruction-guard.js
/**
* Isolation of the sleep Session from workspace instructions.
*
* The sleep preset mounts no instruction loader, but a profile that mounts
* `@deepseek-ai/dsh-agent-instructions` globally - as `dsh-base` does, and as the
* `--patch` install route composes it - applies that loader's `agent/pre-step`
* listener to every Agent, including a Sleep Session. The workspace rules would
* then reach the one Session the sleep preset keeps free of them.
*
* The guard enforces the isolation in the Session instead of leaving it to the
* profile: it removes every instruction-sourced message a Sleep Session would
* otherwise receive. It registers first in the waterfall, so it rewrites the
* decision every other listener composed, and the rewritten decision is what the
* loop enters. A profile that mounts the loader globally therefore renders the
* same sleep request as one that does not.
* @module @deepseek-ai/dsh-sleep/instruction-guard
*/
/**
* Install the guard on the host plane.
*
* A Host listener registered through `ctx.get`-free code sees every Agent, so
* one installation covers the Session this plugin creates and a Session a user
* starts under the sleep preset.
* @param ctx - Host context whose `agent/pre-step` waterfall the guard joins.
* @param presetId - Configured sleep preset name.
*/
function installInstructionGuard(ctx, presetId) {
	ctx.on("agent/pre-step", async ({ agent }, next) => {
		const decision = await next();
		if (decision.kind === "reject") return decision;
		if (!isSleepAgent(ctx, agent, presetId)) return decision;
		const kept = decision.messages.filter((message) => !isInstructionMessage(message));
		if (kept.length === decision.messages.length) return decision;
		return {
			...decision,
			messages: kept
		};
	}, { prepend: true });
}
/**
* Whether one message carries workspace instructions.
* @param message - Message a step would enter.
* @returns `true` when the workspace instruction loader produced the message.
*/
function isInstructionMessage(message) {
	return message.source.kind === "agent-instructions";
}
//#endregion
//#region lib/types/memory-injector.js
/**
* Sleep notes reloaded into working Sessions.
*
* A working Session starts with the notes the user's sleep Sessions saved, so
* the work continues from what earlier reflection learned. The block enters as
* one durable `user/message` on the first step that runs, inside the
* `<system-reminder>` frame the workspace instruction loader uses.
*
* Only the notes whose rendered block fits `injectMaxBytes` travel inline, and
* that budget charges each note's heading and path as well as its text. Every
* other note is listed with its relative path, absolute path, and size, so the
* model opens the ones that matter with its ordinary `read` tool: the
* filesystem sandbox leaves reads unrestricted, so no second read tool is
* needed.
* @module @deepseek-ai/dsh-sleep/memory-injector
*/
/** Separator note paths use, independent of the host. */
const PATH_SEPARATOR = "/";
/** Separator the block puts between its blocks. */
const BLOCK_SEPARATOR = "\n\n";
/**
* Durable record of the startup block.
*
* The block is one durable `user/message`, so a Session that recorded it never
* needs a second one. The surface can lose the message to a compaction, which
* is why the injector reads this record instead of the derived history alone.
*/
const sleepMemoryProjection = {
	key: "sleepMemory",
	stateSchema: z$1.boolean(),
	stateVersion: 1,
	init: () => false,
	apply: (recorded, event) => recorded || event.type === "user/message" && isMemoryMessage(event.data)
};
/**
* Reload the saved sleep notes into the Sessions that do real work.
*
* Mount this on the host context, next to the runtime that owns the notes
* directory. Sessions the sleep preset composed are left alone, and a Session
* that already carries the block keeps it: the injection happens once and stays
* durable across resume and across a compaction that shadows the block from the
* Session surface when the projection registry is composed.
* @param ctx - Host context whose `agent/pre-step` waterfall the block joins.
* @param config - Resolved sleep configuration; its `dir` is an absolute directory by validation.
*/
async function installMemoryInjector(ctx, config) {
	const dir = config.dir;
	const projections = ctx.get("sessionProjections");
	const recorded = projections === void 0 ? void 0 : await projections.register(sleepMemoryProjection);
	ctx.on("agent/pre-step", async ({ agent, step }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || step === 1 && decision.messages.length === 0) return decision;
		if (isSleepAgent(ctx, agent, config.presetId)) return decision;
		if (hasMemoryBaseline(agent, decision.messages, recorded?.stateOf(agent.session) ?? false)) return decision;
		const notes = await collectNotes(ctx, dir, config);
		if (notes === void 0) return decision;
		const totalFiles = notes.included.length + notes.remaining.length;
		if (totalFiles === 0 && notes.partial === void 0) return decision;
		return {
			...decision,
			messages: [...decision.messages, memoryMessage(dir, notes, totalFiles, config)]
		};
	});
}
/**
* Whether the Session already carries the startup block.
*
* The block is durable, so a step that repeats it finds it in the proposed
* messages, a resumed Session finds it in its model-visible surface, and a
* Session whose surface lost it to a compaction finds it through the injector's
* own projection when the registry is composed.
* @param agent - Agent that proposed the step.
* @param messages - Messages the decision proposes to enter.
* @param recorded - Whether the Session log already holds the block.
* @returns `true` when one baseline memory message is already present.
*/
function hasMemoryBaseline(agent, messages, recorded) {
	if (recorded) return true;
	if (messages.some(isMemoryMessage)) return true;
	return agent.session.deriveMessages().some((message) => message.role === "user" && isMemoryMessage(message));
}
/**
* Whether one message is the startup block this injector writes.
* @param message - Message to test.
* @returns `true` when the message carries a baseline memory source.
*/
function isMemoryMessage(message) {
	const { source } = message;
	return source.kind === "sleep-memory" && source.baseline;
}
/**
* Scan the notes directory for the block.
*
* A directory this host cannot read leaves the turn untouched: the notes enrich
* the work, and failing here would break the work they enrich. The next step
* retries the scan.
* @param ctx - Host context whose logger reports the skipped scan.
* @param dir - Absolute notes directory.
* @param config - Resolved sleep configuration carrying every byte limit.
* @returns The collected notes, or `undefined` when the scan cannot run.
*/
async function collectNotes(ctx, dir, config) {
	try {
		return await collectNotesForInjection(dir, {
			injectMaxBytes: config.injectMaxBytes,
			maxSourceBytes: config.maxSourceBytes,
			inspectMaxBytes: config.inspectMaxBytes,
			inspectMaxEntries: config.inspectMaxEntries,
			headingBytes: headingOverheadBytes(config)
		});
	} catch (error) {
		ctx.logger.warn(`sleep memory injection skipped: ${String(error)}`);
		return;
	}
}
/**
* Bytes one carried note adds to the block besides its path and text.
*
* The budget in {@link collectNotesForInjection} charges this overhead for
* every note, so a notes tree full of long paths cannot inflate the block past
* `injectMaxBytes` through headings alone. It prices the rendered heading - the
* prefix, the cut marker, and the line break that closes it - and the separator
* the block puts before it. The cut marker is counted even for a note the
* per-note cap did not cut, which over-reserves by a few bytes.
* @param config - Resolved sleep configuration carrying the per-note cap.
* @returns Bytes of the heading and of the separator before it.
*/
function headingOverheadBytes(config) {
	return Buffer.byteLength(`## ${cutMarker(config.maxSourceBytes)}\n`, "utf8") + Buffer.byteLength(BLOCK_SEPARATOR, "utf8");
}
/**
* Marker a note carries when the per-note byte cap cut it.
* @param maxSourceBytes - Per-note byte cap the marker names.
* @returns The marker, including its leading space.
*/
function cutMarker(maxSourceBytes) {
	return ` (cut after ${maxSourceBytes} bytes)`;
}
/**
* Build the startup block message.
* @param dir - Absolute notes directory the block was read from.
* @param notes - Collected notes of that directory.
* @param totalFiles - Number of text notes found.
* @param config - Resolved sleep configuration carrying every byte limit.
* @returns One durable user message carrying the block and its source.
*/
function memoryMessage(dir, notes, totalFiles, config) {
	return createUserMessage({
		content: [{
			type: "text",
			text: renderMemory(dir, notes, config)
		}],
		source: {
			kind: "sleep-memory",
			form: "notice",
			summary: boundContextSummary(`sleep notes: ${notes.included.length} of ${totalFiles} loaded from ${dir}`),
			baseline: true,
			dir,
			includedFiles: notes.included.map((note) => note.path),
			totalFiles
		}
	});
}
/**
* Render the notes as one `<system-reminder>` block.
*
* The heading names where the notes come from and asks for nothing else: the
* sleep preset writes the notes, so no style is prescribed here. Note text is
* escaped before it joins the frame, and a note cut at the per-note byte cap
* says so.
* @param dir - Absolute notes directory the notes came from.
* @param notes - Collected notes of that directory.
* @param config - Resolved sleep configuration carrying every byte limit.
* @returns The complete block, frame included.
*/
function renderMemory(dir, notes, config) {
	const blocks = [`Sleep notes from earlier sessions, kept in ${dir}.`];
	for (const note of notes.included) blocks.push(includedBlock(note, config.maxSourceBytes));
	if (notes.remaining.length > 0) blocks.push(remainingBlock(dir, notes.remaining, config.injectMaxBytes));
	if (notes.partial !== void 0) blocks.push(unexaminedBlock(notes.partial));
	return [
		FRAME_OPEN,
		escapeFrameBody(blocks.join(BLOCK_SEPARATOR)),
		FRAME_CLOSE
	].join("\n");
}
/**
* Render one note whose text the block carries.
* @param note - Collected note with its text.
* @param maxSourceBytes - Per-note byte cap, named when the text was cut.
* @returns The note heading and its text.
*/
function includedBlock(note, maxSourceBytes) {
	const cut = note.truncated ? cutMarker(maxSourceBytes) : "";
	return `## ${note.path}${cut}\n${note.text}`;
}
/**
* Render the notes the block does not carry.
*
* The listed notes are bounded by the configured byte budget, so a notes tree
* the sleep model keeps growing cannot inflate every later request of a working
* Session. The budget prices the rendered line, including the escape a path
* holding a closing frame tag needs. A listing that names every note is offered
* whole, because it needs no count sentence; when notes must be left out, the
* budget also keeps room for the sentence that counts them, so any listing that
* names a note stays inside the budget it was given. A budget that cannot hold
* the fixed heading and that sentence still carries both, because the block must
* say that the list is incomplete; no listing fits a budget below them.
* @param dir - Absolute notes directory the notes came from.
* @param remaining - Collected notes left out of the text block, in path order.
* @param budget - Most UTF-8 bytes the listed lines may take.
* @returns The heading, the reading hint, and the lines that fit the budget.
*/
function remainingBlock(dir, remaining, budget) {
	const heading = `Other notes in ${dir}, not carried above; open one at its absolute path when it matters:`;
	const listed = remaining.map((note) => `- ${note.path} (${note.bytes} bytes) at ${join(dir, ...note.path.split(PATH_SEPARATOR))}`);
	const headingBytes = renderedBytes(heading);
	if (listed.reduce((bytes, line) => bytes + 1 + renderedBytes(line), headingBytes) <= budget) return [heading, ...listed].join("\n");
	const lines = [heading];
	let bytes = headingBytes;
	for (const [index, line] of listed.entries()) {
		const tail = 1 + renderedBytes(omissionLine(listed.length - index - 1, dir));
		const cost = 1 + renderedBytes(line);
		if (bytes + cost + tail > budget) break;
		bytes += cost;
		lines.push(line);
	}
	lines.push(omissionLine(listed.length + 1 - lines.length, dir));
	return lines.join("\n");
}
/**
* Measure one rendered line of the block as the frame carries it.
* @param line - Line before the frame escaping.
* @returns UTF-8 bytes of the escaped line.
*/
function renderedBytes(line) {
	return Buffer.byteLength(escapeFrameBody(line), "utf8");
}
/**
* Build the sentence that counts the notes the listing leaves out.
* @param count - Notes neither carried nor listed.
* @param dir - Absolute notes directory the notes came from.
* @returns The closing count line.
*/
function omissionLine(count, dir) {
	return `- and ${count} more notes in ${dir}`;
}
/**
* Note the part of the tree the bounded pass did not examine.
* @param cause - Budget that stopped the pass before it examined the whole tree.
* @returns The sentences that close a partial block.
*/
function unexaminedBlock(cause) {
	return `Only part of this directory was examined. The pass is limited to ${cause === "entries" ? "a bounded number of directory entries" : "a bounded amount of note content"}, so notes it did not reach are not listed here.`;
}
//#endregion
//#region lib/types/storage.js
/**
* Durable sleep state over `ctx.storageDomain`.
*
* One small global record survives Host restarts: when the last sleep
* completed, which local date the schedule last acted on, which Session ran it,
* and how the last attempt ended. Sleep Sessions themselves are recognized from
* their stored header, so no Session-id list is kept here.
*
* The domain schema is the durable read boundary: a stored record that does not
* match {@link sleepStateSchema} rejects the open instead of silently resetting
* the schedule.
* @module @deepseek-ai/dsh-sleep/storage
*/
/** Canonical UTC instant with milliseconds, as `Date.prototype.toISOString` renders it. */
const instantSchema = z$1.iso.datetime({ precision: 3 });
/** Saved Session identity; the empty string is never a Session. */
const sessionIdSchema = z$1.string().min(1).transform(SessionId);
const outcomeSchema = z$1.object({
	at: instantSchema,
	trigger: z$1.enum(["scheduled", "manual"]),
	status: z$1.enum([
		"completed",
		"skipped",
		"failed"
	]),
	sessionId: sessionIdSchema.exactOptional(),
	reason: z$1.string().min(1).exactOptional()
}).strict();
/** Durable record of the sleep domain's global slot. */
const sleepStateSchema = z$1.object({
	lastSleepAt: instantSchema.nullable(),
	lastScheduledDate: z$1.iso.date().nullable(),
	lastOutcome: outcomeSchema.nullable()
}).strict();
/** State served before the first write, when no run has happened yet. */
const EMPTY_SLEEP_STATE = Object.freeze({
	lastSleepAt: null,
	lastScheduledDate: null,
	lastOutcome: null
});
/**
* The sleep domain: one global record and no tables.
*
* Version 1 is the first generation, so it declares no compatible versions.
*/
const sleepDomain = defineDomain({
	name: "sleep",
	version: 1,
	global: {
		schema: sleepStateSchema,
		initial: EMPTY_SLEEP_STATE
	},
	tables: {}
});
/**
* How long an open waits for a domain an unloaded runtime still holds.
*
* The abandoned run closes the store when it settles; the wait covers that
* window, and a holder that never releases it fails the open as before. The
* wait is measured on the monotonic clock, so a wall-clock adjustment cannot
* move its end.
*/
const STORE_HANDOFF_WAIT_MS = 1e4;
/** How often an open retries while the previous store is still held. */
const STORE_HANDOFF_POLL_MS = 50;
/**
* Open the sleep domain.
*
* The caller owns the handle and closes it during its own teardown. A runtime
* that unloads while its run ignores cancellation keeps the domain open until
* that run settles, then closes it, so an open that lands in that interval waits
* for the release instead of failing with `already-open`: a reload in that
* window would otherwise stay unusable for the rest of the process.
* @param ctx - Host context carrying `storageDomain`.
* @returns The opened store.
* @throws DomainError when the routed backend is unavailable, a stored record
* does not match {@link sleepStateSchema}, or another holder does not release
* the domain inside {@link STORE_HANDOFF_WAIT_MS}.
*/
async function openSleepStore(ctx) {
	const domain = await openReleasedSleepDomain(ctx);
	return {
		get state() {
			return domain.global.get();
		},
		save: (next) => domain.global.set(next),
		close: () => domain.close()
	};
}
/**
* Open the sleep domain, waiting out a runtime that unloaded but still holds it.
* @param ctx - Host context carrying `storageDomain`.
* @returns The opened domain.
* @throws DomainError when the domain does not become available inside the wait.
*/
async function openReleasedSleepDomain(ctx) {
	const deadline = performance.now() + STORE_HANDOFF_WAIT_MS;
	for (;;) try {
		return await ctx.storageDomain.open(sleepDomain);
	} catch (error) {
		if (!(error instanceof DomainError) || error.code !== "already-open" || performance.now() >= deadline) throw error;
		await new Promise((resolve) => {
			setTimeout(resolve, STORE_HANDOFF_POLL_MS).unref();
		});
	}
}
//#endregion
//#region lib/types/tools.js
/**
* Model-facing tools of the sleep Session.
*
* The sleep runtime mounts this plugin in the sleep Agent's own scoped
* context, so the plugin masks every global host tool with
* `ctx.tools.restrict({ allow: [] })` and registers its seven tools in that
* same layer. A restriction applies to tools the scope inherits, never to the
* scope's own registrations, so both steps must share the Agent scope: a row
* mounted in a preset layer would mask its own tools from the Agent.
*
* Reading tools cover the Session history the reflection is about; note tools
* cover the notes directory, and every note path goes through
* {@link ./notes-fs.ts} so it stays confined to that directory.
*
* A paged result always reports `total` (entries found) and `shown` (entries in
* this page), whatever it pages over.
* @module @deepseek-ai/dsh-sleep/tools
*/
var tools_exports = /* @__PURE__ */ __exportAll({
	apply: () => apply,
	inject: () => inject,
	name: () => name
});
/** Plugin name registered with the Loader. */
const name = "sleep-tools";
/** Host services these tools read. */
const inject = [
	"tools",
	"sessionQuery",
	"sleep"
];
/** Default number of listed Sessions when the caller names none. */
const LIST_LIMIT_DEFAULT = 50;
/** Most Sessions one listing returns, so a long history stays a bounded tool result. */
const LIST_LIMIT_MAX = 200;
/** Default number of transcript entries one Session read returns. */
const TRANSCRIPT_LIMIT_DEFAULT = 30;
/** Most transcript entries one Session read returns. */
const TRANSCRIPT_LIMIT_MAX = 200;
/** Default number of notes one listing returns. */
const NOTES_LIST_LIMIT_DEFAULT = 50;
/** Most notes one listing returns. */
const NOTES_LIST_LIMIT_MAX = 200;
/** Longest message block a transcript line keeps. */
const TRANSCRIPT_BLOCK_MAX_CHARS = 1e3;
/** Longest tool-call argument string a transcript line keeps. */
const TRANSCRIPT_ARGUMENTS_MAX_CHARS = 400;
/** Longest one transcript entry keeps, whatever blocks it joins. */
const TRANSCRIPT_ENTRY_MAX_CHARS = 4e3;
/** Most UTF-8 bytes one transcript page returns, so a fat entry cannot exhaust the request. */
const TRANSCRIPT_PAGE_MAX_BYTES = 4e4;
/** Most unreadable Session ids one listing names, so a broken corpus stays a bounded result. */
const UNREADABLE_IDS_LIMIT = 20;
/**
* Longest one unload waits for tool executions it already admitted.
*
* An execution runs outside the fiber that registered its tool, so an execution
* that stalls would hold that fiber open for as long as it stalls, and a Host
* teardown waits for every fiber before it finishes. The wait is bounded like the
* run teardown in the runtime: unloading proceeds after the bound and reports the
* execution it left behind. The run that mounted the tools still waits for the
* execution before it releases its slot, because the notes directory may not pass
* to the next run while a write is pending.
*/
const DRAIN_SETTLE_MS = 5e3;
const LIST_SESSIONS_OUTPUT = {
	type: "object",
	additionalProperties: false,
	properties: {
		since: { type: "string" },
		before: { type: "string" },
		before_id: { type: "string" },
		total: {
			type: "integer",
			required: true
		},
		shown: {
			type: "integer",
			required: true
		},
		sessions: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					title: { type: "string" },
					agentPreset: { type: "string" },
					sleepSession: {
						type: "boolean",
						required: true
					},
					created_at: {
						type: "string",
						required: true
					},
					activity_at: {
						type: "string",
						required: true
					},
					live: {
						type: "boolean",
						required: true
					}
				}
			}
		},
		unreadable: {
			type: "object",
			additionalProperties: false,
			properties: {
				total: {
					type: "integer",
					required: true
				},
				sessions: {
					type: "array",
					required: true,
					items: { type: "string" }
				}
			}
		}
	}
};
const READ_SESSION_OUTPUT = {
	type: "object",
	additionalProperties: false,
	properties: {
		session_id: {
			type: "string",
			required: true
		},
		title: { type: "string" },
		created_at: {
			type: "string",
			required: true
		},
		offset: {
			type: "integer",
			required: true
		},
		total: {
			type: "integer",
			required: true
		},
		shown: {
			type: "integer",
			required: true
		},
		eof: {
			type: "boolean",
			required: true
		},
		text: {
			type: "string",
			required: true
		}
	}
};
const NOTES_LIST_OUTPUT = {
	type: "object",
	additionalProperties: false,
	properties: {
		dir: {
			type: "string",
			required: true
		},
		after: { type: "string" },
		total: {
			type: "integer",
			required: true
		},
		shown: {
			type: "integer",
			required: true
		},
		files: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true
					},
					bytes: {
						type: "integer",
						required: true
					},
					modified_at: {
						type: "string",
						required: true
					}
				}
			}
		}
	}
};
const NOTE_READ_OUTPUT = {
	type: "object",
	additionalProperties: false,
	properties: {
		path: {
			type: "string",
			required: true
		},
		text: {
			type: "string",
			required: true
		},
		offset: {
			type: "integer",
			required: true
		},
		total: {
			type: "integer",
			required: true
		},
		shown: {
			type: "integer",
			required: true
		},
		eof: {
			type: "boolean",
			required: true
		},
		truncated: {
			type: "boolean",
			required: true
		}
	}
};
const NOTE_WRITE_OUTPUT = {
	type: "object",
	additionalProperties: false,
	properties: {
		path: {
			type: "string",
			required: true
		},
		bytes: {
			type: "integer",
			required: true
		},
		modified_at: { type: "string" }
	}
};
const NOTE_MOVE_OUTPUT = {
	type: "object",
	additionalProperties: false,
	properties: {
		from: {
			type: "string",
			required: true
		},
		path: {
			type: "string",
			required: true
		},
		bytes: {
			type: "integer",
			required: true
		},
		modified_at: {
			type: "string",
			required: true
		},
		replaced: {
			type: "boolean",
			required: true
		}
	}
};
const NOTE_DELETE_OUTPUT = {
	type: "object",
	additionalProperties: false,
	properties: {
		path: {
			type: "string",
			required: true
		},
		kind: {
			type: "string",
			required: true,
			enum: [
				"file",
				"directory",
				"link"
			]
		},
		removed_files: {
			type: "integer",
			required: true
		},
		removed_bytes: {
			type: "integer",
			required: true
		},
		removed_paths: {
			type: "array",
			required: true,
			items: { type: "string" }
		},
		omitted_paths: {
			type: "integer",
			required: true
		}
	}
};
/**
* Register the seven sleep tools and mask every global host tool.
*
* Mount this plugin in the sleep Agent's own scoped context. The restriction
* and the registrations then share one layer: inherited host tools stay
* masked, and the sleep tools remain the Agent's own, unrestricted set.
*
* Unloading the plugin first removes the registrations and then waits for every
* execution they admitted, so a note write a follow-up turn already started
* cannot land after the run that owns the notes directory released it. That wait
* is bounded by {@link DRAIN_SETTLE_MS}: an execution that stalls cannot hold the
* fiber open, which a Host teardown would otherwise wait for without a bound. The
* mounting run waits again for that execution through
* {@link ExecutionDrain.close}, with the longer bound it allows the sleep slot.
* An execution admitted after the removal is refused instead of running.
* @param ctx - Scoped context of the sleep Agent.
* @param options - Drain the mounting run shares with this plugin.
* @throws when the mounting context is not scoped, because a context-global
* restriction would mask every Agent of the Host.
*/
function apply(ctx, options) {
	const drain = options.drain;
	ctx.effect(() => async () => {
		if (await drain.close(DRAIN_SETTLE_MS)) return;
		ctx.logger.warn(`sleep: a tool execution was still running ${DRAIN_SETTLE_MS} ms after the run released its tools`);
	}, "sleep-tools.drain");
	ctx.tools.restrict({ allow: [] });
	ctx.tools.register(tracked(listSessionsTool(ctx), drain));
	ctx.tools.register(tracked(readSessionTool(ctx), drain));
	const root = ctx.sleep.config.dir;
	for (const tool of notesTools(root, ctx.sleep.config.maxSourceBytes)) ctx.tools.register(tracked(tool, drain));
}
/**
* Wrap one definition so its executions are visible to the drain.
*
* A call whose turn was cancelled never reaches the body, so it is refused
* before it is admitted: the drain then tracks only work that actually runs.
* @param definition - Registered sleep tool.
* @param drain - Drain that tracks this plugin's executions.
* @returns The same tool, with an execution that is admitted and released.
*/
function tracked(definition, drain) {
	return {
		...definition,
		async execute(args, exec) {
			exec.signal.throwIfAborted();
			const release = drain.admit();
			try {
				return await definition.execute(args, exec);
			} finally {
				release();
			}
		}
	};
}
/**
* Build the Session listing tool.
* @param ctx - Host context carrying `sessionQuery` and the sleep service.
* @returns The `sleep_list_sessions` definition.
*/
function listSessionsTool(ctx) {
	return defineTool({
		name: "sleep_list_sessions",
		description: "List Sessions that were active after the last completed sleep, most recent activity first. The current sleep Session is left out, and a Session that ran an earlier sleep is marked as one. A Session whose log cannot be read is named as unreadable instead of failing the list. To page into older Sessions, pass the oldest activity instant of the previous page as before and its Session id as before_id.",
		parameters: {
			since: {
				type: "string",
				description: "ISO 8601 instant with an explicit offset, such as 2026-11-22T03:00:00Z, that bounds the list from below; defaults to the last completed sleep, or all history before the first one."
			},
			before: {
				type: "string",
				description: "ISO 8601 instant with an explicit offset that bounds the list from above. Pass the oldest activity instant of the previous page to page into older Sessions."
			},
			before_id: {
				type: "string",
				description: "Session id of that oldest row. Pass it with before so Sessions whose activity equals that instant are not skipped."
			},
			limit: {
				type: "integer",
				description: `Maximum Sessions to return from 1 to ${LIST_LIMIT_MAX}; defaults to ${LIST_LIMIT_DEFAULT}.`
			}
		},
		output: {
			schema: LIST_SESSIONS_OUTPUT,
			render: (_args, value) => text(renderSessionList(value))
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const caller = callerSession(exec);
			const limit = boundedInteger(args.limit, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, "limit");
			const since = args.since === void 0 ? ctx.sleep.state.lastSleepAt : instantArgument(args.since, "since");
			const sinceMs = since === null ? null : Date.parse(since);
			const before = args.before === void 0 ? null : instantArgument(args.before, "before");
			const beforeMs = before === null ? null : Date.parse(before);
			const beforeId = args.before_id === void 0 ? null : SessionId(args.before_id);
			if (beforeId !== null && before === null) throw new ToolArgsError(["before_id requires before"]);
			const listing = await sessionsActiveBetween(ctx, await listSessionCorpus(ctx), caller, sinceMs, beforeMs, beforeId, exec.signal);
			const page = listing.active.slice(0, limit);
			const titles = await readTitles(ctx, page.map((entry) => entry.record.header.id));
			const presetId = ctx.sleep.config.presetId;
			const sessions = page.map((entry) => sessionRow(entry, titles.get(entry.record.header.id), presetId));
			return {
				...since === null ? {} : { since },
				...before === null ? {} : { before },
				...beforeId === null ? {} : { before_id: beforeId },
				total: listing.active.length,
				shown: page.length,
				sessions,
				...listing.unreadable.length === 0 ? {} : { unreadable: {
					total: listing.unreadable.length,
					sessions: listing.unreadable.slice(0, UNREADABLE_IDS_LIMIT)
				} }
			};
		},
		presentCall: () => callView("List sessions", "read"),
		presentResult: (_args, result) => resultView("List sessions", result.isError)
	});
}
/**
* Build the Session transcript tool.
* @param ctx - Host context carrying `sessionQuery`.
* @returns The `sleep_read_session` definition.
*/
function readSessionTool(ctx) {
	return defineTool({
		name: "sleep_read_session",
		description: "Read one Session transcript page by page: user and assistant messages, the tool calls they requested, and the tool results. System prompts and tool changes are left out.",
		parameters: {
			session_id: {
				type: "string",
				required: true,
				description: "Session id returned by sleep_list_sessions."
			},
			offset: {
				type: "integer",
				description: "One-based number of the first transcript entry; defaults to 1."
			},
			limit: {
				type: "integer",
				description: `Maximum entries to return from 1 to ${TRANSCRIPT_LIMIT_MAX}; defaults to ${TRANSCRIPT_LIMIT_DEFAULT}.`
			}
		},
		output: {
			schema: READ_SESSION_OUTPUT,
			render: (_args, value) => text(renderTranscript(value))
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const sessionId = SessionId(args.session_id);
			const offset = positiveInteger(args.offset, "offset", "a positive entry number") ?? 1;
			const limit = boundedInteger(args.limit, TRANSCRIPT_LIMIT_DEFAULT, TRANSCRIPT_LIMIT_MAX, "limit");
			const surface = await readSurface(ctx, sessionId);
			exec.signal.throwIfAborted();
			const start = offset - 1;
			const page = transcriptPage(surface.events, start, limit);
			const title = (await readTitles(ctx, [sessionId])).get(sessionId);
			return {
				session_id: sessionId,
				...title === void 0 ? {} : { title },
				created_at: instant(surface.session.createdAt),
				offset,
				total: page.total,
				shown: page.lines.length,
				eof: start + page.lines.length >= page.total,
				text: page.lines.join("\n")
			};
		},
		presentCall: (args) => callView("Read session", "read", args.session_id),
		presentResult: (_args, result) => resultView("Read session", result.isError)
	});
}
/**
* Build the five note tools for one notes directory.
* @param root - Absolute notes directory every note path stays inside.
* @param maxSourceBytes - Most bytes one note read returns.
* @returns The note tool definitions in registration order.
*/
function notesTools(root, maxSourceBytes) {
	return [
		defineTool({
			name: "sleep_notes_list",
			description: "List the sleep notes directory with the size and modification time of the notes it returns, in path order. To page into later notes, pass the last path of the previous page as after.",
			parameters: {
				after: {
					type: "string",
					description: "Only list notes whose path sorts after this one; pass the last path of the previous page."
				},
				limit: {
					type: "integer",
					description: `Maximum notes to return from 1 to ${NOTES_LIST_LIMIT_MAX}; defaults to ${NOTES_LIST_LIMIT_DEFAULT}.`
				}
			},
			output: {
				schema: NOTES_LIST_OUTPUT,
				render: (_args, value) => text(renderNoteList(value))
			},
			isConcurrencySafe: () => true,
			async execute(args) {
				const limit = boundedInteger(args.limit, NOTES_LIST_LIMIT_DEFAULT, NOTES_LIST_LIMIT_MAX, "limit");
				const after = args.after;
				const notes = await listNotes(root);
				const candidates = after === void 0 ? notes : notes.filter((note) => compareNotePaths(note.path, after) > 0);
				const page = candidates.slice(0, limit);
				return {
					dir: root,
					...after === void 0 ? {} : { after },
					total: candidates.length,
					shown: page.length,
					files: page.map((note) => ({
						path: note.path,
						bytes: note.bytes,
						modified_at: instant(note.mtimeMs)
					}))
				};
			},
			presentCall: () => callView("List sleep notes", "read"),
			presentResult: (_args, result) => resultView("List sleep notes", result.isError)
		}),
		defineTool({
			name: "sleep_notes_read",
			description: "Read one sleep note, optionally one window of its lines.",
			parameters: {
				path: {
					type: "string",
					required: true,
					description: "Note path relative to the notes directory, or an absolute path inside it."
				},
				offset: {
					type: "integer",
					description: "1-based number of the first line to return; defaults to 1."
				},
				limit: {
					type: "integer",
					description: "Maximum number of lines to return; defaults to the end of the note."
				}
			},
			output: {
				schema: NOTE_READ_OUTPUT,
				render: (_args, value) => text(renderNote(value))
			},
			isConcurrencySafe: () => true,
			async execute(args) {
				const offset = positiveInteger(args.offset, "offset", "a positive line number");
				const limit = positiveInteger(args.limit, "limit", "a positive line count");
				const note = await readNote(root, args.path, {
					...offset === void 0 ? {} : { offset },
					...limit === void 0 ? {} : { limit },
					maxBytes: maxSourceBytes
				});
				return {
					path: note.path,
					text: note.text,
					offset: note.offset,
					total: note.total,
					shown: note.shown,
					eof: note.eof,
					truncated: note.truncated
				};
			},
			presentCall: (args) => callView("Read sleep note", "read", args.path),
			presentResult: (_args, result) => resultView("Read sleep note", result.isError)
		}),
		defineTool({
			name: "sleep_notes_write",
			description: `Create or replace one sleep note atomically. The whole content becomes the note; content above ${maxSourceBytes} bytes is refused.`,
			parameters: {
				path: {
					type: "string",
					required: true,
					description: "Note path relative to the notes directory, or an absolute path inside it."
				},
				content: {
					type: "string",
					required: true,
					description: "Complete next content of the note."
				}
			},
			output: {
				schema: NOTE_WRITE_OUTPUT,
				render: (_args, value) => text(`Wrote sleep note ${value.path} (${value.bytes} bytes)`)
			},
			async execute(args) {
				const note = await writeNote(root, args.path, args.content, { maxBytes: maxSourceBytes });
				return {
					path: note.path,
					bytes: note.bytes,
					...note.mtimeMs === void 0 ? {} : { modified_at: instant(note.mtimeMs) }
				};
			},
			presentCall: (args) => callView("Write sleep note", "edit", args.path),
			presentResult: (_args, result) => resultView("Write sleep note", result.isError)
		}),
		defineTool({
			name: "sleep_notes_move",
			description: "Move or rename one sleep note, creating the directories of its new path. A symbolic link is moved as the link it is, so the note it names stays where it is; a relative link that would name another path from its new directory is refused. A note already at the new path is replaced, and the result says whether that happened.",
			parameters: {
				from: {
					type: "string",
					required: true,
					description: "Current note path."
				},
				to: {
					type: "string",
					required: true,
					description: "New note path."
				}
			},
			output: {
				schema: NOTE_MOVE_OUTPUT,
				render: (_args, value) => text(`Moved sleep note ${value.from} to ${value.path} (${value.bytes} bytes)` + (value.replaced ? ", replacing the note already there" : ""))
			},
			async execute(args) {
				const note = await moveNote(root, args.from, args.to);
				return {
					from: args.from,
					path: note.path,
					bytes: note.bytes,
					modified_at: instant(note.mtimeMs),
					replaced: note.replaced
				};
			},
			presentCall: (args) => callView("Move sleep note", "move", args.from),
			presentResult: (_args, result) => resultView("Move sleep note", result.isError)
		}),
		defineTool({
			name: "sleep_notes_delete",
			description: "Delete one sleep note or one directory of notes below it. A symbolic link is removed as the link it is, so the note it names stays, and a link inside a deleted directory is not reported among the removed notes. The result reports the note files and bytes removed with it.",
			parameters: { path: {
				type: "string",
				required: true,
				description: "Note or directory path relative to the notes directory."
			} },
			output: {
				schema: NOTE_DELETE_OUTPUT,
				render: (_args, value) => text(renderDeletion(value))
			},
			async execute(args) {
				const deleted = await deleteNote(root, args.path);
				return {
					path: deleted.path,
					kind: deleted.kind,
					removed_files: deleted.removedFiles,
					removed_bytes: deleted.removedBytes,
					removed_paths: [...deleted.removedPaths],
					omitted_paths: deleted.omittedPaths
				};
			},
			presentCall: (args) => callView("Delete sleep note", "delete", args.path),
			presentResult: (_args, result) => resultView("Delete sleep note", result.isError)
		})
	];
}
/**
* Read the Session id of the calling Agent.
* @param exec - Run context of the call.
* @returns Id of the Session that dispatched the call.
* @throws ToolContextUnavailableError when the call has no Agent to identify the current Session.
*/
function callerSession(exec) {
	const agent = exec.agent;
	if (agent === void 0) throw new ToolContextUnavailableError("sleep tools require an Agent-bound caller to identify the current Session");
	return agent.session.id;
}
/**
* List the logical Session corpus.
* @param ctx - Host context carrying `sessionQuery`.
* @returns Every Session record the corpus reports.
* @throws SleepError with code `SLEEP_SESSION_QUERY_FAILED` when the corpus cannot be listed.
*/
async function listSessionCorpus(ctx) {
	return await sleepSessionQuery(ctx, "listSessions", () => ctx.sessionQuery.listSessions());
}
/**
* Resolve the Sessions active inside one activity interval.
*
* A Session created before the lower bound but still in use counts, so the
* activity instant decides rather than the creation date. The list is ordered
* by activity instant and then by Session id, and the exclusive cursor copies
* that order: `before` alone pages past every Session at or above its instant,
* while `before_id` keeps the Sessions tied with the cursor row, so a page that
* ends inside a group of equal instants does not drop the rest of the group.
*
* A Session whose log cannot be read is reported instead of failing the list:
* one corrupt history must not hide the Sessions the model can read, and the
* scheduler's own activity count leaves such a Session out the same way.
*
* Each candidate is checked against the cheap lower bound before its log is
* read: the creation instant and the projected last prompt both precede the
* latest activity, so a candidate above the cursor cannot belong to the page a
* caller is paging into. The lower bound has no such answer, because a Session
* whose last prompt predates it can still have been active after it.
* @param ctx - Host context carrying the query services.
* @param records - Session records to test.
* @param caller - Session that dispatched the call, left out of the result.
* @param sinceMs - Exclusive activity lower bound in epoch milliseconds, or `null` for every Session.
* @param beforeMs - Activity upper bound in epoch milliseconds of the cursor row, or `null` for no upper bound.
* @param beforeId - Session id of the cursor row, or `null` when only the instant bounds the page.
* @param signal - Cancellation of the calling turn; a cancelled call stops before the next log read.
* @returns The readable entries in listing order and the Sessions whose log could not be read.
*/
async function sessionsActiveBetween(ctx, records, caller, sinceMs, beforeMs, beforeId, signal) {
	const active = [];
	const unreadable = [];
	for (const record of records) {
		if (record.header.id === caller) continue;
		if (beforeMs !== null && beforeCouldHold(ctx, record, beforeMs)) continue;
		signal.throwIfAborted();
		try {
			const activityAt = await resolveSessionActivityAt(ctx, record, {
				...sinceMs === null ? {} : { after: sinceMs },
				exact: true
			});
			if (sinceMs !== null && activityAt <= sinceMs) continue;
			if (beforeMs !== null && !olderThanCursor(record.header.id, activityAt, beforeMs, beforeId)) continue;
			active.push({
				record,
				activityAt,
				agentPreset: await resolveSessionPreset(ctx, record)
			});
		} catch (error) {
			if (!isUnreadableHistory(error)) throw error;
			unreadable.push(record.header.id);
		}
	}
	return {
		active: active.sort((left, right) => right.activityAt - left.activityAt || compareSessionIds(left.record.header.id, right.record.header.id)),
		unreadable
	};
}
/**
* Whether a cheap bound already places one Session above a cursor instant.
*
* The creation instant and the projected last prompt are both at or before the
* Session's latest activity, so either one above the cursor proves the Session
* sorts above the cursor row and needs no log read.
* @param ctx - Host context carrying the projection services when composed.
* @param record - Session record as the corpus listed it.
* @param beforeMs - Activity instant of the cursor row in epoch milliseconds.
* @returns `true` when the Session cannot belong to the page the cursor starts.
*/
function beforeCouldHold(ctx, record, beforeMs) {
	const projected = projectedPromptAt(ctx, record) ?? 0;
	return Math.max(record.header.createdAt, projected) > beforeMs;
}
/**
* Whether one failure is the unreadable-history failure a listing contains.
* @param error - Failure a Session read reported.
* @returns `true` when the Session log could not be read.
*/
function isUnreadableHistory(error) {
	return error instanceof SleepError && error.code === "SLEEP_SESSION_QUERY_FAILED";
}
/**
* Order two Session ids.
*
* The order is by Unicode code unit, which is total: two distinct ids never
* compare equal. A collation order cannot page a listing, because
* `localeCompare` reports two canonically equivalent spellings as equal, so a
* page cursor compared with it would drop the Session on the other side of that
* tie.
* @param left - First Session id.
* @param right - Second Session id.
* @returns A negative number when the first id sorts first, `0` for the same id, or a positive number.
*/
function compareSessionIds(left, right) {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}
/**
* Whether one Session follows the cursor row in the listing order.
* @param id - Session id of the candidate.
* @param activityAt - Activity instant of the candidate in epoch milliseconds.
* @param beforeMs - Activity instant of the cursor row.
* @param beforeId - Session id of the cursor row, or `null` when the caller passed no id.
* @returns `true` when the candidate sorts after the cursor row.
*/
function olderThanCursor(id, activityAt, beforeMs, beforeId) {
	if (activityAt < beforeMs) return true;
	if (activityAt > beforeMs) return false;
	return beforeId !== null && compareSessionIds(id, beforeId) > 0;
}
/**
* Project one listed Session into its tool value.
* @param entry - Record, resolved activity, and resolved preset of the Session.
* @param title - Latest title snapshot of the Session, when it has one.
* @param presetId - Configured sleep preset name.
* @returns The Session row this tool reports.
*/
function sessionRow(entry, title, presetId) {
	const { header } = entry.record;
	return {
		id: header.id,
		...title === void 0 ? {} : { title },
		...entry.agentPreset === void 0 ? {} : { agentPreset: entry.agentPreset },
		sleepSession: entry.agentPreset === presetId,
		created_at: instant(header.createdAt),
		activity_at: instant(entry.activityAt),
		live: entry.record.live
	};
}
/**
* Read the latest title of each Session.
*
* A title snapshot that fails on its own leaves that Session untitled; the
* listing still reports the rest of the corpus.
* @param ctx - Host context carrying `sessionQuery`.
* @param sessionIds - Sessions whose titles are read.
* @returns Latest title per Session that has one.
* @throws SleepError with code `SLEEP_SESSION_QUERY_FAILED` when the batch observation itself fails.
*/
async function readTitles(ctx, sessionIds) {
	const titles = /* @__PURE__ */ new Map();
	if (sessionIds.length === 0) return titles;
	const observations = await sleepSessionQuery(ctx, "readTitleSnapshots", () => ctx.sessionQuery.readTitleSnapshots(sessionIds));
	for (const observation of observations) {
		if (observation.status !== "fulfilled") continue;
		const title = observation.value.title?.title;
		if (title !== void 0) titles.set(observation.sessionId, title);
	}
	return titles;
}
/**
* Read one Session surface through a coded failure.
* @param ctx - Host context carrying `sessionQuery`.
* @param sessionId - Session to observe.
* @returns The current model surface of that Session.
* @throws SleepError with code `SLEEP_SESSION_QUERY_FAILED` when the Session cannot be read.
*/
async function readSurface(ctx, sessionId) {
	return await sleepSessionQuery(ctx, "readSurface", () => ctx.sessionQuery.readSurface(sessionId));
}
/**
* Select one bounded transcript page without rendering the rest of the Session.
*
* The scan counts every transcript entry to report the total, and renders only
* the entries of the requested window, stopping as soon as the page reaches its
* entry or byte bound. Every entry keeps at most
* {@link TRANSCRIPT_ENTRY_MAX_CHARS} characters, and the page stops before it
* would exceed {@link TRANSCRIPT_PAGE_MAX_BYTES} bytes, so a tool-call-heavy
* Session cannot exhaust the request with one call. The first requested entry
* always enters the page, because its own cap is smaller than the page budget.
* @param events - Current surface events in model-history order.
* @param start - Zero-based index of the first requested entry.
* @param limit - Most entries the page may hold.
* @returns The page lines in transcript order and the number of transcript entries.
*/
function transcriptPage(events, start, limit) {
	const lines = [];
	let bytes = 0;
	let total = 0;
	let full = false;
	for (const event of events) {
		if (!hasTranscriptContent(event)) continue;
		const position = total;
		total += 1;
		if (full || position < start || lines.length >= limit) continue;
		const clippedLine = clipped(transcriptLine(event), TRANSCRIPT_ENTRY_MAX_CHARS);
		const cost = Buffer.byteLength(clippedLine, "utf8") + (lines.length === 0 ? 0 : 1);
		if (lines.length > 0 && bytes + cost > TRANSCRIPT_PAGE_MAX_BYTES) {
			full = true;
			continue;
		}
		lines.push(clippedLine);
		bytes += cost;
	}
	return {
		lines,
		total
	};
}
/**
* Whether one surface event carries a transcript entry.
*
* This is the cheap half of {@link transcriptLine}: it reads block types and
* text presence, never joins or clips the message, so counting the transcript
* does not materialize it.
* @param event - One current surface event.
* @returns `true` when the event renders one transcript line.
*/
function hasTranscriptContent(event) {
	switch (event.type) {
		case "user/message": return hasReadableContent(event.data.content);
		case "assistant/message": return hasReadableContent(event.data.message.content);
		case "tool/result": return hasReadableContent(event.data.message.content);
		case "system/message":
		case "developer/message": return false;
		/* v8 ignore next 2 -- the surface union is closed, so every member returns above */
		default: return assertNever(event, "surface event");
	}
}
/**
* Whether message content renders as text.
* @param content - Message content blocks.
* @returns `true` when at least one block contributes visible text.
*/
function hasReadableContent(content) {
	return content.some((block) => block.type === "tool-call" || block.type === "text" && block.text.trim() !== "");
}
/**
* Render one page entry as a transcript line.
*
* Only a {@link TranscriptEvent} reaches this function, so the
* request-describing events are outside its accepted input.
* @param event - One current surface event that carries a transcript entry.
* @returns The transcript line.
*/
function transcriptLine(event) {
	switch (event.type) {
		case "user/message": return labelledLine(event.seq, "user", event.data.content);
		case "assistant/message": return labelledLine(event.seq, "assistant", event.data.message.content);
		case "tool/result": return labelledLine(event.seq, event.data.message.isError === true ? "tool error" : "tool result", event.data.message.content);
		/* v8 ignore next 2 -- hasTranscriptContent admits only the three message kinds */
		default: return assertNever(event, "transcript entry");
	}
}
/**
* Format one message of a transcript.
* @param seq - Event sequence number shown as the line label.
* @param label - Message role or result kind.
* @param content - Message content blocks.
* @returns The labelled transcript line.
*/
function labelledLine(seq, label, content) {
	return `${seq} ${label}: ${blocksText(content)}`;
}
/**
* Flatten message content blocks into one line of text.
*
* A reflection reads what the Session said and which tools it called; images,
* file attachments, reasoning, and tool-change blocks stay out of the compact
* transcript.
* @param content - Message content blocks.
* @returns Readable text with tool calls summarized as `name(arguments)`.
*/
function blocksText(content) {
	const parts = [];
	for (const block of content) if (block.type === "text") parts.push(clipped(block.text, TRANSCRIPT_BLOCK_MAX_CHARS));
	else if (block.type === "tool-call") parts.push(`${block.name}(${clipped(block.arguments, TRANSCRIPT_ARGUMENTS_MAX_CHARS)})`);
	return parts.join(" ").trim();
}
/**
* Cut one text to a character bound.
* @param value - Source text.
* @param maximum - Maximum characters kept, including the ellipsis.
* @returns The text, or its prefix with an ellipsis.
*/
function clipped(value, maximum) {
	return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
/**
* Format one epoch instant as an ISO-8601 string.
* @param milliseconds - Unix epoch milliseconds.
* @returns The instant in ISO-8601 form.
*/
function instant(milliseconds) {
	return new Date(milliseconds).toISOString();
}
/**
* ISO 8601 instant with an explicit offset, as the bound arguments accept it.
*
* The date, the clock time, and the offset are captured separately so the text
* can be checked as a real instant: `Date.parse` alone accepts a day the month
* does not have and reads a timestamp without an offset as the host's local
* time, which would select other Sessions than the caller meant.
*/
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/u;
/**
* Read one ISO-8601 instant argument.
* @param value - Argument text.
* @param field - Parameter name used in the diagnostic.
* @returns The instant in ISO-8601 form.
* @throws ToolArgsError when the text is not an ISO 8601 instant with an explicit offset.
*/
function instantArgument(value, field) {
	const match = ISO_INSTANT.exec(value);
	if (match === null) throw new ToolArgsError([`${field} must be an ISO 8601 instant with an explicit offset, such as 2026-11-22T03:00:00Z`]);
	const [, year = "0", month = "0", day = "0", hour = "0", minute = "0", second = "00", offsetHour, offsetMinute] = match;
	if (!(offsetHour === void 0 || Number(offsetHour) <= 23 && Number(offsetMinute) <= 59) || !isRealCalendarTime(year, month, day, hour, minute, second)) throw new ToolArgsError([`${field} must name a real calendar date, clock time, and offset`]);
	return new Date(Date.parse(value)).toISOString();
}
/**
* Whether one captured date and clock time exist on a real calendar.
* @param year - Four-digit year.
* @param month - Two-digit month.
* @param day - Two-digit day of the month.
* @param hour - Two-digit hour of the day.
* @param minute - Two-digit minute of the hour.
* @param second - Two-digit second of the minute.
* @returns `true` when those fields name one instant.
*/
function isRealCalendarTime(year, month, day, hour, minute, second) {
	const yearNumber = Number(year);
	const monthNumber = Number(month);
	const dayNumber = Number(day);
	const hourNumber = Number(hour);
	const minuteNumber = Number(minute);
	const secondNumber = Number(second);
	const instant = /* @__PURE__ */ new Date(0);
	instant.setUTCFullYear(yearNumber, monthNumber - 1, dayNumber);
	instant.setUTCHours(hourNumber, minuteNumber, secondNumber, 0);
	return yearNumber === instant.getUTCFullYear() && monthNumber === instant.getUTCMonth() + 1 && dayNumber === instant.getUTCDate() && hourNumber === instant.getUTCHours() && minuteNumber === instant.getUTCMinutes() && secondNumber === instant.getUTCSeconds();
}
/**
* Read one optional bounded count argument.
* @param value - Argument value, or `undefined` for the default.
* @param fallback - Value used when the argument is absent.
* @param maximum - Largest accepted value.
* @param field - Parameter name used in the diagnostic.
* @returns The accepted count.
* @throws ToolArgsError when the value is not an integer inside the accepted range.
*/
function boundedInteger(value, fallback, maximum, field) {
	if (value === void 0) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ToolArgsError([`${field} must be an integer from 1 to ${maximum}`]);
	return value;
}
/**
* Read one optional positive integer argument.
* @param value - Argument value, or `undefined` when the argument is absent.
* @param field - Parameter name used in the diagnostic.
* @param requirement - What the value must be, completing the sentence after "must be".
* @returns The accepted value, or `undefined` when the argument is absent.
* @throws ToolArgsError when the value is not a positive integer.
*/
function positiveInteger(value, field, requirement) {
	if (value === void 0) return void 0;
	if (!Number.isSafeInteger(value) || value < 1) throw new ToolArgsError([`${field} must be ${requirement}`]);
	return value;
}
/**
* Wrap one line of text as tool content.
* @param value - Rendered text.
* @returns One text content block.
*/
function text(value) {
	return [{
		type: "text",
		text: value
	}];
}
/**
* Describe the pending state of one sleep tool call.
* @param title - Card title for this call.
* @param kind - Category the call belongs to.
* @param rawInput - Salient argument shown in an expanded view.
* @returns The generic call card.
*/
function callView(title, kind, rawInput) {
	return {
		card: "generic",
		title,
		kind,
		...rawInput === void 0 ? {} : { rawInput }
	};
}
/**
* Describe the completed state of one sleep tool call.
* @param title - Card title carried over from the pending state.
* @param failed - Whether the call failed.
* @returns The generic result card.
*/
function resultView(title, failed) {
	return {
		card: "generic",
		title: failed ? `${title} failed` : title
	};
}
/**
* Render a Session listing.
* @param value - Resolved listing.
* @returns One header line, one line per Session, the Sessions it could not
* read, and the cursor of the next page.
*/
function renderSessionList(value) {
	const bounds = [...value.since === void 0 ? [] : [`since ${value.since}`], ...value.before === void 0 ? [] : [`before ${value.before}`]];
	const scope = bounds.length === 0 ? "all history" : `activity ${bounds.join(" and ")}`;
	const header = `${value.shown} of ${value.total} Sessions, ${scope}`;
	const rows = value.sessions.map(sessionRowLine);
	const unreadable = value.unreadable === void 0 ? [] : [unreadableLine(value.unreadable)];
	const last = value.sessions.at(-1);
	const cursor = last !== void 0 && value.shown < value.total ? [`continue with before ${last.activity_at} and before_id ${last.id}`] : [];
	return [
		header,
		...rows,
		...unreadable,
		...cursor
	].join("\n");
}
/**
* Render one listed Session.
* @param row - Session row the tool reports.
* @returns The rendered line for that Session.
*/
function sessionRowLine(row) {
	const title = row.title === void 0 ? "" : ` ${JSON.stringify(row.title)}`;
	const preset = row.agentPreset === void 0 ? "" : `, preset ${row.agentPreset}`;
	const earlierSleep = row.sleepSession ? ", earlier sleep" : "";
	return `- ${row.id}${title} · created ${row.created_at} · active ${row.activity_at}${preset}${earlierSleep}`;
}
/**
* Render the Sessions one listing could not read.
*
* The ids are bounded, so the count stays the number the listing could not
* read while the line stays proportional to the configured page bound.
* @param unreadable - Sessions the listing could not read.
* @returns One line naming them.
*/
function unreadableLine(unreadable) {
	const omitted = unreadable.total - unreadable.sessions.length;
	const subject = unreadable.total === 1 ? "Session" : "Sessions";
	const verb = unreadable.total === 1 ? "was" : "were";
	return `${unreadable.total} ${subject} could not be read and ${verb} left out: ${unreadable.sessions.join(", ")}${omitted === 0 ? "" : `, and ${omitted} more`}`;
}
/**
* Render one Session transcript page.
* @param value - Resolved transcript page.
* @returns One header line and the page text.
*/
function renderTranscript(value) {
	const title = value.title === void 0 ? "" : ` ${JSON.stringify(value.title)}`;
	const head = `${value.session_id}${title} · created ${value.created_at}`;
	if (value.total === 0) return `${head} · no transcript entries`;
	if (value.shown === 0) return `${head} · no entries from offset ${value.offset} of ${value.total}`;
	const last = value.offset + value.shown - 1;
	const next = value.eof ? "" : `\ncontinue with offset ${last + 1}`;
	return `${head} · entries ${value.offset}-${last} of ${value.total}\n${value.text}${next}`;
}
/**
* Render one note listing.
* @param value - Resolved note listing.
* @returns The header, one line per note, and the cursor of the next page.
*/
function renderNoteList(value) {
	const scope = value.after === void 0 ? "" : ` after ${value.after}`;
	const counted = value.shown === value.total ? `${value.total}` : `${value.shown} of ${value.total}`;
	const lines = [`Sleep notes in ${value.dir}${scope} (${counted})`, ...value.files.map((note) => `- ${note.path} (${note.bytes} bytes, modified ${note.modified_at})`)];
	const last = value.files.at(-1);
	if (last !== void 0 && value.shown < value.total) lines.push(`continue after ${last.path}`);
	return lines.join("\n");
}
/**
* Render one deletion with the notes it removed.
* @param value - Resolved deletion.
* @returns One header line and the removed note paths that are listed.
*/
function renderDeletion(value) {
	if (value.kind === "link") return `Removed the symbolic link ${value.path}; the note it names stays`;
	const files = `${value.removed_files} ${value.removed_files === 1 ? "file" : "files"}`;
	const head = `Deleted sleep ${value.kind} ${value.path} (${files}, ${value.removed_bytes} bytes)`;
	if (value.kind === "file") return head;
	const lines = [head, ...value.removed_paths.map((path) => `- ${path}`)];
	if (value.omitted_paths > 0) lines.push(`- and ${value.omitted_paths} more notes`);
	return lines.join("\n");
}
/**
* Render one note read.
* @param value - Resolved note window.
* @returns One header line and the note text.
*/
function renderNote(value) {
	const cut = value.truncated ? " · cut at the read byte limit" : "";
	if (value.total === 0) return value.truncated ? `${value.path} · no lines loaded before the read byte limit` : `${value.path} · empty note`;
	if (value.shown === 0) return `${value.path} · no lines from offset ${value.offset} of ${value.total}${cut}`;
	const last = value.offset + value.shown - 1;
	const next = value.offset - 1 + value.shown < value.total ? `\ncontinue with offset ${last + 1}` : "";
	return `${value.path} · lines ${value.offset}-${last} of ${value.total}${cut}\n${value.text}${next}`;
}
//#endregion
//#region lib/types/index.js
/**
* Host runtime of the daily sleep cycle, and the package entry.
*
* One mounted runtime owns the durable sleep state, the single daily timer, the
* one in-flight run, and the Session that run drives. It decides whether a
* scheduled slot has anything to reflect on, starts a Session under the sleep
* preset, and records how the attempt ended.
*
* The sleep Session is created outside any initiating Agent, under the sleep
* preset only, with the sleep tools mounted in its own scoped context. Working
* Sessions are never touched: their model selection, notes, and lifecycle stay
* as the user left them, and the notes reach them through the separate memory
* injector, which this entry installs beside the `/sleep` command.
* @module @deepseek-ai/dsh-sleep
*/
/** Whether one raw Session event closes the given turn. */
function isTurnEndOf(event, turn) {
	return event.type === "turn/end" && event.data.turn === turn;
}
/**
* Describe why a turn did not complete.
* @param reason - Recorded turn-end reason.
* @returns One sentence naming the outcome.
*/
function describeTurnEnd(reason) {
	if (reason.kind === "error") return `the sleep turn failed: ${reason.error.message}`;
	if (reason.kind === "aborted") return `the sleep turn was aborted (${reason.reason.kind})`;
	if (reason.kind === "max-tokens") return "the sleep turn reached its output-token ceiling";
	return `the sleep turn ended as ${reason.kind}`;
}
/** Sentence recorded when a failure names no reason of its own. */
const UNREPORTED_FAILURE = "the sleep run failed without a reported message";
/**
* Read the reason one failed attempt reports.
*
* A rejection can carry an empty message, and the durable schema rejects an
* empty reason, so a failure that names nothing reports a fixed sentence
* instead of a record the next Host cannot open. A rejected value whose own text
* throws names nothing either; reading it here keeps the attempt's outcome from
* being lost.
* @param error - Rejected value.
* @returns Its message, or the fallback sentence when it names none.
*/
function failureReason(error) {
	let message;
	try {
		message = (error instanceof Error ? error.message : String(error)).trim();
	} catch (unreadable) {
		return UNREPORTED_FAILURE;
	}
	return message === "" ? UNREPORTED_FAILURE : message;
}
/**
* Read the zone the running Host reports.
* @returns The host's IANA zone name, or an empty string when it names none.
*/
function hostTimeZone() {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
/**
* Longest teardown waits for the run in progress.
*
* The run is cancelled first, so this bound only ends a wait on work that
* ignores its cancellation; unloading must not block on it forever.
*/
const TEARDOWN_SETTLE_MS = 5e3;
/**
* Longest one attempt waits for the Agent preset registry and its preset row.
*
* The runtime does not require the registry, so a composition announces it
* whenever its own row activates. A scheduled catch-up at Host start can reach
* the run before that row - or the `preset-sleep` row that registers the preset -
* activated; the wait covers that startup window instead of failing the attempt
* and consuming the day's slot. A composition that never provides the preset
* still fails the attempt inside the bound, so a run never holds the slot
* indefinitely.
*/
const PRESET_WAIT_MS = 1e4;
/** How often the preset wait checks whether the registry and its preset are ready. */
const PRESET_POLL_MS = 100;
/**
* Longest one run waits for a tool execution it admitted before it releases the
* sleep slot.
*
* The slot may not pass to the next run while a note write this run admitted is
* still pending, because that write would land in the notes directory the next
* run now owns. An execution that never settles must not hold the slot forever
* either: the runtime would refuse every later run, and a reload would stay
* unusable for the life of the process. The wait therefore outlasts any
* plausible single note write and then releases the slot with a warning.
*/
const SLOT_SETTLE_MS = 3e4;
/**
* Daily reflective sleep (`ctx.sleep`).
*
* The runtime is the package's Service plugin: it opens the durable state,
* arms the timer, publishes {@link SleepService}, reloads the saved notes into
* working Sessions, and answers `/sleep`. It requires the Agent registry, the
* Session store, the Session query engine, the tool registry, and domain
* storage; the preset registry, the Web Session controller, the title service,
* the default model, and the command registry are optional and resolved where
* they are used.
*/
var SleepRuntime = class extends Service {
	/** Host services this plugin cannot run without. */
	static inject = [
		"agents",
		"sessions",
		"sessionQuery",
		"storageDomain",
		"tools"
	];
	/** Loader-validated plugin configuration. */
	static Config = Config;
	/** Resolved plugin configuration every run reads. */
	config;
	/**
	* Durable state handle.
	*
	* Entry opens it, and an attempt that finds it missing opens it again, so a
	* store that was unavailable at activation is retried instead of disabling the
	* plugin for the life of the process.
	*/
	store;
	/** Failure the last store open reported, or `undefined` while the store is readable. */
	storeFailure;
	/** Last committed state; updated only after a write lands. */
	current;
	/** Entry-point completion; the runtime is usable once this settles. */
	initialized;
	/** Pending timer, or `undefined` while disarmed. */
	timer;
	/** The run that holds this runtime's single slot. */
	active;
	/** Local date this process already decided about, so a failed state write cannot repeat the day. */
	attemptedDate = null;
	/** Set once teardown begins: no new timer and no new run. */
	stopping = false;
	/**
	* @param ctx - Host context that owns storage, Sessions, and Agents.
	* @param config - Loader-validated plugin row.
	*/
	constructor(ctx, config) {
		super(ctx, "sleep");
		this.config = resolveConfig(config, { hostTimeZone: hostTimeZone() });
		this.current = EMPTY_SLEEP_STATE;
		this.initialized = ctx.effect(async () => {
			await ensureNotesDirectory(this.config.dir);
			await this.openStore();
			this.scheduleNext();
			return async () => {
				this.stopping = true;
				this.clearTimer();
				this.stopActiveRun();
				const run = this.active?.run;
				if (run !== void 0 && !await this.settleActiveRun(run)) {
					const closeWhenSettled = () => {
						/* v8 ignore next 3 -- a backend close fault after the save changes no reported outcome */
						this.closeStore().catch((error) => {
							this.ctx.logger.warn(`sleep: the store was not closed: ${String(error)}`);
						});
					};
					run.then(closeWhenSettled, closeWhenSettled);
					return;
				}
				await this.closeStore();
			};
		});
	}
	/**
	* Load the durable state, then install the surfaces that serve working Sessions.
	*
	* The notes injector and the instruction guard read the notes directory and
	* the Session, never the store, so they are installed before it opens: a store
	* that cannot open must not disable the notes a working Session depends on.
	* `/sleep` is different - it starts a run that records its outcome - so it
	* appears only after the entry point settled.
	*/
	async [Service.init]() {
		await installMemoryInjector(this.ctx, this.config);
		installInstructionGuard(this.ctx, this.config.presetId);
		await this.initialized;
		installSleepCommand(this.ctx, this);
	}
	/** Current durable lifecycle facts, as last committed. */
	get state() {
		return this.current;
	}
	/** Why the durable state is unavailable, or `null` while it is readable. */
	get stateError() {
		if (this.store !== void 0) return null;
		if (this.storeFailure === void 0) return "the durable sleep state has not opened yet";
		return failureReason(this.storeFailure);
	}
	/** Session of the run in progress, or `null` when no run is active. */
	get activeSessionId() {
		return this.active?.sessionId ?? null;
	}
	/** Whether a run holds the runtime's slot, including before it created a Session. */
	get activeRun() {
		return this.active !== void 0;
	}
	/**
	* Read the slot the daily timer waits for.
	*
	* The answer uses the same decision date as the timer, so a date this
	* process already claimed moves both.
	* @param nowMs - Current instant in epoch milliseconds; defaults to the clock reading.
	* @returns The armed slot, or `null` when scheduled runs are off.
	*/
	nextSlot(nowMs = Date.now()) {
		if (this.stopping || !this.config.enabled) return null;
		const delayMs = nextDelayMs(nowMs, this.config.time, this.config.timeZone, this.decidedDate());
		return {
			at: nowMs + delayMs,
			delayMs
		};
	}
	/**
	* Start one manual run now and report how it ended.
	*
	* A manual run ignores `enabled` and `minSessions`, because the caller asked
	* for it. Scheduled attempts are taken by the timer through its own due
	* check, so a caller cannot consume a slot that is not due yet.
	* @returns The attempt's result, including a skipped or failed attempt.
	* @throws SleepError with code `SLEEP_RUN_IN_PROGRESS` while another run is active.
	* @throws SleepError with code `SLEEP_RUNTIME_STOPPING` after teardown began.
	*/
	async runNow() {
		return await this.startNow().settled;
	}
	/**
	* Start one manual run now and hand back its start and completion.
	*
	* A command surface reports the started run instead of waiting for a
	* reflection that takes minutes, so the run outlives the invocation that
	* started it.
	* @returns The run's start and its result.
	* @throws SleepError with code `SLEEP_RUN_IN_PROGRESS` while another run is active.
	* @throws SleepError with code `SLEEP_RUNTIME_STOPPING` after teardown began.
	*/
	startNow() {
		return this.start("manual", Date.now());
	}
	/**
	* Claim the single slot while one attempt runs outside any initiating Agent.
	*
	* The slot is claimed inside the initiator boundary, which runs the operation
	* synchronously: a scope that refuses the boundary leaves no slot behind.
	* @param trigger - What started the run.
	* @param claimedAtMs - Clock reading the run is claimed for; it decides both the
	* date the attempt claims and the instant the attempt started.
	* @returns The run's start and result promises.
	* @throws SleepError with code `SLEEP_RUN_IN_PROGRESS` while another run is active.
	* @throws SleepError with code `SLEEP_RUNTIME_STOPPING` after teardown began.
	*/
	start(trigger, claimedAtMs) {
		if (this.stopping) throw runtimeStoppingError();
		if (trigger === "scheduled") this.attemptedDate = localDateKey(claimedAtMs, this.config.timeZone);
		if (this.active !== void 0) throw runInProgressError(this.active.sessionId);
		const started = Promise.withResolvers();
		const active = {
			sessionId: null,
			abort: new AbortController(),
			agent: void 0,
			handle: void 0,
			tools: void 0,
			drain: void 0,
			started,
			run: void 0
		};
		const run = this.ctx.agents.withoutInitiator(async () => {
			this.active = active;
			try {
				return await this.execute(active, trigger, claimedAtMs);
			} finally {
				started.resolve(active.sessionId);
			}
		});
		active.run = run;
		const settled = run.then((result) => {
			this.active = void 0;
			return result;
		}, (error) => {
			this.active = void 0;
			throw error;
		});
		settled.catch((error) => {
			this.ctx.logger.warn(`sleep: the run failed outside its attempt record: ${String(error)}`);
		});
		return {
			started: started.promise,
			settled
		};
	}
	/**
	* Open the durable state.
	*
	* A failure is logged and kept instead of failing the activation: the notes
	* injection, the instruction guard, and `/sleep status` read no store, and an
	* attempt that needs it retries this open instead of refusing forever.
	*/
	async openStore() {
		try {
			const store = await openSleepStore(this.ctx);
			this.store = store;
			this.current = store.state;
			this.storeFailure = void 0;
		} catch (error) {
			this.storeFailure = error;
			this.ctx.logger.error(`sleep: the durable state could not be opened, so sleep runs are refused until it does: ${String(error)}`);
		}
	}
	/**
	* Read the open store, retrying a failed open once.
	* @returns The open durable state.
	* @throws SleepError with code `SLEEP_STORE_UNAVAILABLE` when the retry also fails.
	*/
	async ensureStore() {
		if (this.store === void 0) await this.openStore();
		const store = this.store;
		if (store === void 0) throw storeUnavailableError(this.storeFailure);
		return store;
	}
	/**
	* Close the durable state this runtime holds.
	*
	* A store that never opened leaves nothing to close.
	*/
	async closeStore() {
		const store = this.store;
		this.store = void 0;
		if (store === void 0) return;
		await store.close();
	}
	/**
	* Carry out one attempt and commit its outcome.
	* @param active - Slot-holding run record the attempt fills in.
	* @param trigger - What started the run.
	* @param startedAtMs - Clock reading the attempt started at; the one claim instant.
	* @returns The attempt's result.
	*/
	async execute(active, trigger, startedAtMs) {
		await this.initialized;
		const store = await this.ensureStore();
		const startedAt = new Date(startedAtMs).toISOString();
		const date = localDateKey(startedAtMs, this.config.timeZone);
		let workingSessions;
		try {
			const presets = await this.waitForPresets(active.abort.signal);
			workingSessions = await this.countActiveWorkingSessions();
			if (trigger === "scheduled" && workingSessions < this.config.minSessions) return await this.record(store, trigger, startedAt, date, {
				status: "skipped",
				sessionId: null,
				workingSessions,
				reason: `${workingSessions} working Sessions were active since the last sleep; ${this.config.minSessions} required`
			});
			active.abort.signal.throwIfAborted();
			const agent = await this.openSleepSession(active, presets, date);
			this.cancelIfAborted(active, agent);
			active.abort.signal.throwIfAborted();
			await this.selectReasoningEffort(agent);
			active.abort.signal.throwIfAborted();
			const prompt = this.sleepMessage(agent, trigger, startedAtMs, workingSessions);
			let runTurn;
			const stopClaim = agent.ctx.on("agent/inbox/claimed", ({ agent: subject, message, turn }) => {
				if (subject.id === agent.id && message.id === prompt.id) runTurn = turn;
			});
			try {
				agent.followup(prompt);
				await this.ctx.sessions.flush(agent.session);
				await agent.whenIdle();
				await this.ctx.sessions.flush(agent.session);
				const outcome = await this.turnOutcome(agent.session.id, runTurn);
				active.abort.signal.throwIfAborted();
				return await this.record(store, trigger, startedAt, date, {
					...outcome,
					sessionId: agent.session.id,
					workingSessions
				});
			} finally {
				stopClaim();
			}
		} catch (error) {
			return await this.record(store, trigger, startedAt, date, {
				status: "failed",
				sessionId: active.sessionId,
				...workingSessions === void 0 ? {} : { workingSessions },
				reason: failureReason(error)
			});
		} finally {
			await this.releaseTools(active);
			await this.releaseHandle(active);
		}
	}
	/**
	* Wait until the Agent preset registry and the configured preset are ready.
	*
	* The registry is optional, so it may appear after this plugin activated, and
	* the row that registers the preset is a separate plugin that can activate even
	* later. A run that needs the preset waits instead of failing, because a failed
	* scheduled attempt records its date and consumes the day's only slot for a
	* dependency that is only late. The wait ends when the preset is ready, when
	* the run is cancelled, or after {@link PRESET_WAIT_MS}.
	* @param signal - Cancellation of the run that needs the preset.
	* @returns The preset registry that can mount the configured preset.
	* @throws SleepError with code `SLEEP_PRESETS_UNAVAILABLE` when the preset never becomes ready inside the wait.
	* @throws SleepError with code `SLEEP_RUNTIME_STOPPING` when the run is cancelled during the wait.
	*/
	async waitForPresets(signal) {
		signal.throwIfAborted();
		return await new Promise((resolve, reject) => {
			let finished = false;
			let poll;
			const finish = () => {
				finished = true;
				if (poll !== void 0) clearTimeout(poll);
				clearTimeout(deadline);
				signal.removeEventListener("abort", onAbort);
			};
			const check = async () => {
				const presets = this.ctx.get("agentPresets");
				if (presets !== void 0) {
					const readiness = await this.presetReadiness(presets);
					if (readiness.kind === "ready") {
						finish();
						resolve(presets);
						return;
					}
					if (readiness.kind === "broken") {
						if (!finished) {
							finish();
							reject(presetBrokenError(this.config.presetId, readiness.diagnostic));
						}
						return;
					}
				}
				if (finished) return;
				poll = setTimeout(() => {
					check();
				}, PRESET_POLL_MS);
				poll.unref();
			};
			const deadline = setTimeout(() => {
				finish();
				reject(presetsUnavailableError());
			}, PRESET_WAIT_MS);
			deadline.unref();
			const onAbort = () => {
				finish();
				reject(runtimeStoppingError());
			};
			signal.addEventListener("abort", onAbort, { once: true });
			check();
		});
	}
	/**
	* Read whether the registry can mount the configured preset.
	*
	* Only a preset that has not been registered yet is worth waiting for: a
	* preset whose composition failed to activate reports a diagnostic that no
	* later check can repair, and a preset the registry can mount is ready.
	* @param presets - Agent preset registry the run would mount from.
	* @returns What the registry answered about the configured preset.
	*/
	async presetReadiness(presets) {
		const preset = await presets.resolve(this.config.presetId).catch((error) => {});
		if (preset === void 0) return { kind: "pending" };
		if (preset.broken !== void 0) return {
			kind: "broken",
			diagnostic: preset.broken
		};
		return { kind: "ready" };
	}
	/**
	* Count the working Sessions the run should reflect on.
	*
	* A Session created before the last completed sleep but still in use counts,
	* so the activity instant decides rather than the creation date. Sleep
	* Sessions themselves never count: the preset projection decides, so a blank
	* Session moved away from the sleep preset before its first turn counts and
	* one moved onto it does not, and a checkpoint that cannot prove the preset is
	* confirmed from the durable log. A Session whose persisted projection cannot
	* prove activity after the last sleep is confirmed from its own log, so a
	* crash between a committed prompt and the next checkpoint cannot hide it.
	* A Session whose log cannot be read is left out of the count with a warning:
	* one unreadable history must not consume the day's only sleep.
	* @returns Number of non-sleep Sessions active after the last completed sleep.
	* @throws SleepError with code `SLEEP_SESSION_QUERY_FAILED` when the corpus cannot be listed.
	*/
	async countActiveWorkingSessions() {
		const records = await sleepSessionQuery(this.ctx, "listSessions", () => this.ctx.sessionQuery.listSessions());
		const since = this.current.lastSleepAt === null ? null : Date.parse(this.current.lastSleepAt);
		let count = 0;
		for (const record of records) {
			try {
				if (await isSleepSessionRecord(this.ctx, record, this.config.presetId)) continue;
				const activityAt = await resolveSessionActivityAt(this.ctx, record, since === null ? {} : { after: since });
				if (since !== null && activityAt <= since) continue;
			} catch (error) {
				if (!(error instanceof SleepError && error.code === "SLEEP_SESSION_QUERY_FAILED")) throw error;
				this.ctx.logger.warn(`sleep: Session ${record.header.id} was left out of the activity count: ${String(error)}`);
				continue;
			}
			count += 1;
		}
		return count;
	}
	/**
	* Create the sleep Session, mount its tools, and take ownership of it.
	*
	* A composed Session controller creates the visible Web Session; otherwise
	* the Agent registry creates one whose lifecycle this run owns. The identity
	* enters the run record only after creation succeeded, so a failed creation
	* is never reported with a Session that does not exist. The notes directory was
	* created when the runtime activated, so the controller finds it and keeps its
	* private mode.
	* @param active - Slot-holding run record that receives the Session identity, Agent, and handle.
	* @param presets - Agent preset registry the sleep preset is mounted from.
	* @param date - Local date the run belongs to, used for the Session title.
	* @returns The live Agent of the sleep Session.
	* @throws when creation cannot name a Session or resolve its Agent.
	*/
	async openSleepSession(active, presets, date) {
		active.abort.signal.throwIfAborted();
		const cwd = this.config.dir;
		const requested = SessionId(`sleep-${randomUUID()}`);
		const controller = this.ctx.get("sessionController");
		let agent;
		if (controller !== void 0) {
			const created = await controller.create({
				sessionId: requested,
				cwd,
				agentPreset: this.config.presetId
			});
			active.sessionId = created.sessionId;
			active.started.resolve(created.sessionId);
			const resolved = await controller.resolveAgent(created.sessionId);
			if ("error" in resolved) throw resolved.error;
			agent = resolved.agent;
		} else {
			const handle = await this.ctx.agents.create({
				sessionId: requested,
				signal: active.abort.signal,
				meta: {
					cwd,
					agentPreset: this.config.presetId
				},
				agentOptions: this.agentOptions(),
				setup: async (agentCtx) => {
					await presets.mount(agentCtx, this.config.presetId);
				}
			});
			active.handle = handle;
			active.sessionId = handle.agent.session.id;
			active.started.resolve(active.sessionId);
			agent = handle.agent;
		}
		active.agent = agent;
		this.cancelIfAborted(active, agent);
		active.abort.signal.throwIfAborted();
		const drain = createExecutionDrain();
		active.drain = drain;
		const tools = agent.ctx.plugin(tools_exports, { drain });
		active.tools = tools;
		await tools;
		this.nameSession(agent, date);
		return agent;
	}
	/**
	* Model options for a Session this runtime creates.
	* @returns The deployment's default selection, or empty options when none is configured.
	*/
	agentOptions() {
		return this.ctx.get("agentDefaultModel")?.currentSelection() ?? {};
	}
	/**
	* Name the sleep Session after the date it reflects on.
	*
	* A title that cannot be set must not stop the run.
	* @param agent - Agent of the sleep Session.
	* @param date - Local date the run belongs to.
	*/
	nameSession(agent, date) {
		try {
			this.ctx.get("sessionTitle")?.rename(agent.session, `Sleep · ${date}`);
		} catch (error) {
			this.ctx.logger.warn(`sleep: the sleep Session was not named: ${String(error)}`);
		}
	}
	/**
	* Give the sleep Session the configured reasoning effort.
	*
	* The choice is recorded on this Session only: working Sessions keep the
	* user's own selection, and the deployment default is not rewritten.
	* @param agent - Agent of the sleep Session.
	*/
	async selectReasoningEffort(agent) {
		const current = agent.model.current();
		if (current === void 0) {
			this.ctx.logger.warn("sleep: the sleep Session has no model route, so its reasoning effort was not set");
			return;
		}
		const effort = await this.resolveReasoningEffort(current.provider, current.model);
		agent.model.select({
			provider: current.provider,
			model: current.model,
			...effort === void 0 ? {} : { reasoningEffort: effort }
		});
	}
	/**
	* Match the configured effort against the efforts the routed model declares.
	*
	* A model without the configured level rejects every request that names it,
	* which would end the sleep turn as an error and never advance
	* `lastSleepAt`. The model's own default effort is the downgrade; a model
	* that declares no efforts at all gets no explicit effort, so its adapter
	* default applies. Each downgrade is logged.
	* @param provider - Provider route of the sleep Session.
	* @param model - Model id of the sleep Session.
	* @returns The effort to record, or `undefined` to leave the adapter default.
	*/
	async resolveReasoningEffort(provider, model) {
		const requested = ReasoningEffortId(this.config.reasoningEffort);
		const llm = this.ctx.get("llm");
		if (llm === void 0) return requested;
		let info;
		try {
			info = await llm.resolveModelInfo(provider, model);
		} catch (error) {
			this.ctx.logger.warn(`sleep: the reasoning efforts of ${provider}/${model} were not read, so its adapter default applies: ${String(error)}`);
			return;
		}
		const reasoning = info.reasoning;
		if (reasoning === void 0) {
			this.ctx.logger.warn(`sleep: ${provider}/${model} declares no reasoning effort, so ${requested} was not selected`);
			return;
		}
		if (reasoning.efforts.some((effort) => effort.id === requested)) return requested;
		this.ctx.logger.warn(`sleep: ${provider}/${model} does not offer reasoning effort ${requested}; ` + (reasoning.defaultEffort === void 0 ? "its adapter default applies" : `using ${reasoning.defaultEffort} instead`));
		return reasoning.defaultEffort;
	}
	/**
	* Build the prompt that opens the sleep Session.
	*
	* The block carries facts only: when the run happens, when the last one
	* completed, how much happened since, where the notes live, and which tools
	* the Session has. Style and format stay the preset's business.
	* @param agent - Agent of the sleep Session, whose mounted tools the prompt lists.
	* @param trigger - What started the run.
	* @param startedAtMs - Run start instant in epoch milliseconds.
	* @param workingSessions - Working Sessions counted for this run.
	* @returns One durable user message carrying the prompt and its source.
	*/
	sleepMessage(agent, trigger, startedAtMs, workingSessions) {
		const date = localDateKey(startedAtMs, this.config.timeZone);
		const when = trigger === "scheduled" ? `${date} ${this.config.time} ${this.config.timeZone}` : `${date} ${this.config.timeZone}`;
		const heading = `${trigger === "scheduled" ? "Scheduled" : "Manual"} sleep run · ${when}`;
		const tools = this.ctx.tools.schemas(agent).map((schema) => schema.name);
		return createUserMessage({
			content: [{
				type: "text",
				text: [
					heading,
					`Now: ${new Date(startedAtMs).toISOString()}`,
					`Last completed sleep: ${this.current.lastSleepAt ?? "none yet"}`,
					`Working Sessions active since then: ${workingSessions}`,
					`Notes directory: ${this.config.dir}`,
					`Tools in this Session: ${tools.join(", ")}.`
				].join("\n")
			}],
			source: {
				kind: "sleep",
				trigger,
				form: "notice",
				summary: boundContextSummary(`${trigger} sleep run over ${workingSessions} active Sessions`)
			}
		});
	}
	/**
	* Classify the turn the sleep prompt started.
	* @param sessionId - Sleep Session whose log is read.
	* @param turn - Turn that claimed the sleep prompt, or `undefined` when no turn claimed it.
	* @returns `completed`, or `failed` with the recorded reason.
	* @throws SleepError with code `SLEEP_SESSION_QUERY_FAILED` when the log cannot be read.
	*/
	async turnOutcome(sessionId, turn) {
		if (turn === void 0) return {
			status: "failed",
			reason: "the sleep prompt was never claimed for a turn"
		};
		const end = (await sleepSessionQuery(this.ctx, "readSession", () => this.ctx.sessionQuery.readSession(sessionId))).events.findLast((event) => isTurnEndOf(event, turn));
		if (end === void 0) return {
			status: "failed",
			reason: `the sleep turn ${turn} recorded no end`
		};
		if (end.data.reason.kind === "completed") return { status: "completed" };
		return {
			status: "failed",
			reason: describeTurnEnd(end.data.reason)
		};
	}
	/**
	* Commit one attempt's state and report it.
	*
	* `lastSleepAt` advances only for a completed run; a scheduled attempt
	* always records its date, so a failed day is not retried on the same date.
	* A state write that fails is logged and leaves the previous durable state
	* readable, because the run itself already happened.
	* @param store - Durable state this attempt records into.
	* @param trigger - What started the run.
	* @param startedAt - Run start instant in ISO-8601 form.
	* @param date - Local date the run belongs to.
	* @param attempt - How the attempt ended.
	* @returns The result reported to the caller.
	*/
	async record(store, trigger, startedAt, date, attempt) {
		const completed = attempt.status === "completed";
		const outcome = {
			at: startedAt,
			trigger,
			status: attempt.status,
			...attempt.sessionId === null ? {} : { sessionId: attempt.sessionId },
			...attempt.reason === void 0 ? {} : { reason: attempt.reason }
		};
		const next = {
			lastSleepAt: completed ? startedAt : this.current.lastSleepAt,
			lastScheduledDate: trigger === "scheduled" ? date : this.current.lastScheduledDate,
			lastOutcome: outcome
		};
		const result = {
			...outcome,
			sessionId: attempt.sessionId,
			...attempt.workingSessions === void 0 ? {} : { workingSessions: attempt.workingSessions }
		};
		try {
			await store.save(next);
			this.current = next;
		} catch (error) {
			this.ctx.logger.warn(`sleep: the ${attempt.status} outcome was not saved: ${String(error)}`);
		}
		return result;
	}
	/**
	* Unmount the sleep tools this run mounted and wait for the executions they
	* admitted.
	*
	* A visible Web Session outlives its run, so the tools must not: a follow-up in
	* that Session could otherwise change the shared notes while the next run is
	* active. The preset's isolation row still masks the inherited host tools. The
	* wait after the fiber stops is bounded by {@link SLOT_SETTLE_MS}: the fiber
	* already refused new executions of the disposed tools, so only a write
	* admitted before the unload can still be pending, and an execution that never
	* settles must not hold the slot, and with it every later run, for the life of
	* the process.
	* @param active - Slot-holding run record.
	*/
	async releaseTools(active) {
		const tools = active.tools;
		const drain = active.drain;
		active.tools = void 0;
		active.drain = void 0;
		if (tools !== void 0) try {
			await tools.dispose();
		} catch (error) {
			/* v8 ignore next -- a Cordis fiber reports its own teardown failures to the logger instead of rejecting */
			this.ctx.logger.warn(`sleep: the sleep tools were not unmounted: ${String(error)}`);
		}
		if (drain === void 0) return;
		if (await drain.close(SLOT_SETTLE_MS)) return;
		this.ctx.logger.warn(`sleep: a tool execution this run admitted was still running ${SLOT_SETTLE_MS} ms after the run unmounted its tools, so the sleep slot was released with it pending`);
	}
	/**
	* Release the Agent handle this run owns.
	* @param active - Slot-holding run record.
	*/
	async releaseHandle(active) {
		const handle = active.handle;
		active.handle = void 0;
		if (handle === void 0) return;
		try {
			await handle.dispose();
		} catch (error) {
			this.ctx.logger.warn(`sleep: the sleep Agent was not disposed: ${String(error)}`);
		}
	}
	/** Cancel the run in progress so its wait for the Agent settles during teardown. */
	stopActiveRun() {
		const active = this.active;
		if (active === void 0) return;
		active.abort.abort();
		const agent = active.agent;
		if (agent === void 0) return;
		this.cancelAgent(agent);
	}
	/**
	* Cancel the Agent of a run that teardown already aborted.
	*
	* The Agent exists only after Session creation finished, so teardown can have
	* run before this record owned one; the run then cancels the Agent itself.
	* @param active - Slot-holding run record.
	* @param agent - Agent the run just resolved.
	*/
	cancelIfAborted(active, agent) {
		if (!active.abort.signal.aborted) return;
		this.cancelAgent(agent);
	}
	/**
	* Cancel one sleep turn without letting a failure escape.
	* @param agent - Agent whose turn is cancelled.
	*/
	cancelAgent(agent) {
		try {
			agent.cancel({ kind: "disposed" });
		} catch (error) {
			this.ctx.logger.warn(`sleep: the sleep turn was not cancelled during unload: ${String(error)}`);
		}
	}
	/**
	* Wait for the run in progress, for a bounded time.
	*
	* The run is cancelled first, so this bound only ends a wait on work that
	* ignores its cancellation; unloading must not block on it forever.
	* @param run - The active run's settlement promise.
	* @returns Whether the run settled inside the bound.
	*/
	async settleActiveRun(run) {
		let settled = false;
		const settle = () => {
			settled = true;
		};
		let timer;
		try {
			await Promise.race([run.then(settle, settle), new Promise((resolve) => {
				timer = setTimeout(resolve, TEARDOWN_SETTLE_MS);
			})]);
		} finally {
			clearTimeout(timer);
		}
		return settled;
	}
	/** Disarm the pending timer. */
	clearTimer() {
		if (this.timer !== void 0) clearTimeout(this.timer);
		this.timer = void 0;
	}
	/**
	* Latest local date this runtime has already decided about.
	* @returns The later of the durable and the in-memory decision dates, or `null` when none is recorded.
	*/
	decidedDate() {
		const { lastScheduledDate } = this.current;
		const attempted = this.attemptedDate;
		if (attempted === null) return lastScheduledDate;
		if (lastScheduledDate === null) return attempted;
		return attempted > lastScheduledDate ? attempted : lastScheduledDate;
	}
	/** Arm the timer for the next due slot. */
	scheduleNext() {
		this.clearTimer();
		const slot = this.nextSlot();
		if (slot === null) return;
		this.timer = setTimeout(() => {
			this.timer = void 0;
			this.tick();
		}, slot.delayMs);
		this.timer.unref();
	}
	/**
	* Run one scheduled attempt and re-arm the timer whatever happened.
	*
	* The timer is armed from one clock reading and fires from another, so the
	* wall clock can move in either direction before the callback runs. The
	* attempt starts only when the schedule reports its slot due for the clock
	* reading taken here - the same answer `/sleep status` shows - and that one
	* reading also claims the date and starts the run, so a tick that crosses
	* midnight cannot claim the next day's slot. A timer that fires on a later date
	* before that date's slot, or before the armed instant, re-arms instead of
	* consuming the date early. `start` claims the local date before it can
	* refuse, so a refusal - such as a manual run that still holds the slot - waits
	* for tomorrow instead of re-arming the same slot at once.
	*/
	async tick() {
		try {
			const now = Date.now();
			if (this.nextSlot(now)?.delayMs !== 0) return;
			await this.start("scheduled", now).settled;
		} catch (error) {
			this.ctx.logger.warn(`sleep: the scheduled run did not start: ${String(error)}`);
		} finally {
			this.scheduleNext();
		}
	}
};
//#endregion
export { SleepRuntime as default };
