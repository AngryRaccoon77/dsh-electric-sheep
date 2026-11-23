/**
 * Isolation of the sleep preset.
 *
 * Mount this row inside the sleep preset: the preset scope is an ancestor of
 * every Session composed under it, so the mask applies to the tools that
 * Session inherits from the Host. The seven sleep tools are registered by the
 * runtime in the Session's own scope, and a scope's own registrations stay
 * visible through a restriction, so both the runtime-created and the
 * user-selected sleep Session keep exactly their own tools.
 * @module @deepseek-ai/dsh-sleep/isolation
 */
import type { Context } from '@deepseek-ai/cordis';
/** Plugin name registered with the Loader. */
export declare const name = "sleep-isolation";
/** Host services this plugin needs. */
export declare const inject: string[];
/**
 * Mask every tool the mounted preset inherits from the Host.
 * @param ctx - Preset-scoped composition context.
 * @throws when the context is not scoped, because a context-global restriction
 * would mask every Agent of the Host.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=isolation.d.ts.map