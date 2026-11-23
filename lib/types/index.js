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
import { randomUUID } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import { ReasoningEffortId, boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { isSleepSessionRecord, resolveSessionActivityAt } from "./activity.js";
import { installSleepCommand } from "./command.js";
import { Config, resolveConfig } from "./config.js";
import { SleepError, presetBrokenError, presetsUnavailableError, runInProgressError, runtimeStoppingError, storeUnavailableError, } from "./errors.js";
import { createExecutionDrain } from "./execution-drain.js";
import { installInstructionGuard } from "./instruction-guard.js";
import { installMemoryInjector } from "./memory-injector.js";
import { ensureNotesDirectory } from "./notes-fs.js";
import { localDateKey, nextDelayMs } from "./schedule-math.js";
import { sleepSessionQuery } from "./session-query.js";
import { EMPTY_SLEEP_STATE, openSleepStore } from "./storage.js";
import * as SleepTools from "./tools.js";
/** Whether one raw Session event closes the given turn. */
function isTurnEndOf(event, turn) {
    return event.type === 'turn/end' && event.data.turn === turn;
}
/**
 * Describe why a turn did not complete.
 * @param reason - Recorded turn-end reason.
 * @returns One sentence naming the outcome.
 */
function describeTurnEnd(reason) {
    if (reason.kind === 'error')
        return `the sleep turn failed: ${reason.error.message}`;
    if (reason.kind === 'aborted')
        return `the sleep turn was aborted (${reason.reason.kind})`;
    if (reason.kind === 'max-tokens')
        return 'the sleep turn reached its output-token ceiling';
    return `the sleep turn ended as ${reason.kind}`;
}
/** Sentence recorded when a failure names no reason of its own. */
const UNREPORTED_FAILURE = 'the sleep run failed without a reported message';
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
    }
    catch (unreadable) {
        // The value refuses to be read as text, and the attempt still needs a
        // reason the durable record accepts.
        void unreadable;
        return UNREPORTED_FAILURE;
    }
    return message === '' ? UNREPORTED_FAILURE : message;
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
const TEARDOWN_SETTLE_MS = 5_000;
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
const PRESET_WAIT_MS = 10_000;
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
const SLOT_SETTLE_MS = 30_000;
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
export default class SleepRuntime extends Service {
    /** Host services this plugin cannot run without. */
    static inject = ['agents', 'sessions', 'sessionQuery', 'storageDomain', 'tools'];
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
        super(ctx, 'sleep');
        this.config = resolveConfig(config, { hostTimeZone: hostTimeZone() });
        this.current = EMPTY_SLEEP_STATE;
        this.initialized = ctx.effect(async () => {
            // The notes directory is created before any Session or injector reads it:
            // the Session controller creates a missing Session cwd with the process
            // umask, and a private notes directory needs `0700`.
            await ensureNotesDirectory(this.config.dir);
            await this.openStore();
            this.scheduleNext();
            return async () => {
                this.stopping = true;
                this.clearTimer();
                this.stopActiveRun();
                const run = this.active?.run;
                // A run that ignores its cancellation still holds the store it saves
                // its outcome through; closing now would lose that write. Unloading
                // stops waiting after the bound and closes the store once the run
                // settles instead. That deferral covers unloading this plugin while
                // its storage provider stays mounted: a Host teardown unmounts the
                // provider, which closes the domain once this disposer returns, so a
                // run that outlives the bound loses its outcome.
                if (run !== undefined && !await this.settleActiveRun(run)) {
                    const closeWhenSettled = () => {
                        // The outcome is already durable; a close failure cannot change it.
                        /* v8 ignore next 3 -- a backend close fault after the save changes no reported outcome */
                        void this.closeStore().catch((error) => {
                            this.ctx.logger.warn(`sleep: the store was not closed: ${String(error)}`);
                        });
                    };
                    void run.then(closeWhenSettled, closeWhenSettled);
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
        // Both host-plane contributions serve working Sessions rather than the
        // sleep preset, so the runtime owns them beside the timer it arms.
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
        if (this.store !== undefined)
            return null;
        if (this.storeFailure === undefined)
            return 'the durable sleep state has not opened yet';
        return failureReason(this.storeFailure);
    }
    /** Session of the run in progress, or `null` when no run is active. */
    get activeSessionId() {
        return this.active?.sessionId ?? null;
    }
    /** Whether a run holds the runtime's slot, including before it created a Session. */
    get activeRun() {
        return this.active !== undefined;
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
        if (this.stopping || !this.config.enabled)
            return null;
        const delayMs = nextDelayMs(nowMs, this.config.time, this.config.timeZone, this.decidedDate());
        return { at: nowMs + delayMs, delayMs };
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
        return this.start('manual', Date.now());
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
        if (this.stopping)
            throw runtimeStoppingError();
        // The decision date is claimed before anything can refuse or fail: a
        // refused run or a failed state write must not let the timer repeat today.
        // The claim reads the instant the caller decided on, so a tick that crosses
        // midnight cannot claim the date after the one whose slot it found due.
        if (trigger === 'scheduled')
            this.attemptedDate = localDateKey(claimedAtMs, this.config.timeZone);
        if (this.active !== undefined)
            throw runInProgressError(this.active.sessionId);
        const started = Promise.withResolvers();
        const active = {
            sessionId: null,
            abort: new AbortController(),
            agent: undefined,
            handle: undefined,
            tools: undefined,
            drain: undefined,
            started,
            run: undefined,
        };
        const run = this.ctx.agents.withoutInitiator(async () => {
            this.active = active;
            try {
                return await this.execute(active, trigger, claimedAtMs);
            }
            finally {
                // An attempt that ended before it created a Session still answers its
                // start, so a caller waiting for one cannot wait for the whole run.
                started.resolve(active.sessionId);
            }
        });
        active.run = run;
        const settled = run.then((result) => {
            this.active = undefined;
            return result;
        }, (error) => {
            this.active = undefined;
            throw error;
        });
        // A manual caller may report the started run and never await the outcome, so
        // a rejection outside the attempt record is reported here instead of leaving
        // the runtime with an unhandled rejection.
        void settled.catch((error) => {
            this.ctx.logger.warn(`sleep: the run failed outside its attempt record: ${String(error)}`);
        });
        return { started: started.promise, settled };
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
            this.storeFailure = undefined;
        }
        catch (error) {
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
        if (this.store === undefined)
            await this.openStore();
        const store = this.store;
        if (store === undefined)
            throw storeUnavailableError(this.storeFailure);
        return store;
    }
    /**
     * Close the durable state this runtime holds.
     *
     * A store that never opened leaves nothing to close.
     */
    async closeStore() {
        const store = this.store;
        this.store = undefined;
        if (store === undefined)
            return;
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
        // The run reads the durable state and saves its outcome through the store,
        // so it waits for the entry point that opened it and opens the store itself
        // when the activation attempt failed. A caller that reached the service
        // before the store opened therefore cannot run against empty state.
        await this.initialized;
        const store = await this.ensureStore();
        const startedAt = new Date(startedAtMs).toISOString();
        const date = localDateKey(startedAtMs, this.config.timeZone);
        let workingSessions;
        try {
            const presets = await this.waitForPresets(active.abort.signal);
            workingSessions = await this.countActiveWorkingSessions();
            if (trigger === 'scheduled' && workingSessions < this.config.minSessions) {
                return await this.record(store, trigger, startedAt, date, {
                    status: 'skipped',
                    sessionId: null,
                    workingSessions,
                    reason: `${workingSessions} working Sessions were active since the last sleep; ${this.config.minSessions} required`,
                });
            }
            active.abort.signal.throwIfAborted();
            const agent = await this.openSleepSession(active, presets, date);
            // An unload during Session creation aborts the run: the Agent it produced
            // must not mount tools or start a turn the unloaded plugin can no longer
            // observe.
            this.cancelIfAborted(active, agent);
            active.abort.signal.throwIfAborted();
            await this.selectReasoningEffort(agent);
            active.abort.signal.throwIfAborted();
            const prompt = this.sleepMessage(agent, trigger, startedAtMs, workingSessions);
            // The turn this run started is the one that claimed its prompt, not
            // whatever turn the Session recorded last: a follow-up queued behind an
            // output-capped turn must not turn this run into a completion.
            let runTurn;
            const stopClaim = agent.ctx.on('agent/inbox/claimed', ({ agent: subject, message, turn }) => {
                if (subject.id === agent.id && message.id === prompt.id)
                    runTurn = turn;
            });
            try {
                agent.followup(prompt);
                await this.ctx.sessions.flush(agent.session);
                await agent.whenIdle();
                await this.ctx.sessions.flush(agent.session);
                const outcome = await this.turnOutcome(agent.session.id, runTurn);
                // The classification is the last decision of the run, and its lookup is
                // an await: a run cancelled during it must not advance the checkpoint.
                active.abort.signal.throwIfAborted();
                return await this.record(store, trigger, startedAt, date, {
                    ...outcome,
                    sessionId: agent.session.id,
                    workingSessions,
                });
            }
            finally {
                stopClaim();
            }
        }
        catch (error) {
            return await this.record(store, trigger, startedAt, date, {
                status: 'failed',
                sessionId: active.sessionId,
                ...workingSessions === undefined ? {} : { workingSessions },
                reason: failureReason(error),
            });
        }
        finally {
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
                if (poll !== undefined)
                    clearTimeout(poll);
                clearTimeout(deadline);
                signal.removeEventListener('abort', onAbort);
            };
            const check = async () => {
                const presets = this.ctx.get('agentPresets');
                if (presets !== undefined) {
                    const readiness = await this.presetReadiness(presets);
                    if (readiness.kind === 'ready') {
                        finish();
                        resolve(presets);
                        return;
                    }
                    if (readiness.kind === 'broken') {
                        // The registry reports the preset itself broken: waiting cannot
                        // repair that, so the attempt ends with the activation diagnostic.
                        if (!finished) {
                            finish();
                            reject(presetBrokenError(this.config.presetId, readiness.diagnostic));
                        }
                        return;
                    }
                }
                // The deadline or an unload can end the wait while this check runs.
                if (finished)
                    return;
                poll = setTimeout(() => { void check(); }, PRESET_POLL_MS);
                poll.unref();
            };
            const deadline = setTimeout(() => {
                finish();
                reject(presetsUnavailableError());
            }, PRESET_WAIT_MS);
            deadline.unref();
            const onAbort = () => {
                // The run is cancelled only by this runtime's own teardown, so it
                // reports that failure instead of the platform's abort reason.
                finish();
                reject(runtimeStoppingError());
            };
            signal.addEventListener('abort', onAbort, { once: true });
            void check();
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
        const preset = await presets.resolve(this.config.presetId).catch((error) => {
            // An unregistered preset throws; any other failure keeps the attempt
            // waiting until the bound reports it.
            void error;
            return undefined;
        });
        if (preset === undefined)
            return { kind: 'pending' };
        if (preset.broken !== undefined)
            return { kind: 'broken', diagnostic: preset.broken };
        return { kind: 'ready' };
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
        const records = await sleepSessionQuery(this.ctx, 'listSessions', () => this.ctx.sessionQuery.listSessions());
        const since = this.current.lastSleepAt === null ? null : Date.parse(this.current.lastSleepAt);
        let count = 0;
        for (const record of records) {
            try {
                if (await isSleepSessionRecord(this.ctx, record, this.config.presetId))
                    continue;
                const activityAt = await resolveSessionActivityAt(this.ctx, record, since === null ? {} : { after: since });
                if (since !== null && activityAt <= since)
                    continue;
            }
            catch (error) {
                // One unreadable Session log is left out instead of failing the whole
                // attempt: the other Sessions can still justify this sleep, and a
                // scheduled failure would mark the day as decided.
                if (!(error instanceof SleepError && error.code === 'SLEEP_SESSION_QUERY_FAILED'))
                    throw error;
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
        const controller = this.ctx.get('sessionController');
        let agent;
        if (controller !== undefined) {
            const created = await controller.create({ sessionId: requested, cwd, agentPreset: this.config.presetId });
            active.sessionId = created.sessionId;
            // The run exists as soon as it owns a Session, so a caller that reports the
            // start instead of waiting for the reflection answers now.
            active.started.resolve(created.sessionId);
            const resolved = await controller.resolveAgent(created.sessionId);
            if ('error' in resolved)
                throw resolved.error;
            agent = resolved.agent;
        }
        else {
            const handle = await this.ctx.agents.create({
                sessionId: requested,
                signal: active.abort.signal,
                meta: { cwd, agentPreset: this.config.presetId },
                agentOptions: this.agentOptions(),
                setup: async (agentCtx) => {
                    await presets.mount(agentCtx, this.config.presetId);
                },
            });
            active.handle = handle;
            active.sessionId = handle.agent.session.id;
            active.started.resolve(active.sessionId);
            agent = handle.agent;
        }
        // The Agent becomes the run's own as soon as it exists, so a teardown that
        // ran while the controller was still creating it can cancel this turn.
        active.agent = agent;
        this.cancelIfAborted(active, agent);
        active.abort.signal.throwIfAborted();
        // The fiber is recorded before the await, so a run that fails to mount the
        // tools still unmounts whatever it managed to mount. The drain is created
        // here because this run owns the slot: the next run may not start while a
        // tool execution this one admitted is still writing notes.
        const drain = createExecutionDrain();
        active.drain = drain;
        const tools = agent.ctx.plugin(SleepTools, { drain });
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
        return this.ctx.get('agentDefaultModel')?.currentSelection() ?? {};
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
            this.ctx.get('sessionTitle')?.rename(agent.session, `Sleep · ${date}`);
        }
        catch (error) {
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
        if (current === undefined) {
            this.ctx.logger.warn('sleep: the sleep Session has no model route, so its reasoning effort was not set');
            return;
        }
        const effort = await this.resolveReasoningEffort(current.provider, current.model);
        agent.model.select({
            provider: current.provider,
            model: current.model,
            ...effort === undefined ? {} : { reasoningEffort: effort },
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
        const llm = this.ctx.get('llm');
        if (llm === undefined)
            return requested;
        let info;
        try {
            info = await llm.resolveModelInfo(provider, model);
        }
        catch (error) {
            this.ctx.logger.warn(`sleep: the reasoning efforts of ${provider}/${model} were not read, so its adapter default applies: ${String(error)}`);
            return undefined;
        }
        const reasoning = info.reasoning;
        if (reasoning === undefined) {
            this.ctx.logger.warn(`sleep: ${provider}/${model} declares no reasoning effort, so ${requested} was not selected`);
            return undefined;
        }
        if (reasoning.efforts.some(effort => effort.id === requested))
            return requested;
        this.ctx.logger.warn(`sleep: ${provider}/${model} does not offer reasoning effort ${requested}; `
            + (reasoning.defaultEffort === undefined
                ? 'its adapter default applies'
                : `using ${reasoning.defaultEffort} instead`));
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
        // A manual run does not happen at the configured slot, so it names the date
        // and zone only; the scheduled heading also names that slot.
        const when = trigger === 'scheduled'
            ? `${date} ${this.config.time} ${this.config.timeZone}`
            : `${date} ${this.config.timeZone}`;
        const heading = `${trigger === 'scheduled' ? 'Scheduled' : 'Manual'} sleep run · ${when}`;
        // The roster is what this Agent can actually call, so a renamed or
        // additionally mounted tool reaches the prompt without a second edit.
        const tools = this.ctx.tools.schemas(agent).map(schema => schema.name);
        return createUserMessage({
            content: [{
                    type: 'text',
                    text: [
                        heading,
                        `Now: ${new Date(startedAtMs).toISOString()}`,
                        `Last completed sleep: ${this.current.lastSleepAt ?? 'none yet'}`,
                        `Working Sessions active since then: ${workingSessions}`,
                        `Notes directory: ${this.config.dir}`,
                        `Tools in this Session: ${tools.join(', ')}.`,
                    ].join('\n'),
                }],
            source: {
                kind: 'sleep',
                trigger,
                form: 'notice',
                summary: boundContextSummary(`${trigger} sleep run over ${workingSessions} active Sessions`),
            },
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
        if (turn === undefined) {
            return { status: 'failed', reason: 'the sleep prompt was never claimed for a turn' };
        }
        const events = (await sleepSessionQuery(this.ctx, 'readSession', () => this.ctx.sessionQuery.readSession(sessionId))).events;
        const end = events.findLast(event => isTurnEndOf(event, turn));
        if (end === undefined)
            return { status: 'failed', reason: `the sleep turn ${turn} recorded no end` };
        if (end.data.reason.kind === 'completed')
            return { status: 'completed' };
        return { status: 'failed', reason: describeTurnEnd(end.data.reason) };
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
        const completed = attempt.status === 'completed';
        const outcome = {
            at: startedAt,
            trigger,
            status: attempt.status,
            ...attempt.sessionId === null ? {} : { sessionId: attempt.sessionId },
            ...attempt.reason === undefined ? {} : { reason: attempt.reason },
        };
        const next = {
            lastSleepAt: completed ? startedAt : this.current.lastSleepAt,
            lastScheduledDate: trigger === 'scheduled' ? date : this.current.lastScheduledDate,
            lastOutcome: outcome,
        };
        const result = {
            ...outcome,
            sessionId: attempt.sessionId,
            ...attempt.workingSessions === undefined ? {} : { workingSessions: attempt.workingSessions },
        };
        try {
            await store.save(next);
            this.current = next;
        }
        catch (error) {
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
        active.tools = undefined;
        active.drain = undefined;
        if (tools !== undefined) {
            try {
                await tools.dispose();
            }
            catch (error) {
                /* v8 ignore next -- a Cordis fiber reports its own teardown failures to the logger instead of rejecting */
                this.ctx.logger.warn(`sleep: the sleep tools were not unmounted: ${String(error)}`);
            }
        }
        if (drain === undefined)
            return;
        if (await drain.close(SLOT_SETTLE_MS))
            return;
        this.ctx.logger.warn(`sleep: a tool execution this run admitted was still running ${SLOT_SETTLE_MS} ms after the run unmounted its tools, `
            + 'so the sleep slot was released with it pending');
    }
    /**
     * Release the Agent handle this run owns.
     * @param active - Slot-holding run record.
     */
    async releaseHandle(active) {
        const handle = active.handle;
        active.handle = undefined;
        if (handle === undefined)
            return;
        try {
            await handle.dispose();
        }
        catch (error) {
            this.ctx.logger.warn(`sleep: the sleep Agent was not disposed: ${String(error)}`);
        }
    }
    /** Cancel the run in progress so its wait for the Agent settles during teardown. */
    stopActiveRun() {
        const active = this.active;
        if (active === undefined)
            return;
        active.abort.abort();
        const agent = active.agent;
        if (agent === undefined)
            return;
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
        if (!active.abort.signal.aborted)
            return;
        this.cancelAgent(agent);
    }
    /**
     * Cancel one sleep turn without letting a failure escape.
     * @param agent - Agent whose turn is cancelled.
     */
    cancelAgent(agent) {
        try {
            agent.cancel({ kind: 'disposed' });
        }
        catch (error) {
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
        const settle = () => { settled = true; };
        let timer;
        try {
            await Promise.race([
                run.then(settle, settle),
                new Promise((resolve) => {
                    timer = setTimeout(resolve, TEARDOWN_SETTLE_MS);
                }),
            ]);
        }
        finally {
            clearTimeout(timer);
        }
        return settled;
    }
    /** Disarm the pending timer. */
    clearTimer() {
        if (this.timer !== undefined)
            clearTimeout(this.timer);
        this.timer = undefined;
    }
    /**
     * Latest local date this runtime has already decided about.
     * @returns The later of the durable and the in-memory decision dates, or `null` when none is recorded.
     */
    decidedDate() {
        const { lastScheduledDate } = this.current;
        const attempted = this.attemptedDate;
        if (attempted === null)
            return lastScheduledDate;
        if (lastScheduledDate === null)
            return attempted;
        return attempted > lastScheduledDate ? attempted : lastScheduledDate;
    }
    /** Arm the timer for the next due slot. */
    scheduleNext() {
        this.clearTimer();
        const slot = this.nextSlot();
        if (slot === null)
            return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.tick();
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
            if (this.nextSlot(now)?.delayMs !== 0)
                return;
            await this.start('scheduled', now).settled;
        }
        catch (error) {
            this.ctx.logger.warn(`sleep: the scheduled run did not start: ${String(error)}`);
        }
        finally {
            this.scheduleNext();
        }
    }
}
//# sourceMappingURL=index.js.map