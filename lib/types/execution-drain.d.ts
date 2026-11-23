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
/** Executions one run admitted, so the run can wait for them. */
export interface ExecutionDrain {
    /**
     * Admit one execution.
     * @returns The release callback the execution must call when it settles.
     * @throws ToolContextUnavailableError when the drain already closed.
     */
    admit(): () => void;
    /**
     * Refuse later admissions and wait for the admitted executions, bounded.
     *
     * The fiber calls this with the bound a Host teardown tolerates, and the run
     * calls it again with the longer bound it allows the slot: a second call
     * re-uses the wait already pending, so the run still waits for the executions
     * the fiber gave up on.
     * @param boundMs - Longest wait for the executions admitted before the close.
     * @returns `true` when every admitted execution finished inside the bound.
     */
    close(boundMs: number): Promise<boolean>;
}
/**
 * Create one execution drain.
 * @returns The drain a run shares between the tool registrations it mounts.
 */
export declare function createExecutionDrain(): ExecutionDrain;
//# sourceMappingURL=execution-drain.d.ts.map