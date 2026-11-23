/**
 * Failure vocabulary of the sleep plugin.
 *
 * Each failure is a {@link HarnessError} with a stable code, so command results,
 * tool failures, and runtime reports route on the code instead of the message
 * text.
 * @module @deepseek-ai/dsh-sleep/errors
 */
import { HarnessError } from '@deepseek-ai/dsh-error';
/**
 * Stable failure classes the sleep plugin reports.
 *
 * `SLEEP_CONFIG_INVALID` covers the plugin row and every resolved value;
 * `SLEEP_PATH_UNSAFE` covers a note path that leaves the configured directory;
 * `SLEEP_NOTE_UNAVAILABLE` covers a note the filesystem or its content refuses;
 * `SLEEP_RUN_IN_PROGRESS` covers a second concurrent run;
 * `SLEEP_RUNTIME_STOPPING` covers a run requested after teardown began;
 * `SLEEP_STORE_UNAVAILABLE` covers durable state that could not be opened; and
 * the remaining two name the missing service or the unreadable Session history.
 */
export type SleepErrorCode = 'SLEEP_CONFIG_INVALID' | 'SLEEP_PATH_UNSAFE' | 'SLEEP_NOTE_UNAVAILABLE' | 'SLEEP_RUN_IN_PROGRESS' | 'SLEEP_RUNTIME_STOPPING' | 'SLEEP_STORE_UNAVAILABLE' | 'SLEEP_PRESETS_UNAVAILABLE' | 'SLEEP_SESSION_QUERY_FAILED';
/** Coded failure raised by the sleep plugin. */
export declare class SleepError extends HarnessError {
    /** Stable machine-routable failure class. */
    readonly code: SleepErrorCode;
    /**
     * @param message - Diagnostic naming the failed operation and the rejected value.
     * @param code - Stable machine-routable failure class.
     * @param options - Standard error options carrying the underlying cause.
     */
    constructor(message: string, code: SleepErrorCode, options?: ErrorOptions);
}
/**
 * Report one configuration value that violates the plugin contract.
 * @param field - Configuration field name as it appears in `cordis.yml` or `cordis.patch.yml`.
 * @param detail - What the rejected value fails to satisfy.
 * @returns The coded configuration failure.
 */
export declare function invalidConfigError(field: string, detail: string): SleepError;
/**
 * Report one note path that does not stay inside the configured sleep directory.
 * @param path - Caller-supplied path exactly as received.
 * @param detail - Why the path is refused, such as the resolved target outside the root.
 * @returns The coded path-confinement failure.
 */
export declare function unsafePathError(path: string, detail: string): SleepError;
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
export declare function noteUnavailableError(path: string, detail: string, options?: ErrorOptions): SleepError;
/**
 * Report a sleep run requested while another run is still active.
 *
 * The message carries the wait the caller can act on, so the command reports
 * this text as it stands.
 * @param sessionId - Session that owns the active run, or `null` while that run has not created one yet.
 * @returns The coded concurrency failure.
 */
export declare function runInProgressError(sessionId: string | null): SleepError;
/**
 * Report a run requested after the runtime began to unload.
 *
 * The store and the timer are already closing, so a run accepted here would
 * outlive the composition that owns it.
 * @returns The coded stopping failure.
 */
export declare function runtimeStoppingError(): SleepError;
/**
 * Report durable sleep state that could not be opened.
 *
 * The notes injection and the command's status read no store, so the runtime
 * keeps serving them; every attempt that would read the saved state or record
 * its outcome is refused instead, and the next attempt opens the domain again.
 * @param cause - Failure the store open reported.
 * @returns The coded store failure.
 */
export declare function storeUnavailableError(cause: unknown): SleepError;
/**
 * Report that the sleep preset cannot be mounted because no preset service is available.
 * @returns The coded missing-service failure.
 */
export declare function presetsUnavailableError(): SleepError;
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
export declare function presetBrokenError(presetId: string, diagnostic: string): SleepError;
/**
 * Report Session history that could not be read for a sleep run.
 * @param operation - `SessionQuery` operation that failed.
 * @param cause - Underlying failure kept for diagnosis.
 * @returns The coded Session-history failure.
 */
export declare function sessionQueryError(operation: string, cause: unknown): SleepError;
//# sourceMappingURL=errors.d.ts.map