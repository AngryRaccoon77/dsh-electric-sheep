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
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
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
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { sleepSessionQuery } from "./session-query.js";
/** Projection key that carries the persisted Session-list metadata. */
const LIST_METADATA_KEY = 'sessionListMetadata';
/** Projection key the preset registry records the preset a Session runs under. */
const PRESET_KEY = 'agentPreset';
/**
 * Event types whose timestamp counts as Session activity.
 *
 * A Session that was only created, renamed, or resumed has no such event and
 * keeps its creation instant as its activity.
 */
const ACTIVITY_EVENT_TYPES = new Set([
    'user/message',
    'assistant/message',
    'turn/end',
]);
/**
 * Whether a projected prompt instant answers the caller's question.
 * @param projected - Last prompt instant in epoch milliseconds.
 * @param options - Activity bound the caller asks about.
 * @returns `true` when the projection proves the requested activity.
 */
function provesActivity(projected, options) {
    return options.after === undefined || projected > options.after;
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
export async function isSleepSessionRecord(ctx, record, presetId) {
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
export async function resolveSessionPreset(ctx, record) {
    const live = ctx.get('sessions')?.get(record.header.id);
    if (live !== undefined) {
        const projected = ctx.get('sessionProjections')?.snapshot(live, [PRESET_KEY]).values[PRESET_KEY];
        return projected ?? record.header.agentPreset;
    }
    const cached = ctx.get('sessionProjectionCache')?.cachedSnapshot(record.header, [PRESET_KEY, LIST_METADATA_KEY]);
    const projected = cached?.values[PRESET_KEY];
    const metadata = cached?.values[LIST_METADATA_KEY];
    // `blank` becomes false when the log records its first turn start, and a
    // started Session cannot change its preset, so a checkpoint that recorded the
    // preset answers for the rest of the log without reading it. A checkpoint
    // that folded a turn start but holds no preset value proves nothing: the
    // projection can have been registered after the selection, and the creation
    // header would misreport a Session that switched before its first turn.
    if (metadata !== undefined && !metadata.blank && projected !== undefined && projected !== null)
        return projected;
    // The checkpoint cannot prove the current preset: a selection made before the
    // first turn is durable in the log before any checkpoint records it.
    const selected = await lastSelectedPreset(ctx, record.header.id);
    return selected ?? projected ?? record.header.agentPreset;
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
export function isSleepSessionHeader(header, presetId) {
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
export function isSleepAgent(ctx, agent, presetId) {
    const composed = ctx.get('agentPresets')?.composedPreset(agent.ctx);
    if (composed !== undefined)
        return composed === presetId;
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
export function projectedPromptAt(ctx, record) {
    // Read through `ctx.get`: a caller that only inspects history need not
    // declare the Session store, and an unreadable store leaves the answer to the
    // persisted cache or the event log.
    const live = ctx.get('sessions')?.get(record.header.id);
    const projections = ctx.get('sessionProjections');
    if (live !== undefined) {
        const projected = projections?.snapshot(live, [LIST_METADATA_KEY]).values[LIST_METADATA_KEY];
        return projected?.lastPromptAt === undefined || projected.lastPromptAt === null
            ? null
            : projected.lastPromptAt;
    }
    // A cold Session has no attached log to fold, so only the persisted cache
    // can answer without activating it.
    const cached = ctx.get('sessionProjectionCache')?.cachedSnapshot(record.header, [LIST_METADATA_KEY]);
    const lastPromptAt = cached?.values[LIST_METADATA_KEY]?.lastPromptAt;
    return lastPromptAt === undefined || lastPromptAt === null ? null : lastPromptAt;
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
export async function resolveSessionActivityAt(ctx, record, options = {}) {
    const projected = projectedPromptAt(ctx, record);
    if (options.exact !== true && projected !== null && provesActivity(projected, options))
        return projected;
    const eventAt = await lastActivityTime(ctx, record.header.id);
    if (eventAt !== null)
        return eventAt;
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
    const env_1 = { stack: [], error: void 0, hasError: false };
    try {
        const observation = __addDisposableResource(env_1, await sleepSessionQuery(ctx, 'observeSession', () => ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })), false);
        let selected;
        for (const event of observation.events) {
            if (event.type === 'agent-preset/selected')
                selected = event.data.agentPreset;
        }
        return selected;
    }
    catch (e_1) {
        env_1.error = e_1;
        env_1.hasError = true;
    }
    finally {
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
    const env_2 = { stack: [], error: void 0, hasError: false };
    try {
        const observation = __addDisposableResource(env_2, await sleepSessionQuery(ctx, 'observeSession', () => ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })), false);
        let latest = null;
        for (const event of observation.events) {
            if (!ACTIVITY_EVENT_TYPES.has(event.type))
                continue;
            if (latest === null || event.time > latest)
                latest = event.time;
        }
        return latest;
    }
    catch (e_2) {
        env_2.error = e_2;
        env_2.hasError = true;
    }
    finally {
        __disposeResources(env_2);
    }
}
//# sourceMappingURL=activity.js.map