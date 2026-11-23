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
import type { Context } from '@deepseek-ai/cordis';
import type { SleepService } from './types.ts';
/**
 * Register `/sleep` wherever a command registry is composed.
 *
 * The registration belongs to an injected child, so a Host without a command
 * surface keeps the scheduled sleep and the memory injection and simply has no
 * `/sleep` to answer.
 * @param ctx - Host context carrying the runtime.
 * @param service - Runtime the command reports on and starts.
 */
export declare function installSleepCommand(ctx: Context, service: SleepService): void;
//# sourceMappingURL=command.d.ts.map