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
import { SessionId } from '@deepseek-ai/dsh-session';
import { ToolArgsError, ToolContextUnavailableError, defineTool } from '@deepseek-ai/dsh-tools';
import { assertNever } from '@deepseek-ai/dsh-util-values';
import { projectedPromptAt, resolveSessionActivityAt, resolveSessionPreset } from "./activity.js";
import { SleepError } from "./errors.js";
import { compareNotePaths, deleteNote, listNotes, moveNote, readNote, writeNote } from "./notes-fs.js";
import { sleepSessionQuery } from "./session-query.js";
/** Plugin name registered with the Loader. */
export const name = 'sleep-tools';
/** Host services these tools read. */
export const inject = ['tools', 'sessionQuery', 'sleep'];
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
const TRANSCRIPT_BLOCK_MAX_CHARS = 1_000;
/** Longest tool-call argument string a transcript line keeps. */
const TRANSCRIPT_ARGUMENTS_MAX_CHARS = 400;
/** Longest one transcript entry keeps, whatever blocks it joins. */
const TRANSCRIPT_ENTRY_MAX_CHARS = 4_000;
/** Most UTF-8 bytes one transcript page returns, so a fat entry cannot exhaust the request. */
const TRANSCRIPT_PAGE_MAX_BYTES = 40_000;
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
const DRAIN_SETTLE_MS = 5_000;
const SESSION_ROW_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'string', required: true },
        title: { type: 'string' },
        agentPreset: { type: 'string' },
        sleepSession: { type: 'boolean', required: true },
        created_at: { type: 'string', required: true },
        activity_at: { type: 'string', required: true },
        live: { type: 'boolean', required: true },
    },
};
const UNREADABLE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        total: { type: 'integer', required: true },
        sessions: { type: 'array', required: true, items: { type: 'string' } },
    },
};
const LIST_SESSIONS_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        since: { type: 'string' },
        before: { type: 'string' },
        before_id: { type: 'string' },
        total: { type: 'integer', required: true },
        shown: { type: 'integer', required: true },
        sessions: { type: 'array', required: true, items: SESSION_ROW_SCHEMA },
        unreadable: UNREADABLE_SCHEMA,
    },
};
const READ_SESSION_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        session_id: { type: 'string', required: true },
        title: { type: 'string' },
        created_at: { type: 'string', required: true },
        offset: { type: 'integer', required: true },
        total: { type: 'integer', required: true },
        shown: { type: 'integer', required: true },
        eof: { type: 'boolean', required: true },
        text: { type: 'string', required: true },
    },
};
const NOTE_ROW_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        path: { type: 'string', required: true },
        bytes: { type: 'integer', required: true },
        modified_at: { type: 'string', required: true },
    },
};
const NOTES_LIST_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        dir: { type: 'string', required: true },
        after: { type: 'string' },
        total: { type: 'integer', required: true },
        shown: { type: 'integer', required: true },
        files: { type: 'array', required: true, items: NOTE_ROW_SCHEMA },
    },
};
const NOTE_READ_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        path: { type: 'string', required: true },
        text: { type: 'string', required: true },
        offset: { type: 'integer', required: true },
        total: { type: 'integer', required: true },
        shown: { type: 'integer', required: true },
        eof: { type: 'boolean', required: true },
        truncated: { type: 'boolean', required: true },
    },
};
const NOTE_WRITE_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        path: { type: 'string', required: true },
        bytes: { type: 'integer', required: true },
        modified_at: { type: 'string' },
    },
};
const NOTE_MOVE_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        from: { type: 'string', required: true },
        path: { type: 'string', required: true },
        bytes: { type: 'integer', required: true },
        modified_at: { type: 'string', required: true },
        replaced: { type: 'boolean', required: true },
    },
};
const NOTE_DELETE_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        path: { type: 'string', required: true },
        kind: { type: 'string', required: true, enum: ['file', 'directory', 'link'] },
        removed_files: { type: 'integer', required: true },
        removed_bytes: { type: 'integer', required: true },
        removed_paths: { type: 'array', required: true, items: { type: 'string' } },
        omitted_paths: { type: 'integer', required: true },
    },
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
export function apply(ctx, options) {
    const drain = options.drain;
    // Registered before the tool registrations, so Cordis runs its async disposer
    // last: every registration is gone before the drain waits, and an execution
    // admitted before that removal settles before the fiber does.
    ctx.effect(() => async () => {
        if (await drain.close(DRAIN_SETTLE_MS))
            return;
        ctx.logger.warn(`sleep: a tool execution was still running ${DRAIN_SETTLE_MS} ms after the run released its tools`);
    }, 'sleep-tools.drain');
    // A sleep Session cannot act on the working workspace: whatever global tool
    // the Host layers above left visible is masked for this scope.
    ctx.tools.restrict({ allow: [] });
    ctx.tools.register(tracked(listSessionsTool(ctx), drain));
    ctx.tools.register(tracked(readSessionTool(ctx), drain));
    const root = ctx.sleep.config.dir;
    for (const tool of notesTools(root, ctx.sleep.config.maxSourceBytes)) {
        ctx.tools.register(tracked(tool, drain));
    }
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
            }
            finally {
                release();
            }
        },
    };
}
/**
 * Build the Session listing tool.
 * @param ctx - Host context carrying `sessionQuery` and the sleep service.
 * @returns The `sleep_list_sessions` definition.
 */
function listSessionsTool(ctx) {
    return defineTool({
        name: 'sleep_list_sessions',
        description: 'List Sessions that were active after the last completed sleep, most recent activity first. '
            + 'The current sleep Session is left out, and a Session that ran an earlier sleep is marked as one. '
            + 'A Session whose log cannot be read is named as unreadable instead of failing the list. '
            + 'To page into older Sessions, pass the oldest activity instant of the previous page as before and its Session id as before_id.',
        parameters: {
            since: {
                type: 'string',
                description: 'ISO 8601 instant with an explicit offset, such as 2026-11-22T03:00:00Z, that bounds the list from below; defaults to the last completed sleep, or all history before the first one.',
            },
            before: {
                type: 'string',
                description: 'ISO 8601 instant with an explicit offset that bounds the list from above. Pass the oldest activity instant of the previous page to page into older Sessions.',
            },
            before_id: {
                type: 'string',
                description: 'Session id of that oldest row. Pass it with before so Sessions whose activity equals that instant are not skipped.',
            },
            limit: {
                type: 'integer',
                description: `Maximum Sessions to return from 1 to ${LIST_LIMIT_MAX}; defaults to ${LIST_LIMIT_DEFAULT}.`,
            },
        },
        output: { schema: LIST_SESSIONS_OUTPUT, render: (_args, value) => text(renderSessionList(value)) },
        // Reading history starts no Session and changes no state.
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const caller = callerSession(exec);
            const limit = boundedInteger(args.limit, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, 'limit');
            const since = args.since === undefined
                ? ctx.sleep.state.lastSleepAt
                : instantArgument(args.since, 'since');
            const sinceMs = since === null ? null : Date.parse(since);
            const before = args.before === undefined ? null : instantArgument(args.before, 'before');
            const beforeMs = before === null ? null : Date.parse(before);
            const beforeId = args.before_id === undefined ? null : SessionId(args.before_id);
            if (beforeId !== null && before === null) {
                throw new ToolArgsError(['before_id requires before']);
            }
            const listing = await sessionsActiveBetween(ctx, await listSessionCorpus(ctx), caller, sinceMs, beforeMs, beforeId, exec.signal);
            const page = listing.active.slice(0, limit);
            const titles = await readTitles(ctx, page.map(entry => entry.record.header.id));
            const presetId = ctx.sleep.config.presetId;
            const sessions = page.map(entry => sessionRow(entry, titles.get(entry.record.header.id), presetId));
            return {
                ...since === null ? {} : { since },
                ...before === null ? {} : { before },
                ...beforeId === null ? {} : { before_id: beforeId },
                total: listing.active.length,
                shown: page.length,
                sessions,
                ...listing.unreadable.length === 0 ? {} : {
                    unreadable: {
                        total: listing.unreadable.length,
                        sessions: listing.unreadable.slice(0, UNREADABLE_IDS_LIMIT),
                    },
                },
            };
        },
        presentCall: () => callView('List sessions', 'read'),
        presentResult: (_args, result) => resultView('List sessions', result.isError),
    });
}
/**
 * Build the Session transcript tool.
 * @param ctx - Host context carrying `sessionQuery`.
 * @returns The `sleep_read_session` definition.
 */
function readSessionTool(ctx) {
    return defineTool({
        name: 'sleep_read_session',
        description: 'Read one Session transcript page by page: user and assistant messages, the tool calls they requested, '
            + 'and the tool results. System prompts and tool changes are left out.',
        parameters: {
            session_id: { type: 'string', required: true, description: 'Session id returned by sleep_list_sessions.' },
            offset: { type: 'integer', description: 'One-based number of the first transcript entry; defaults to 1.' },
            limit: {
                type: 'integer',
                description: `Maximum entries to return from 1 to ${TRANSCRIPT_LIMIT_MAX}; defaults to ${TRANSCRIPT_LIMIT_DEFAULT}.`,
            },
        },
        output: { schema: READ_SESSION_OUTPUT, render: (_args, value) => text(renderTranscript(value)) },
        // A history read starts no Session and changes no state.
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const sessionId = SessionId(args.session_id);
            const offset = positiveInteger(args.offset, 'offset', 'a positive entry number') ?? 1;
            const limit = boundedInteger(args.limit, TRANSCRIPT_LIMIT_DEFAULT, TRANSCRIPT_LIMIT_MAX, 'limit');
            const surface = await readSurface(ctx, sessionId);
            exec.signal.throwIfAborted();
            const start = offset - 1;
            const page = transcriptPage(surface.events, start, limit);
            const title = (await readTitles(ctx, [sessionId])).get(sessionId);
            return {
                session_id: sessionId,
                ...title === undefined ? {} : { title },
                created_at: instant(surface.session.createdAt),
                offset,
                total: page.total,
                shown: page.lines.length,
                eof: start + page.lines.length >= page.total,
                text: page.lines.join('\n'),
            };
        },
        presentCall: args => callView('Read session', 'read', args.session_id),
        presentResult: (_args, result) => resultView('Read session', result.isError),
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
            name: 'sleep_notes_list',
            description: 'List the sleep notes directory with the size and modification time of the notes it returns, in path order. '
                + 'To page into later notes, pass the last path of the previous page as after.',
            parameters: {
                after: {
                    type: 'string',
                    description: 'Only list notes whose path sorts after this one; pass the last path of the previous page.',
                },
                limit: {
                    type: 'integer',
                    description: `Maximum notes to return from 1 to ${NOTES_LIST_LIMIT_MAX}; defaults to ${NOTES_LIST_LIMIT_DEFAULT}.`,
                },
            },
            output: {
                schema: NOTES_LIST_OUTPUT,
                render: (_args, value) => text(renderNoteList(value)),
            },
            // Listing reads the directory and creates nothing.
            isConcurrencySafe: () => true,
            async execute(args) {
                const limit = boundedInteger(args.limit, NOTES_LIST_LIMIT_DEFAULT, NOTES_LIST_LIMIT_MAX, 'limit');
                const after = args.after;
                const notes = await listNotes(root);
                const candidates = after === undefined ? notes : notes.filter(note => compareNotePaths(note.path, after) > 0);
                const page = candidates.slice(0, limit);
                return {
                    dir: root,
                    ...after === undefined ? {} : { after },
                    total: candidates.length,
                    shown: page.length,
                    files: page.map(note => ({ path: note.path, bytes: note.bytes, modified_at: instant(note.mtimeMs) })),
                };
            },
            presentCall: () => callView('List sleep notes', 'read'),
            presentResult: (_args, result) => resultView('List sleep notes', result.isError),
        }),
        defineTool({
            name: 'sleep_notes_read',
            description: 'Read one sleep note, optionally one window of its lines.',
            parameters: {
                path: { type: 'string', required: true, description: 'Note path relative to the notes directory, or an absolute path inside it.' },
                offset: { type: 'integer', description: '1-based number of the first line to return; defaults to 1.' },
                limit: { type: 'integer', description: 'Maximum number of lines to return; defaults to the end of the note.' },
            },
            output: { schema: NOTE_READ_OUTPUT, render: (_args, value) => text(renderNote(value)) },
            // Reading a note creates and changes nothing.
            isConcurrencySafe: () => true,
            async execute(args) {
                const offset = positiveInteger(args.offset, 'offset', 'a positive line number');
                const limit = positiveInteger(args.limit, 'limit', 'a positive line count');
                const note = await readNote(root, args.path, {
                    ...offset === undefined ? {} : { offset },
                    ...limit === undefined ? {} : { limit },
                    maxBytes: maxSourceBytes,
                });
                return {
                    path: note.path,
                    text: note.text,
                    offset: note.offset,
                    total: note.total,
                    shown: note.shown,
                    eof: note.eof,
                    truncated: note.truncated,
                };
            },
            presentCall: args => callView('Read sleep note', 'read', args.path),
            presentResult: (_args, result) => resultView('Read sleep note', result.isError),
        }),
        defineTool({
            name: 'sleep_notes_write',
            description: `Create or replace one sleep note atomically. The whole content becomes the note; content above ${maxSourceBytes} bytes is refused.`,
            parameters: {
                path: { type: 'string', required: true, description: 'Note path relative to the notes directory, or an absolute path inside it.' },
                content: { type: 'string', required: true, description: 'Complete next content of the note.' },
            },
            output: {
                schema: NOTE_WRITE_OUTPUT,
                render: (_args, value) => text(`Wrote sleep note ${value.path} (${value.bytes} bytes)`),
            },
            async execute(args) {
                const note = await writeNote(root, args.path, args.content, { maxBytes: maxSourceBytes });
                return {
                    path: note.path,
                    bytes: note.bytes,
                    // The write lands before the time is read, so a write whose timestamp
                    // cannot be read still reports the bytes it put on disk.
                    ...note.mtimeMs === undefined ? {} : { modified_at: instant(note.mtimeMs) },
                };
            },
            presentCall: args => callView('Write sleep note', 'edit', args.path),
            presentResult: (_args, result) => resultView('Write sleep note', result.isError),
        }),
        defineTool({
            name: 'sleep_notes_move',
            description: 'Move or rename one sleep note, creating the directories of its new path. '
                + 'A symbolic link is moved as the link it is, so the note it names stays where it is; '
                + 'a relative link that would name another path from its new directory is refused. '
                + 'A note already at the new path is replaced, and the result says whether that happened.',
            parameters: {
                from: { type: 'string', required: true, description: 'Current note path.' },
                to: { type: 'string', required: true, description: 'New note path.' },
            },
            output: {
                schema: NOTE_MOVE_OUTPUT,
                render: (_args, value) => text(`Moved sleep note ${value.from} to ${value.path} (${value.bytes} bytes)`
                    + (value.replaced ? ', replacing the note already there' : '')),
            },
            async execute(args) {
                const note = await moveNote(root, args.from, args.to);
                return { from: args.from, path: note.path, bytes: note.bytes, modified_at: instant(note.mtimeMs), replaced: note.replaced };
            },
            presentCall: args => callView('Move sleep note', 'move', args.from),
            presentResult: (_args, result) => resultView('Move sleep note', result.isError),
        }),
        defineTool({
            name: 'sleep_notes_delete',
            description: 'Delete one sleep note or one directory of notes below it. '
                + 'A symbolic link is removed as the link it is, so the note it names stays, '
                + 'and a link inside a deleted directory is not reported among the removed notes. '
                + 'The result reports the note files and bytes removed with it.',
            parameters: {
                path: { type: 'string', required: true, description: 'Note or directory path relative to the notes directory.' },
            },
            output: {
                schema: NOTE_DELETE_OUTPUT,
                render: (_args, value) => text(renderDeletion(value)),
            },
            async execute(args) {
                const deleted = await deleteNote(root, args.path);
                return {
                    path: deleted.path,
                    kind: deleted.kind,
                    removed_files: deleted.removedFiles,
                    removed_bytes: deleted.removedBytes,
                    removed_paths: [...deleted.removedPaths],
                    omitted_paths: deleted.omittedPaths,
                };
            },
            presentCall: args => callView('Delete sleep note', 'delete', args.path),
            presentResult: (_args, result) => resultView('Delete sleep note', result.isError),
        }),
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
    if (agent === undefined) {
        throw new ToolContextUnavailableError('sleep tools require an Agent-bound caller to identify the current Session');
    }
    return agent.session.id;
}
/**
 * List the logical Session corpus.
 * @param ctx - Host context carrying `sessionQuery`.
 * @returns Every Session record the corpus reports.
 * @throws SleepError with code `SLEEP_SESSION_QUERY_FAILED` when the corpus cannot be listed.
 */
async function listSessionCorpus(ctx) {
    return await sleepSessionQuery(ctx, 'listSessions', () => ctx.sessionQuery.listSessions());
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
        if (record.header.id === caller)
            continue;
        if (beforeMs !== null && beforeCouldHold(ctx, record, beforeMs))
            continue;
        // A cancelled turn stops reading the corpus instead of finishing a scan whose
        // answer the model will never receive.
        signal.throwIfAborted();
        try {
            // Sorting and the `before` cursor use this instant, so the listing asks for
            // the exact latest activity instead of a projected prompt that can understate it.
            const activityAt = await resolveSessionActivityAt(ctx, record, {
                ...sinceMs === null ? {} : { after: sinceMs },
                exact: true,
            });
            if (sinceMs !== null && activityAt <= sinceMs)
                continue;
            if (beforeMs !== null && !olderThanCursor(record.header.id, activityAt, beforeMs, beforeId))
                continue;
            // The marker and the reported preset come from one answer: the preset the
            // Session runs, or last ran, under. Reporting the creation header while the
            // marker followed a later switch would contradict itself.
            active.push({ record, activityAt, agentPreset: await resolveSessionPreset(ctx, record) });
        }
        catch (error) {
            if (!isUnreadableHistory(error))
                throw error;
            unreadable.push(record.header.id);
        }
    }
    return {
        active: active.sort((left, right) => right.activityAt - left.activityAt
            || compareSessionIds(left.record.header.id, right.record.header.id)),
        unreadable,
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
    return error instanceof SleepError && error.code === 'SLEEP_SESSION_QUERY_FAILED';
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
    if (left === right)
        return 0;
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
    if (activityAt < beforeMs)
        return true;
    if (activityAt > beforeMs)
        return false;
    // Equal instants sort by id, so only the ids after the cursor row remain.
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
        ...title === undefined ? {} : { title },
        ...entry.agentPreset === undefined ? {} : { agentPreset: entry.agentPreset },
        sleepSession: entry.agentPreset === presetId,
        created_at: instant(header.createdAt),
        activity_at: instant(entry.activityAt),
        live: entry.record.live,
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
    const titles = new Map();
    if (sessionIds.length === 0)
        return titles;
    const observations = await sleepSessionQuery(ctx, 'readTitleSnapshots', () => ctx.sessionQuery.readTitleSnapshots(sessionIds));
    for (const observation of observations) {
        if (observation.status !== 'fulfilled')
            continue;
        const title = observation.value.title?.title;
        if (title !== undefined)
            titles.set(observation.sessionId, title);
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
    return await sleepSessionQuery(ctx, 'readSurface', () => ctx.sessionQuery.readSurface(sessionId));
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
        if (!hasTranscriptContent(event))
            continue;
        const position = total;
        total += 1;
        if (full || position < start || lines.length >= limit)
            continue;
        const clippedLine = clipped(transcriptLine(event), TRANSCRIPT_ENTRY_MAX_CHARS);
        const cost = Buffer.byteLength(clippedLine, 'utf8') + (lines.length === 0 ? 0 : 1);
        if (lines.length > 0 && bytes + cost > TRANSCRIPT_PAGE_MAX_BYTES) {
            // A page is contiguous: once one entry does not fit, later ones wait for
            // the next call even when they are shorter.
            full = true;
            continue;
        }
        lines.push(clippedLine);
        bytes += cost;
    }
    return { lines, total };
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
        case 'user/message':
            return hasReadableContent(event.data.content);
        case 'assistant/message':
            return hasReadableContent(event.data.message.content);
        case 'tool/result':
            return hasReadableContent(event.data.message.content);
        case 'system/message':
        case 'developer/message':
            return false;
        /* v8 ignore next 2 -- the surface union is closed, so every member returns above */
        default:
            return assertNever(event, 'surface event');
    }
}
/**
 * Whether message content renders as text.
 * @param content - Message content blocks.
 * @returns `true` when at least one block contributes visible text.
 */
function hasReadableContent(content) {
    return content.some(block => block.type === 'tool-call' || (block.type === 'text' && block.text.trim() !== ''));
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
        case 'user/message':
            return labelledLine(event.seq, 'user', event.data.content);
        case 'assistant/message':
            return labelledLine(event.seq, 'assistant', event.data.message.content);
        case 'tool/result':
            return labelledLine(event.seq, event.data.message.isError === true ? 'tool error' : 'tool result', event.data.message.content);
        /* v8 ignore next 2 -- hasTranscriptContent admits only the three message kinds */
        default:
            return assertNever(event, 'transcript entry');
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
    for (const block of content) {
        if (block.type === 'text') {
            parts.push(clipped(block.text, TRANSCRIPT_BLOCK_MAX_CHARS));
        }
        else if (block.type === 'tool-call') {
            parts.push(`${block.name}(${clipped(block.arguments, TRANSCRIPT_ARGUMENTS_MAX_CHARS)})`);
        }
    }
    return parts.join(' ').trim();
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
    if (match === null) {
        throw new ToolArgsError([`${field} must be an ISO 8601 instant with an explicit offset, such as 2026-11-22T03:00:00Z`]);
    }
    const [, year = '0', month = '0', day = '0', hour = '0', minute = '0', second = '00', offsetHour, offsetMinute] = match;
    const offsetValid = offsetHour === undefined
        || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59);
    if (!offsetValid || !isRealCalendarTime(year, month, day, hour, minute, second)) {
        throw new ToolArgsError([`${field} must name a real calendar date, clock time, and offset`]);
    }
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
    // `Date.UTC` reads a year below 100 as 1900 + the year, so it cannot check the
    // first hundred years of ISO 8601; setting the full year keeps the supplied
    // value while still normalizing a day, month, or clock time out of range.
    const instant = new Date(0);
    instant.setUTCFullYear(yearNumber, monthNumber - 1, dayNumber);
    instant.setUTCHours(hourNumber, minuteNumber, secondNumber, 0);
    return yearNumber === instant.getUTCFullYear()
        && monthNumber === instant.getUTCMonth() + 1
        && dayNumber === instant.getUTCDate()
        && hourNumber === instant.getUTCHours()
        && minuteNumber === instant.getUTCMinutes()
        && secondNumber === instant.getUTCSeconds();
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
    if (value === undefined)
        return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new ToolArgsError([`${field} must be an integer from 1 to ${maximum}`]);
    }
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
    if (value === undefined)
        return undefined;
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new ToolArgsError([`${field} must be ${requirement}`]);
    }
    return value;
}
/**
 * Wrap one line of text as tool content.
 * @param value - Rendered text.
 * @returns One text content block.
 */
function text(value) {
    return [{ type: 'text', text: value }];
}
/**
 * Describe the pending state of one sleep tool call.
 * @param title - Card title for this call.
 * @param kind - Category the call belongs to.
 * @param rawInput - Salient argument shown in an expanded view.
 * @returns The generic call card.
 */
function callView(title, kind, rawInput) {
    return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } };
}
/**
 * Describe the completed state of one sleep tool call.
 * @param title - Card title carried over from the pending state.
 * @param failed - Whether the call failed.
 * @returns The generic result card.
 */
function resultView(title, failed) {
    return { card: 'generic', title: failed ? `${title} failed` : title };
}
/**
 * Render a Session listing.
 * @param value - Resolved listing.
 * @returns One header line, one line per Session, the Sessions it could not
 * read, and the cursor of the next page.
 */
function renderSessionList(value) {
    const bounds = [
        ...value.since === undefined ? [] : [`since ${value.since}`],
        ...value.before === undefined ? [] : [`before ${value.before}`],
    ];
    const scope = bounds.length === 0 ? 'all history' : `activity ${bounds.join(' and ')}`;
    const header = `${value.shown} of ${value.total} Sessions, ${scope}`;
    const rows = value.sessions.map(sessionRowLine);
    const unreadable = value.unreadable === undefined ? [] : [unreadableLine(value.unreadable)];
    const last = value.sessions.at(-1);
    // The id completes the cursor: Sessions that share the last activity instant
    // would be skipped by the instant alone.
    const cursor = last !== undefined && value.shown < value.total
        ? [`continue with before ${last.activity_at} and before_id ${last.id}`]
        : [];
    return [header, ...rows, ...unreadable, ...cursor].join('\n');
}
/**
 * Render one listed Session.
 * @param row - Session row the tool reports.
 * @returns The rendered line for that Session.
 */
function sessionRowLine(row) {
    const title = row.title === undefined ? '' : ` ${JSON.stringify(row.title)}`;
    const preset = row.agentPreset === undefined ? '' : `, preset ${row.agentPreset}`;
    const earlierSleep = row.sleepSession ? ', earlier sleep' : '';
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
    const subject = unreadable.total === 1 ? 'Session' : 'Sessions';
    const verb = unreadable.total === 1 ? 'was' : 'were';
    return `${unreadable.total} ${subject} could not be read and ${verb} left out: `
        + `${unreadable.sessions.join(', ')}${omitted === 0 ? '' : `, and ${omitted} more`}`;
}
/**
 * Render one Session transcript page.
 * @param value - Resolved transcript page.
 * @returns One header line and the page text.
 */
function renderTranscript(value) {
    const title = value.title === undefined ? '' : ` ${JSON.stringify(value.title)}`;
    const head = `${value.session_id}${title} · created ${value.created_at}`;
    if (value.total === 0)
        return `${head} · no transcript entries`;
    if (value.shown === 0) {
        return `${head} · no entries from offset ${value.offset} of ${value.total}`;
    }
    const last = value.offset + value.shown - 1;
    const next = value.eof ? '' : `\ncontinue with offset ${last + 1}`;
    return `${head} · entries ${value.offset}-${last} of ${value.total}\n${value.text}${next}`;
}
/**
 * Render one note listing.
 * @param value - Resolved note listing.
 * @returns The header, one line per note, and the cursor of the next page.
 */
function renderNoteList(value) {
    const scope = value.after === undefined ? '' : ` after ${value.after}`;
    const counted = value.shown === value.total ? `${value.total}` : `${value.shown} of ${value.total}`;
    const lines = [
        `Sleep notes in ${value.dir}${scope} (${counted})`,
        ...value.files.map(note => `- ${note.path} (${note.bytes} bytes, modified ${note.modified_at})`),
    ];
    const last = value.files.at(-1);
    if (last !== undefined && value.shown < value.total)
        lines.push(`continue after ${last.path}`);
    return lines.join('\n');
}
/**
 * Render one deletion with the notes it removed.
 * @param value - Resolved deletion.
 * @returns One header line and the removed note paths that are listed.
 */
function renderDeletion(value) {
    // A removed link leaves the note it named in place, so the result says that
    // instead of reporting the note files of a directory.
    if (value.kind === 'link')
        return `Removed the symbolic link ${value.path}; the note it names stays`;
    const files = `${value.removed_files} ${value.removed_files === 1 ? 'file' : 'files'}`;
    const head = `Deleted sleep ${value.kind} ${value.path} (${files}, ${value.removed_bytes} bytes)`;
    if (value.kind === 'file')
        return head;
    const lines = [head, ...value.removed_paths.map(path => `- ${path}`)];
    if (value.omitted_paths > 0)
        lines.push(`- and ${value.omitted_paths} more notes`);
    return lines.join('\n');
}
/**
 * Render one note read.
 * @param value - Resolved note window.
 * @returns One header line and the note text.
 */
function renderNote(value) {
    // A note cut at the read byte limit holds only part of its text, so the read
    // says that even when the window holds no line: the file continues past it.
    const cut = value.truncated ? ' · cut at the read byte limit' : '';
    if (value.total === 0) {
        return value.truncated
            ? `${value.path} · no lines loaded before the read byte limit`
            : `${value.path} · empty note`;
    }
    if (value.shown === 0)
        return `${value.path} · no lines from offset ${value.offset} of ${value.total}${cut}`;
    const last = value.offset + value.shown - 1;
    // A note cut at the read byte limit keeps the lines it did load, so a page of
    // them still continues by offset; the marker states why the note ends there.
    const next = value.offset - 1 + value.shown < value.total ? `\ncontinue with offset ${last + 1}` : '';
    return `${value.path} · lines ${value.offset}-${last} of ${value.total}${cut}\n${value.text}${next}`;
}
//# sourceMappingURL=tools.js.map