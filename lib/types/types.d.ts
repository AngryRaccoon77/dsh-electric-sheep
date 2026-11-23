/**
 * Type-only surface of the sleep plugin.
 *
 * The sleep tools, the memory injector, and the `/sleep` command read the
 * Host runtime through one service: `ctx.sleep`. The runtime class that
 * provides it is the package entry; this module declares only what those
 * consumers see, so it holds no runtime code.
 * @module @deepseek-ai/dsh-sleep/types
 */
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { ResolvedConfig } from './config.ts';
import type { SleepOutcome, SleepState } from './storage.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        sleep: SleepService;
    }
}
/**
 * What one sleep attempt did.
 *
 * A run that started always reports here, including a run the model failed;
 * only a refusal to start at all rejects {@link SleepService.runNow}. The
 * durable outcome and the reported result describe the same attempt, so the
 * result extends it with the Session the attempt drove and the counted working
 * Sessions.
 */
export interface SleepRunResult extends Omit<SleepOutcome, 'sessionId'> {
    /** Session the attempt drove, or `null` when no Session was created. */
    readonly sessionId: SessionId | null;
    /** Working Sessions with activity newer than the last completed sleep, when the attempt counted them. */
    readonly workingSessions?: number;
}
/**
 * Scheduled slot the daily timer waits for.
 *
 * The timer and `/sleep status` read the same answer, so a date this process
 * already decided about moves both.
 */
export interface SleepNextSlot {
    /** Instant the slot fires, in epoch milliseconds. */
    readonly at: number;
    /** Delay from the caller's clock reading to {@link SleepNextSlot.at}; `0` means the slot is due now. */
    readonly delayMs: number;
}
/**
 * One manual run, handed to its caller before it finishes.
 *
 * A sleep run outlives the surface that started it: the composer that ran
 * `/sleep` must answer at once, while the run keeps the runtime's single slot
 * until it records its outcome.
 */
export interface SleepStart {
    /**
     * Resolves once the run owns a Session.
     *
     * The answer is `null` when the attempt ended before creating one, which
     * means {@link SleepStart.settled} already holds the outcome.
     */
    readonly started: Promise<SessionId | null>;
    /** The attempt's result, resolved when the run ends. */
    readonly settled: Promise<SleepRunResult>;
}
/**
 * What the sleep plugin publishes as `ctx.sleep`.
 *
 * `config` is fixed for the life of the mounted plugin; `state` changes with
 * every run and outcome, so a consumer reads it per call.
 */
export interface SleepService {
    /** Resolved plugin configuration. */
    readonly config: ResolvedConfig;
    /** Current durable lifecycle facts, as last committed. */
    readonly state: SleepState;
    /** Why the durable state is unavailable, or `null` while it is readable. */
    readonly stateError: string | null;
    /** Session of the run in progress, or `null` when no run is active. */
    readonly activeSessionId: SessionId | null;
    /** Whether a run holds the runtime's slot, including before that run created its Session. */
    readonly activeRun: boolean;
    /**
     * Read the slot the daily timer waits for.
     * @param nowMs - Current instant in epoch milliseconds; defaults to the clock reading.
     * @returns The armed slot, or `null` when scheduled runs are off.
     */
    nextSlot(nowMs?: number): SleepNextSlot | null;
    /**
     * Start one manual run now and hand back its start and completion.
     *
     * A manual run ignores `enabled` and `minSessions`: the caller asked for it.
     * The schedule slots belong to the timer, which re-checks due-ness itself, so
     * this method cannot consume a slot that has not arrived.
     * @returns The run's start and its result.
     * @throws SleepError with code `SLEEP_RUN_IN_PROGRESS` while another run is active.
     * @throws SleepError with code `SLEEP_RUNTIME_STOPPING` after teardown began.
     */
    startNow(): SleepStart;
    /**
     * Start one manual run now and report how it ended.
     *
     * The caller waits for the whole run, which a command surface should not do;
     * `/sleep` reports through {@link SleepService.startNow} instead.
     * @returns The attempt's result.
     * @throws SleepError with code `SLEEP_RUN_IN_PROGRESS` while another run is active.
     * @throws SleepError with code `SLEEP_RUNTIME_STOPPING` after teardown began.
     */
    runNow(): Promise<SleepRunResult>;
}
//# sourceMappingURL=types.d.ts.map