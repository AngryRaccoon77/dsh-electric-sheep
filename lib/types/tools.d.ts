/**
 * Model-facing tools of the sleep Session.
 *
 * The sleep runtime mounts this plugin in the sleep Agent's own scoped
 * context, so the plugin masks every global host tool with
 * `ctx.tools.restrict({ allow: [] })` and registers its seven tools in that
 * same layer. A restriction applies to tools the scope inherits, never to the
 * scope's own registrations, so both steps must share the Agent scope: a row
 * mounted in a preset layer would mask its own tools from the Agent.
 *
 * Reading tools cover the Session history the reflection is about; note tools
 * cover the notes directory, and every note path goes through
 * {@link ./notes-fs.ts} so it stays confined to that directory.
 *
 * A paged result always reports `total` (entries found) and `shown` (entries in
 * this page), whatever it pages over.
 * @module @deepseek-ai/dsh-sleep/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ExecutionDrain } from './execution-drain.ts';
/** Plugin name registered with the Loader. */
export declare const name = "sleep-tools";
/** Host services these tools read. */
export declare const inject: string[];
/**
 * Runtime capability the mounting sleep run provides.
 *
 * The run owns the sleep slot, so it decides when that slot may pass to the next
 * run: after every execution this plugin admitted settled. The plugin uses the
 * same drain for its own bounded unload wait, so one set of executions answers
 * both waits.
 */
export interface SleepToolsOptions {
    /** Drain that tracks this plugin's executions. */
    readonly drain: ExecutionDrain;
}
/**
 * Register the seven sleep tools and mask every global host tool.
 *
 * Mount this plugin in the sleep Agent's own scoped context. The restriction
 * and the registrations then share one layer: inherited host tools stay
 * masked, and the sleep tools remain the Agent's own, unrestricted set.
 *
 * Unloading the plugin first removes the registrations and then waits for every
 * execution they admitted, so a note write a follow-up turn already started
 * cannot land after the run that owns the notes directory released it. That wait
 * is bounded by {@link DRAIN_SETTLE_MS}: an execution that stalls cannot hold the
 * fiber open, which a Host teardown would otherwise wait for without a bound. The
 * mounting run waits again for that execution through
 * {@link ExecutionDrain.close}, with the longer bound it allows the sleep slot.
 * An execution admitted after the removal is refused instead of running.
 * @param ctx - Scoped context of the sleep Agent.
 * @param options - Drain the mounting run shares with this plugin.
 * @throws when the mounting context is not scoped, because a context-global
 * restriction would mask every Agent of the Host.
 */
export declare function apply(ctx: Context, options: SleepToolsOptions): void;
//# sourceMappingURL=tools.d.ts.map