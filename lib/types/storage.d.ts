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
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { z } from 'zod';
/** What started one sleep run. */
export type SleepTrigger = 'scheduled' | 'manual';
/** How one sleep attempt ended. */
export type SleepOutcomeStatus = 'completed' | 'skipped' | 'failed';
/**
 * Durable account of the last sleep attempt.
 *
 * `at` is the instant the attempt started, so an outcome reads together with
 * the {@link SleepState.lastSleepAt} it either advanced or left alone.
 */
export interface SleepOutcome {
    /** ISO-8601 instant the attempt started. */
    readonly at: string;
    /** What started the attempt. */
    readonly trigger: SleepTrigger;
    /** How the attempt ended. */
    readonly status: SleepOutcomeStatus;
    /** Session the attempt drove, when it got as far as creating one. */
    readonly sessionId?: SessionId;
    /** Why a run was skipped or failed; absent for a completed run. */
    readonly reason?: string;
}
/**
 * Everything the sleep plugin remembers between runs.
 *
 * `lastSleepAt` is the lower bound the next run reflects on, so it advances
 * only after a completed run. `lastScheduledDate` records the last scheduled
 * decision, whether it ran, skipped, or failed, so one local day yields at most
 * one scheduled attempt. The Session of a completed run is read back from
 * `lastOutcome`, so no second copy is stored.
 */
export interface SleepState {
    /** ISO-8601 instant of the last completed run, or `null` before the first completion. */
    readonly lastSleepAt: string | null;
    /** Local `YYYY-MM-DD` date of the last scheduled decision, or `null` before the first one. */
    readonly lastScheduledDate: string | null;
    /** How the last attempt ended, or `null` before the first attempt. */
    readonly lastOutcome: SleepOutcome | null;
}
/** Durable record of the sleep domain's global slot. */
export declare const sleepStateSchema: z.ZodObject<{
    lastSleepAt: z.ZodNullable<z.ZodISODateTime>;
    lastScheduledDate: z.ZodNullable<z.ZodISODate>;
    lastOutcome: z.ZodNullable<z.ZodObject<{
        at: z.ZodISODateTime;
        trigger: z.ZodEnum<{
            scheduled: "scheduled";
            manual: "manual";
        }>;
        status: z.ZodEnum<{
            completed: "completed";
            skipped: "skipped";
            failed: "failed";
        }>;
        sessionId: z.ZodExactOptional<z.ZodPipe<z.ZodString, z.ZodTransform<SessionId, string>>>;
        reason: z.ZodExactOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** State served before the first write, when no run has happened yet. */
export declare const EMPTY_SLEEP_STATE: SleepState;
/**
 * The sleep domain: one global record and no tables.
 *
 * Version 1 is the first generation, so it declares no compatible versions.
 */
export declare const sleepDomain: {
    name: string;
    version: number;
    global: {
        schema: z.ZodObject<{
            lastSleepAt: z.ZodNullable<z.ZodISODateTime>;
            lastScheduledDate: z.ZodNullable<z.ZodISODate>;
            lastOutcome: z.ZodNullable<z.ZodObject<{
                at: z.ZodISODateTime;
                trigger: z.ZodEnum<{
                    scheduled: "scheduled";
                    manual: "manual";
                }>;
                status: z.ZodEnum<{
                    completed: "completed";
                    skipped: "skipped";
                    failed: "failed";
                }>;
                sessionId: z.ZodExactOptional<z.ZodPipe<z.ZodString, z.ZodTransform<SessionId, string>>>;
                reason: z.ZodExactOptional<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        initial: SleepState;
    };
    tables: {};
};
/** Open handle on the durable sleep state. */
export interface SleepStore {
    /** Current state; the spec's initial value until the first save lands. */
    readonly state: SleepState;
    /**
     * Replace the state durably. Resolves after the medium and the in-memory
     * value are both updated, so a rejection leaves the previous state readable.
     * @param next - Complete next state.
     * @returns Resolution after durability.
     */
    save(next: SleepState): Promise<void>;
    /**
     * Close the domain and release its backend unit.
     * @returns Resolution after teardown.
     */
    close(): Promise<void>;
}
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
export declare function openSleepStore(ctx: Context): Promise<SleepStore>;
//# sourceMappingURL=storage.d.ts.map