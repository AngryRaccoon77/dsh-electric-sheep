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
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionHeader } from '@deepseek-ai/dsh-session';
import type { SessionRecord } from '@deepseek-ai/dsh-session-query';
/** Options that decide which activity instant a caller needs. */
export interface SessionActivityOptions {
    /**
     * Exclusive activity lower bound the caller asks about, in epoch milliseconds.
     *
     * A projected prompt instant above this bound proves the Session was active
     * after it. At or below the bound the projection cannot answer, so the durable
     * log does; with no bound, the stored instant is reported as the cache holds
     * it.
     */
    readonly after?: number;
    /**
     * Whether the caller needs the exact latest activity instant.
     *
     * The Session-list projection records the last human prompt, which is a lower
     * bound of the latest activity: the assistant reply and the turn end that
     * followed it are newer. A caller that sorts, pages, or reports one instant
     * therefore asks for the exact answer and pays one log read per Session; a
     * membership test is answered by a projection instant that proves its bound.
     */
    readonly exact?: boolean;
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
export declare function isSleepSessionRecord(ctx: Context, record: SessionRecord, presetId: string): Promise<boolean>;
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
export declare function resolveSessionPreset(ctx: Context, record: SessionRecord): Promise<string | undefined>;
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
export declare function isSleepSessionHeader(header: SessionHeader, presetId: string): boolean;
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
export declare function isSleepAgent(ctx: Context, agent: Agent, presetId: string): boolean;
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
export declare function projectedPromptAt(ctx: Context, record: SessionRecord): number | null;
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
export declare function resolveSessionActivityAt(ctx: Context, record: SessionRecord, options?: SessionActivityOptions): Promise<number>;
//# sourceMappingURL=activity.d.ts.map