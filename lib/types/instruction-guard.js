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
import { isSleepAgent } from "./activity.js";
/**
 * Install the guard on the host plane.
 *
 * A Host listener registered through `ctx.get`-free code sees every Agent, so
 * one installation covers the Session this plugin creates and a Session a user
 * starts under the sleep preset.
 * @param ctx - Host context whose `agent/pre-step` waterfall the guard joins.
 * @param presetId - Configured sleep preset name.
 */
export function installInstructionGuard(ctx, presetId) {
    ctx.on('agent/pre-step', async ({ agent }, next) => {
        // The guard is installed first, so `next()` returns the decision every other
        // listener already rewrote; a listener that behaved differently would let
        // the profile decide whether instructions reach a Sleep Session.
        const decision = await next();
        if (decision.kind === 'reject')
            return decision;
        if (!isSleepAgent(ctx, agent, presetId))
            return decision;
        const kept = decision.messages.filter(message => !isInstructionMessage(message));
        if (kept.length === decision.messages.length)
            return decision;
        // The loader composes its message again on the next step, and the guard
        // drops that copy too: the Session never records or receives it.
        return { ...decision, messages: kept };
    }, { prepend: true });
}
/**
 * Whether one message carries workspace instructions.
 * @param message - Message a step would enter.
 * @returns `true` when the workspace instruction loader produced the message.
 */
function isInstructionMessage(message) {
    return message.source.kind === 'agent-instructions';
}
//# sourceMappingURL=instruction-guard.js.map