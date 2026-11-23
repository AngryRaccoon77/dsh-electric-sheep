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
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { Config } from './config.ts';
import type { ResolvedConfig } from './config.ts';
import type { SleepState, SleepTrigger } from './storage.ts';
import type { SleepNextSlot, SleepRunResult, SleepService, SleepStart } from './types.ts';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /**
         * The one prompt that opens a sleep Session: the trigger, the run instants,
         * and the tool roster travel in the text. Readers replay the prompt without
         * this producer; no durable decision depends on the kind.
         * @persistenceAttribution
         */
        'sleep': {
            kind: 'sleep';
            /** What started the run the message belongs to. */
            trigger: SleepTrigger;
        } & ContextFormed;
    }
}
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
export default class SleepRuntime extends Service implements SleepService {
    /** Host services this plugin cannot run without. */
    static inject: string[];
    /** Loader-validated plugin configuration. */
    static Config: z<Config>;
    /** Resolved plugin configuration every run reads. */
    readonly config: ResolvedConfig;
    /**
     * Durable state handle.
     *
     * Entry opens it, and an attempt that finds it missing opens it again, so a
     * store that was unavailable at activation is retried instead of disabling the
     * plugin for the life of the process.
     */
    private store;
    /** Failure the last store open reported, or `undefined` while the store is readable. */
    private storeFailure;
    /** Last committed state; updated only after a write lands. */
    private current;
    /** Entry-point completion; the runtime is usable once this settles. */
    private readonly initialized;
    /** Pending timer, or `undefined` while disarmed. */
    private timer;
    /** The run that holds this runtime's single slot. */
    private active;
    /** Local date this process already decided about, so a failed state write cannot repeat the day. */
    private attemptedDate;
    /** Set once teardown begins: no new timer and no new run. */
    private stopping;
    /**
     * @param ctx - Host context that owns storage, Sessions, and Agents.
     * @param config - Loader-validated plugin row.
     */
    constructor(ctx: Context, config: Config);
    /**
     * Load the durable state, then install the surfaces that serve working Sessions.
     *
     * The notes injector and the instruction guard read the notes directory and
     * the Session, never the store, so they are installed before it opens: a store
     * that cannot open must not disable the notes a working Session depends on.
     * `/sleep` is different - it starts a run that records its outcome - so it
     * appears only after the entry point settled.
     */
    [Service.init](): Promise<void>;
    /** Current durable lifecycle facts, as last committed. */
    get state(): SleepState;
    /** Why the durable state is unavailable, or `null` while it is readable. */
    get stateError(): string | null;
    /** Session of the run in progress, or `null` when no run is active. */
    get activeSessionId(): SessionId | null;
    /** Whether a run holds the runtime's slot, including before it created a Session. */
    get activeRun(): boolean;
    /**
     * Read the slot the daily timer waits for.
     *
     * The answer uses the same decision date as the timer, so a date this
     * process already claimed moves both.
     * @param nowMs - Current instant in epoch milliseconds; defaults to the clock reading.
     * @returns The armed slot, or `null` when scheduled runs are off.
     */
    nextSlot(nowMs?: number): SleepNextSlot | null;
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
    runNow(): Promise<SleepRunResult>;
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
    startNow(): SleepStart;
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
    private start;
    /**
     * Open the durable state.
     *
     * A failure is logged and kept instead of failing the activation: the notes
     * injection, the instruction guard, and `/sleep status` read no store, and an
     * attempt that needs it retries this open instead of refusing forever.
     */
    private openStore;
    /**
     * Read the open store, retrying a failed open once.
     * @returns The open durable state.
     * @throws SleepError with code `SLEEP_STORE_UNAVAILABLE` when the retry also fails.
     */
    private ensureStore;
    /**
     * Close the durable state this runtime holds.
     *
     * A store that never opened leaves nothing to close.
     */
    private closeStore;
    /**
     * Carry out one attempt and commit its outcome.
     * @param active - Slot-holding run record the attempt fills in.
     * @param trigger - What started the run.
     * @param startedAtMs - Clock reading the attempt started at; the one claim instant.
     * @returns The attempt's result.
     */
    private execute;
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
    private waitForPresets;
    /**
     * Read whether the registry can mount the configured preset.
     *
     * Only a preset that has not been registered yet is worth waiting for: a
     * preset whose composition failed to activate reports a diagnostic that no
     * later check can repair, and a preset the registry can mount is ready.
     * @param presets - Agent preset registry the run would mount from.
     * @returns What the registry answered about the configured preset.
     */
    private presetReadiness;
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
    private countActiveWorkingSessions;
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
    private openSleepSession;
    /**
     * Model options for a Session this runtime creates.
     * @returns The deployment's default selection, or empty options when none is configured.
     */
    private agentOptions;
    /**
     * Name the sleep Session after the date it reflects on.
     *
     * A title that cannot be set must not stop the run.
     * @param agent - Agent of the sleep Session.
     * @param date - Local date the run belongs to.
     */
    private nameSession;
    /**
     * Give the sleep Session the configured reasoning effort.
     *
     * The choice is recorded on this Session only: working Sessions keep the
     * user's own selection, and the deployment default is not rewritten.
     * @param agent - Agent of the sleep Session.
     */
    private selectReasoningEffort;
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
    private resolveReasoningEffort;
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
    private sleepMessage;
    /**
     * Classify the turn the sleep prompt started.
     * @param sessionId - Sleep Session whose log is read.
     * @param turn - Turn that claimed the sleep prompt, or `undefined` when no turn claimed it.
     * @returns `completed`, or `failed` with the recorded reason.
     * @throws SleepError with code `SLEEP_SESSION_QUERY_FAILED` when the log cannot be read.
     */
    private turnOutcome;
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
    private record;
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
    private releaseTools;
    /**
     * Release the Agent handle this run owns.
     * @param active - Slot-holding run record.
     */
    private releaseHandle;
    /** Cancel the run in progress so its wait for the Agent settles during teardown. */
    private stopActiveRun;
    /**
     * Cancel the Agent of a run that teardown already aborted.
     *
     * The Agent exists only after Session creation finished, so teardown can have
     * run before this record owned one; the run then cancels the Agent itself.
     * @param active - Slot-holding run record.
     * @param agent - Agent the run just resolved.
     */
    private cancelIfAborted;
    /**
     * Cancel one sleep turn without letting a failure escape.
     * @param agent - Agent whose turn is cancelled.
     */
    private cancelAgent;
    /**
     * Wait for the run in progress, for a bounded time.
     *
     * The run is cancelled first, so this bound only ends a wait on work that
     * ignores its cancellation; unloading must not block on it forever.
     * @param run - The active run's settlement promise.
     * @returns Whether the run settled inside the bound.
     */
    private settleActiveRun;
    /** Disarm the pending timer. */
    private clearTimer;
    /**
     * Latest local date this runtime has already decided about.
     * @returns The later of the durable and the in-memory decision dates, or `null` when none is recorded.
     */
    private decidedDate;
    /** Arm the timer for the next due slot. */
    private scheduleNext;
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
    private tick;
}
//# sourceMappingURL=index.d.ts.map