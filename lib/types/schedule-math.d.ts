/**
 * Daily schedule arithmetic for the sleep plugin.
 *
 * The plugin stores one wall-clock slot and asks this module when that slot is
 * due in an explicit IANA zone. Zone and calendar rules come from
 * `@deepseek-ai/dsh-util-time`: `parseLocalCalendar` validates the clock text,
 * `resolveLocalInstant` turns a local wall clock into an instant, and
 * `canonicalizeTimeZone` refuses a zone name the platform cannot use. Every
 * entry takes the caller's clock reading as epoch milliseconds, so a test never
 * reads the system time.
 * @module @deepseek-ai/dsh-sleep/schedule-math
 */
/** Clock fields of the configured daily slot. */
export interface DailyTime {
    /** Hour of the local day, from 0 through 23. */
    readonly hour: number;
    /** Minute of the local hour, from 0 through 59. */
    readonly minute: number;
}
/**
 * Parse the configured `HH:mm` daily slot into clock fields.
 *
 * The shared local-calendar parser validates the text, so the plugin row and
 * the daily timer accept exactly the same spelling.
 * @param value - Slot text, such as `03:00`, after trimming.
 * @returns The hour and minute of the slot.
 * @throws SleepError with code `SLEEP_CONFIG_INVALID` when the text is not a zero-padded 24-hour clock time.
 */
export declare function parseDailyTime(value: string): DailyTime;
/**
 * Project one instant onto the local calendar date of an explicit zone.
 *
 * The key is the spelling the plugin stores for the day of the last scheduled
 * run, so the fixed `YYYY-MM-DD` form compares correctly as text.
 * @param ms - Instant in epoch milliseconds.
 * @param timeZone - IANA zone the sleep schedule follows.
 * @returns The zone-local calendar date as `YYYY-MM-DD`.
 * @throws SleepError with code `SLEEP_CONFIG_INVALID` when the zone is unusable.
 */
export declare function localDateKey(ms: number, timeZone: string): string;
/**
 * Milliseconds until the next run of the daily slot.
 *
 * A slot that passed before today's run was recorded answers `0`, so the caller
 * starts the catch-up at once instead of waiting for the next date. A record
 * dated later than today means the host clock moved back: the run waits for the
 * first date the record leaves open instead of repeating a recorded date. A slot
 * that the zone removed on a date - a forward transition can drop a wall-clock
 * time - is skipped.
 * @param nowMs - Current instant in epoch milliseconds.
 * @param time - Daily slot as `HH:mm`.
 * @param timeZone - IANA zone the sleep schedule follows.
 * @param lastScheduledDate - Zone-local date key of the last scheduled run, or `null` when none is recorded.
 * @returns The delay in milliseconds, from `0` through `MAX_TIMER_DELAY_MS`. The
 * delay is never negative and never exceeds the largest delay the platform timer
 * accepts: a record the clock moved far behind, and a zone that hides the slot
 * on every searched date, both answer that maximum, and the caller re-plans when
 * the timer fires.
 * @throws SleepError when the slot text or the zone is unusable.
 */
export declare function nextDelayMs(nowMs: number, time: string, timeZone: string, lastScheduledDate: string | null): number;
//# sourceMappingURL=schedule-math.d.ts.map