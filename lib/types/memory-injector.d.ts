/**
 * Sleep notes reloaded into working Sessions.
 *
 * A working Session starts with the notes the user's sleep Sessions saved, so
 * the work continues from what earlier reflection learned. The block enters as
 * one durable `user/message` on the first step that runs, inside the
 * `<system-reminder>` frame the workspace instruction loader uses.
 *
 * Only the notes whose rendered block fits `injectMaxBytes` travel inline, and
 * that budget charges each note's heading and path as well as its text. Every
 * other note is listed with its relative path, absolute path, and size, so the
 * model opens the ones that matter with its ordinary `read` tool: the
 * filesystem sandbox leaves reads unrestricted, so no second read tool is
 * needed.
 * @module @deepseek-ai/dsh-sleep/memory-injector
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import type { ResolvedConfig } from './config.ts';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /**
         * The startup block that reloads the saved sleep notes into a working Session.
         *
         * Readers replay the block without this producer; only the injector reads
         * the kind, to keep one block per Session.
         * @persistenceAttribution
         */
        'sleep-memory': {
            kind: 'sleep-memory';
            /** Always the startup block: one per Session, never repeated. */
            baseline: true;
            /** Absolute path of the notes directory the block was read from. */
            dir: string;
            /** Notes whose text the block carries, relative to {@link dir} and in path order. */
            includedFiles: string[];
            /** Number of text notes found, whether carried in the block or only listed. */
            totalFiles: number;
        } & ContextFormed;
    }
}
/**
 * Reload the saved sleep notes into the Sessions that do real work.
 *
 * Mount this on the host context, next to the runtime that owns the notes
 * directory. Sessions the sleep preset composed are left alone, and a Session
 * that already carries the block keeps it: the injection happens once and stays
 * durable across resume and across a compaction that shadows the block from the
 * Session surface when the projection registry is composed.
 * @param ctx - Host context whose `agent/pre-step` waterfall the block joins.
 * @param config - Resolved sleep configuration; its `dir` is an absolute directory by validation.
 */
export declare function installMemoryInjector(ctx: Context, config: ResolvedConfig): Promise<void>;
//# sourceMappingURL=memory-injector.d.ts.map