/**
 * Human-facing `/sleep` command.
 *
 * `/sleep` and `/sleep now` start one manual sleep, and `/sleep status` reports
 * what the runtime already knows without starting anything. The status text
 * names the schedule, the last attempt, the next slot, the run in progress, and
 * the notes directory, so a user can check the cycle from the composer.
 *
 * A manual run ignores `enabled` and `minSessions`: the user asked for it. A
 * run that cannot start - because one is already active, or because the plugin
 * is unloading - becomes an error result instead of a rejected command.
 * @module @deepseek-ai/dsh-sleep/command
 */
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands';
import { SleepError } from "./errors.js";
import { listNotes } from "./notes-fs.js";
/** Every accepted spelling, in the order the usage line and the input hint list them. */
const SLEEP_ARGUMENTS = [
    { spelling: '', action: 'run' },
    { spelling: 'now', action: 'run' },
    { spelling: 'status', action: 'status' },
];
/** Accepted spellings between brackets, as the input hint and the usage line spell them. */
const ARGUMENT_HINT = `[${SLEEP_ARGUMENTS
    .map(argument => argument.spelling)
    .filter(spelling => spelling !== '')
    .join('|')}]`;
/** Usage line for an invocation no spelling accepts. */
const USAGE = `Usage: /sleep ${ARGUMENT_HINT}`;
/** Milliseconds in one minute, for the pending-delay wording. */
const MS_PER_MINUTE = 60_000;
/** Minutes in one hour, for the pending-delay wording. */
const MINUTES_PER_HOUR = 60;
/**
 * Register `/sleep` wherever a command registry is composed.
 *
 * The registration belongs to an injected child, so a Host without a command
 * surface keeps the scheduled sleep and the memory injection and simply has no
 * `/sleep` to answer.
 * @param ctx - Host context carrying the runtime.
 * @param service - Runtime the command reports on and starts.
 */
export function installSleepCommand(ctx, service) {
    ctx.inject(['commands'], (commandCtx) => {
        commandCtx.commands.register({
            definitionId: CommandDefinitionId('@deepseek-ai/dsh-sleep'),
            name: 'sleep',
            description: 'Run the daily reflective sleep now, or show its status',
            input: { hint: ARGUMENT_HINT },
            handler: invocation => executeSleepCommand(service, invocation.rawInput.trim()),
        });
    });
}
/**
 * Answer one `/sleep` invocation.
 * @param service - Runtime the command reports on and starts.
 * @param request - Trimmed text after the command name.
 * @returns The command result for this invocation.
 */
async function executeSleepCommand(service, request) {
    const argument = SLEEP_ARGUMENTS.find(candidate => candidate.spelling === request);
    if (argument === undefined)
        return { kind: 'error', text: USAGE };
    return argument.action === 'status' ? await reportStatus(service) : await startSleep(service);
}
/**
 * Start one manual run and report it without waiting for the reflection.
 *
 * A sleep run takes minutes, while the surface that ran `/sleep` waits for this
 * handler. The run therefore outlives the invocation: the command answers with
 * the Session the run started, and `/sleep status` reports how it ended. Only an
 * attempt that ended before it had a Session is awaited to completion, because
 * its outcome is already known and a started-run answer would hide a failure.
 * @param service - Runtime that owns the run.
 * @returns A result naming the started run, the finished attempt, or a refusal.
 */
async function startSleep(service) {
    try {
        const run = service.startNow();
        // The run is durable and outlives this invocation, so this waits for the
        // Session it creates, never for the reflection itself.
        const sessionId = await run.started;
        if (sessionId === null)
            return describeRun(await run.settled);
        return { kind: 'success', text: `Sleep started in Session ${sessionId}; /sleep status reports how it ends.` };
    }
    catch (error) {
        // A coded refusal already carries the action the user can take, whether it
        // refused the start or ended the attempt before it had a Session.
        if (error instanceof SleepError)
            return { kind: 'error', text: error.message };
        throw error;
    }
}
/**
 * Render one finished attempt.
 *
 * A skipped run failed at nothing, so it settles as a success that says nothing
 * happened; only a failed run reports an error.
 * @param result - The attempt's result.
 * @returns The command result describing the attempt.
 */
function describeRun(result) {
    const where = result.sessionId === null ? '' : ` in Session ${result.sessionId}`;
    if (result.status === 'completed')
        return { kind: 'success', text: `Sleep completed${where}.` };
    if (result.status === 'skipped') {
        return { kind: 'success', text: `Sleep skipped${where}: ${result.reason ?? 'no reason was recorded'}.` };
    }
    return { kind: 'error', text: `Sleep failed${where}: ${result.reason ?? 'no reason was recorded'}.` };
}
/**
 * Report the runtime's schedule, history, and notes.
 *
 * Every line is read from the service on this call: the durable state, the
 * slot the timer is waiting for, and a fresh scan of the notes directory. A
 * notes directory this Host cannot read is reported instead of failing the
 * status.
 * @param service - Runtime that reports the status.
 * @returns The status text.
 */
async function reportStatus(service) {
    const { config, state } = service;
    const stateError = service.stateError;
    const lines = [
        `Schedule: ${describeSchedule(service)}`,
        `Last completed sleep: ${state.lastSleepAt ?? 'never'}`,
        `Last outcome: ${describeOutcome(state.lastOutcome)}`,
        // A state that never opened would report a stale history as the truth, so
        // the status names the failure instead of showing the pre-load state alone.
        ...stateError === null ? [] : [`Durable state: unavailable (${stateError})`],
        `Next slot: ${describeNextSlot(service)}`,
        `Active run: ${describeActiveRun(service)}`,
        `Notes: ${await describeNotes(config.dir)}`,
    ];
    return { kind: 'success', text: lines.join('\n') };
}
/**
 * Describe the run that holds the runtime's slot.
 *
 * A run claims the slot before it creates its Session, so a status read in that
 * window names the starting run instead of reporting that no run is active.
 * @param service - Runtime that owns the run.
 * @returns The Session the run drives, the starting state before it has one, or none.
 */
function describeActiveRun(service) {
    if (!service.activeRun)
        return 'none';
    return service.activeSessionId ?? 'starting';
}
/**
 * Describe the configured slot.
 * @param service - Runtime that carries the configuration.
 * @returns The slot and its zone, or the disabled state.
 */
function describeSchedule(service) {
    const { config } = service;
    return config.enabled
        ? `daily at ${config.time} ${config.timeZone}`
        : 'off; /sleep now still runs a manual sleep';
}
/**
 * Describe the last attempt.
 * @param outcome - Recorded outcome, or `null` before the first attempt.
 * @returns One line naming what happened.
 */
function describeOutcome(outcome) {
    if (outcome === null)
        return 'none yet';
    const where = outcome.sessionId === undefined ? '' : ` in Session ${outcome.sessionId}`;
    const reason = outcome.reason === undefined ? '' : `: ${outcome.reason}`;
    return `${outcome.status} at ${outcome.at} (${outcome.trigger})${where}${reason}`;
}
/**
 * Describe when the timer next fires.
 * @param service - Runtime that arms the timer.
 * @returns The next slot's instant and delay, the due-now case, or the disabled state.
 */
function describeNextSlot(service) {
    const slot = service.nextSlot();
    if (slot === null)
        return 'scheduled runs are off';
    if (slot.delayMs === 0)
        return "due now; today's slot passed without a recorded run";
    return `${new Date(slot.at).toISOString()} (in ${formatDelay(slot.delayMs)})`;
}
/**
 * Render a delay as whole minutes and hours.
 * @param delayMs - Delay in milliseconds.
 * @returns The delay, such as `3 h 5 min`.
 */
function formatDelay(delayMs) {
    const minutes = Math.round(delayMs / MS_PER_MINUTE);
    const hours = Math.floor(minutes / MINUTES_PER_HOUR);
    return hours === 0 ? `${minutes} min` : `${hours} h ${minutes % MINUTES_PER_HOUR} min`;
}
/**
 * Describe the notes directory as it stands.
 * @param dir - Absolute notes directory.
 * @returns The file count, the total bytes, and the directory.
 */
async function describeNotes(dir) {
    try {
        const notes = await listNotes(dir);
        const bytes = notes.reduce((total, note) => total + note.bytes, 0);
        return `${notes.length} files, ${bytes} bytes in ${dir}`;
    }
    catch (error) {
        // A status line must not fail on a directory the Host cannot read; the note
        // tools report the same failure with a code when one of them is used.
        /* v8 ignore next -- listNotes reports every filesystem failure as a SleepError, so only that class reaches here */
        if (!(error instanceof SleepError))
            throw error;
        return `unavailable (${error.message}) in ${dir}`;
    }
}
//# sourceMappingURL=command.js.map