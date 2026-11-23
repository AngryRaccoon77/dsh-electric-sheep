/**
 * Isolation of the sleep Session from workspace instructions.
 *
 * The sleep preset mounts no instruction loader, but a profile that mounts
 * `@deepseek-ai/dsh-agent-instructions` globally - as `dsh-base` does, and as the
 * `--patch` install route composes it - applies that loader's `agent/pre-step`
 * listener to every Agent, including a Sleep Session. The workspace rules would
 * then reach the one Session the sleep preset keeps free of them.
 *
 * The guard enforces the isolation in the Session instead of leaving it to the
 * profile: it removes every instruction-sourced message a Sleep Session would
 * otherwise receive. It registers first in the waterfall, so it rewrites the
 * decision every other listener composed, and the rewritten decision is what the
 * loop enters. A profile that mounts the loader globally therefore renders the
 * same sleep request as one that does not.
 * @module @deepseek-ai/dsh-sleep/instruction-guard
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * Install the guard on the host plane.
 *
 * A Host listener registered through `ctx.get`-free code sees every Agent, so
 * one installation covers the Session this plugin creates and a Session a user
 * starts under the sleep preset.
 * @param ctx - Host context whose `agent/pre-step` waterfall the guard joins.
 * @param presetId - Configured sleep preset name.
 */
export declare function installInstructionGuard(ctx: Context, presetId: string): void;
//# sourceMappingURL=instruction-guard.d.ts.map