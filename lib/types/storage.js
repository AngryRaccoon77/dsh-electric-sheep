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
import { SessionId } from '@deepseek-ai/dsh-session';
import { DomainError, defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
/** Canonical UTC instant with milliseconds, as `Date.prototype.toISOString` renders it. */
const instantSchema = z.iso.datetime({ precision: 3 });
/** Saved Session identity; the empty string is never a Session. */
const sessionIdSchema = z.string().min(1).transform(SessionId);
const outcomeSchema = z.object({
    at: instantSchema,
    trigger: z.enum(['scheduled', 'manual']),
    status: z.enum(['completed', 'skipped', 'failed']),
    sessionId: sessionIdSchema.exactOptional(),
    reason: z.string().min(1).exactOptional(),
}).strict();
/** Durable record of the sleep domain's global slot. */
export const sleepStateSchema = z.object({
    lastSleepAt: instantSchema.nullable(),
    lastScheduledDate: z.iso.date().nullable(),
    lastOutcome: outcomeSchema.nullable(),
}).strict();
/** State served before the first write, when no run has happened yet. */
export const EMPTY_SLEEP_STATE = Object.freeze({
    lastSleepAt: null,
    lastScheduledDate: null,
    lastOutcome: null,
});
/**
 * The sleep domain: one global record and no tables.
 *
 * Version 1 is the first generation, so it declares no compatible versions.
 */
export const sleepDomain = defineDomain({
    name: 'sleep',
    version: 1,
    global: { schema: sleepStateSchema, initial: EMPTY_SLEEP_STATE },
    tables: {},
});
/**
 * How long an open waits for a domain an unloaded runtime still holds.
 *
 * The abandoned run closes the store when it settles; the wait covers that
 * window, and a holder that never releases it fails the open as before. The
 * wait is measured on the monotonic clock, so a wall-clock adjustment cannot
 * move its end.
 */
const STORE_HANDOFF_WAIT_MS = 10_000;
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
export async function openSleepStore(ctx) {
    const domain = await openReleasedSleepDomain(ctx);
    return {
        get state() {
            return domain.global.get();
        },
        save: next => domain.global.set(next),
        close: () => domain.close(),
    };
}
/**
 * Open the sleep domain, waiting out a runtime that unloaded but still holds it.
 * @param ctx - Host context carrying `storageDomain`.
 * @returns The opened domain.
 * @throws DomainError when the domain does not become available inside the wait.
 */
async function openReleasedSleepDomain(ctx) {
    // The deadline reads the monotonic clock: a wall-clock adjustment during the
    // wait must not extend it, because that would hold plugin activation past the
    // bound instead of failing the open.
    const deadline = performance.now() + STORE_HANDOFF_WAIT_MS;
    for (;;) {
        try {
            return await ctx.storageDomain.open(sleepDomain);
        }
        catch (error) {
            if (!(error instanceof DomainError) || error.code !== 'already-open' || performance.now() >= deadline)
                throw error;
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, STORE_HANDOFF_POLL_MS);
                timer.unref();
            });
        }
    }
}
//# sourceMappingURL=storage.js.map