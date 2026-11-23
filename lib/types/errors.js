/**
 * Failure vocabulary of the sleep plugin.
 *
 * Each failure is a {@link HarnessError} with a stable code, so command results,
 * tool failures, and runtime reports route on the code instead of the message
 * text.
 * @module @deepseek-ai/dsh-sleep/errors
 */
import { HarnessError } from '@deepseek-ai/dsh-error';
/** Coded failure raised by the sleep plugin. */
export class SleepError extends HarnessError {
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
}
/**
 * Report one configuration value that violates the plugin contract.
 * @param field - Configuration field name as it appears in `cordis.yml` or `cordis.patch.yml`.
 * @param detail - What the rejected value fails to satisfy.
 * @returns The coded configuration failure.
 */
export function invalidConfigError(field, detail) {
    return new SleepError(`sleep config ${field}: ${detail}`, 'SLEEP_CONFIG_INVALID');
}
/**
 * Report one note path that does not stay inside the configured sleep directory.
 * @param path - Caller-supplied path exactly as received.
 * @param detail - Why the path is refused, such as the resolved target outside the root.
 * @returns The coded path-confinement failure.
 */
export function unsafePathError(path, detail) {
    return new SleepError(`sleep note path ${JSON.stringify(path)}: ${detail}`, 'SLEEP_PATH_UNSAFE');
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
export function noteUnavailableError(path, detail, options) {
    return new SleepError(`sleep note ${JSON.stringify(path)}: ${detail}`, 'SLEEP_NOTE_UNAVAILABLE', options);
}
/**
 * Report a sleep run requested while another run is still active.
 *
 * The message carries the wait the caller can act on, so the command reports
 * this text as it stands.
 * @param sessionId - Session that owns the active run, or `null` while that run has not created one yet.
 * @returns The coded concurrency failure.
 */
export function runInProgressError(sessionId) {
    return new SleepError(sessionId === null
        ? 'a sleep run is already active and has not created its Session yet; wait for it to finish'
        : `a sleep run is already active in Session ${sessionId}; wait for it to finish`, 'SLEEP_RUN_IN_PROGRESS');
}
/**
 * Report a run requested after the runtime began to unload.
 *
 * The store and the timer are already closing, so a run accepted here would
 * outlive the composition that owns it.
 * @returns The coded stopping failure.
 */
export function runtimeStoppingError() {
    return new SleepError('the sleep runtime is stopping', 'SLEEP_RUNTIME_STOPPING');
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
export function storeUnavailableError(cause) {
    return new SleepError('the durable sleep state could not be opened, so no sleep run can start; the next run retries it', 'SLEEP_STORE_UNAVAILABLE', { cause });
}
/**
 * Report that the sleep preset cannot be mounted because no preset service is available.
 * @returns The coded missing-service failure.
 */
export function presetsUnavailableError() {
    return new SleepError('the agent preset service is unavailable, so the sleep preset cannot be mounted', 'SLEEP_PRESETS_UNAVAILABLE');
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
export function presetBrokenError(presetId, diagnostic) {
    return new SleepError(`the sleep preset ${JSON.stringify(presetId)} failed to activate: ${diagnostic}`, 'SLEEP_PRESETS_UNAVAILABLE');
}
/**
 * Report Session history that could not be read for a sleep run.
 * @param operation - `SessionQuery` operation that failed.
 * @param cause - Underlying failure kept for diagnosis.
 * @returns The coded Session-history failure.
 */
export function sessionQueryError(operation, cause) {
    return new SleepError(`cannot read Session history through ${operation}`, 'SLEEP_SESSION_QUERY_FAILED', { cause });
}
//# sourceMappingURL=errors.js.map