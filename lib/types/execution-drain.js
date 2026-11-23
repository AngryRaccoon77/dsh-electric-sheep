/**
 * Admitted tool executions of one sleep run.
 *
 * The run that mounted the sleep tools owns the notes directory, so the slot may
 * not pass to the next run while an execution it admitted still runs: a note
 * write that landed afterwards would overwrite what the next run wrote. The
 * drain answers the two waits the run needs: the plugin fiber stops at a short
 * bound, because a Host teardown must not wait on it, and the slot waits longer,
 * because an execution admitted before the unload is normally a note write that
 * must land first. Each wait is bounded, so an execution that never settles ends
 * the longer one too instead of holding the slot for the life of the process.
 * @module @deepseek-ai/dsh-sleep/execution-drain
 */
import { ToolContextUnavailableError } from '@deepseek-ai/dsh-tools';
/**
 * Create one execution drain.
 * @returns The drain a run shares between the tool registrations it mounts.
 */
export function createExecutionDrain() {
    let admitted = 0;
    let closed = false;
    let idle;
    return {
        admit() {
            if (closed)
                throw new ToolContextUnavailableError('the sleep run ended, so its tools are unavailable');
            admitted += 1;
            return () => {
                admitted -= 1;
                if (admitted === 0)
                    idle?.resolve();
            };
        },
        async close(boundMs) {
            closed = true;
            if (admitted === 0)
                return true;
            idle ??= Promise.withResolvers();
            const deadline = Promise.withResolvers();
            const timer = setTimeout(() => { deadline.resolve(false); }, boundMs);
            try {
                return await Promise.race([idle.promise.then(() => true), deadline.promise]);
            }
            finally {
                clearTimeout(timer);
            }
        },
    };
}
//# sourceMappingURL=execution-drain.js.map