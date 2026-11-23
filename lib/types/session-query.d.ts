/**
 * Session-history reads of the sleep plugin, with one failure boundary.
 *
 * Every `ctx.sessionQuery` call the runtime, the tools, and the activity
 * resolver make goes through here: one wrapper names the operation that failed
 * and raises the plugin's coded failure, so no caller repeats it.
 * @module @deepseek-ai/dsh-sleep/session-query
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * Run one Session-query operation and report its failure as a sleep failure.
 * @param ctx - Host context carrying `sessionQuery` and the logger that records the failure.
 * @param operation - `SessionQuery` operation name, such as `listSessions`.
 * @param invoke - Call that performs the operation.
 * @returns The operation's answer.
 * @throws SleepError with code `SLEEP_SESSION_QUERY_FAILED` when the operation fails.
 */
export declare function sleepSessionQuery<Value>(ctx: Context, operation: string, invoke: () => Promise<Value>): Promise<Value>;
//# sourceMappingURL=session-query.d.ts.map