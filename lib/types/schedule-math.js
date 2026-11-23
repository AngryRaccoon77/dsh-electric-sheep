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
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { canonicalizeTimeZone, parseLocalCalendar, resolveLocalInstant } from '@deepseek-ai/dsh-util-time';
import { invalidConfigError } from "./errors.js";
/**
 * Date the shared clock parser needs to validate an `HH:mm` slot. The parser
 * takes a date and a time together, so this leap-year date stands in; only the
 * clock fields are read back.
 */
const CLOCK_ANCHOR_DATE = '2000-01-01';
/**
 * Consecutive local dates {@link nextDelayMs} inspects for an existing
 * wall-clock slot. A forward transition removes a given clock time on at most
 * one date, so the second date answers; the bound only stops a hypothetical
 * zone that removes the slot on every date.
 */
const SLOT_SEARCH_DAYS = 8;
/**
 * Parse the configured `HH:mm` daily slot into clock fields.
 *
 * The shared local-calendar parser validates the text, so the plugin row and
 * the daily timer accept exactly the same spelling.
 * @param value - Slot text, such as `03:00`, after trimming.
 * @returns The hour and minute of the slot.
 * @throws SleepError with code `SLEEP_CONFIG_INVALID` when the text is not a zero-padded 24-hour clock time.
 */
export function parseDailyTime(value) {
    const parsed = parseLocalCalendar(CLOCK_ANCHOR_DATE, `${value}:00`);
    if (parsed.kind === 'rejected') {
        throw invalidConfigError('time', `expected a 24-hour HH:mm slot, received ${JSON.stringify(value)}`);
    }
    return { hour: parsed.time.hour, minute: parsed.time.minute };
}
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
export function localDateKey(ms, timeZone) {
    return formatLocalDate(localCalendarDate(ms, scheduleZone(timeZone)));
}
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
export function nextDelayMs(nowMs, time, timeZone, lastScheduledDate) {
    const zone = scheduleZone(timeZone);
    const daily = parseDailyTime(time);
    const today = localCalendarDate(nowMs, zone);
    // A real zone carries the slot on one of the searched dates; the initial
    // delay stands for a zone that hides it on every one of them, so the caller
    // re-plans after the longest timer the platform accepts.
    let delay = MAX_TIMER_DELAY_MS;
    let date = firstPendingDate(today, lastScheduledDate);
    for (let step = 0; step < SLOT_SEARCH_DAYS; step += 1) {
        const slot = slotInstant(date, daily, zone);
        if (slot !== undefined) {
            // A record dated far ahead of the clock puts the slot years away; a
            // larger delay makes the platform timer fire after one millisecond.
            delay = Math.min(Math.max(slot - nowMs, 0), MAX_TIMER_DELAY_MS);
            break;
        }
        date = addDays(date, 1);
    }
    return delay;
}
/**
 * First local date the schedule may still act on.
 *
 * Today is pending until a run is recorded for it. When the record names today
 * or a later date - the clock moved back behind it - the next date is the day
 * after the later of the two, so a recorded date is never armed again.
 * @param today - Zone-local calendar date of the current instant.
 * @param lastScheduledDate - Stored date key, or `null` when none is recorded.
 * @returns The earliest date that can carry the next run.
 */
function firstPendingDate(today, lastScheduledDate) {
    const todayKey = formatLocalDate(today);
    if (lastScheduledDate === null || lastScheduledDate < todayKey)
        return today;
    const recorded = lastScheduledDate > todayKey ? parseLocalDate(lastScheduledDate) : today;
    return addDays(recorded, 1);
}
/**
 * Read a stored local date key back into its calendar date.
 * @param dateKey - Date as `YYYY-MM-DD`.
 * @returns The calendar date the key spells.
 */
function parseLocalDate(dateKey) {
    return {
        year: Number(dateKey.slice(0, 4)),
        month: Number(dateKey.slice(5, 7)),
        day: Number(dateKey.slice(8, 10)),
    };
}
/**
 * Resolve the schedule zone once, so an unusable name fails as a sleep failure
 * instead of as an `Intl` range error.
 * @param timeZone - Zone text from the plugin row.
 * @returns The canonical IANA zone.
 * @throws SleepError with code `SLEEP_CONFIG_INVALID` when the name is not a zone the platform knows.
 */
function scheduleZone(timeZone) {
    const resolved = canonicalizeTimeZone(timeZone);
    if (resolved.kind === 'rejected') {
        throw invalidConfigError('timeZone', `expected an IANA zone, received ${JSON.stringify(timeZone)} (${resolved.reason})`);
    }
    return resolved.timeZone;
}
/**
 * Project one instant onto its local calendar date in an explicit zone.
 * @param ms - Instant in epoch milliseconds.
 * @param timeZone - Canonical IANA zone.
 * @returns The zone-local calendar date.
 */
function localCalendarDate(ms, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(ms);
    const fields = {};
    for (const part of parts)
        fields[part.type] = part.value;
    return { year: Number(fields['year']), month: Number(fields['month']), day: Number(fields['day']) };
}
/**
 * Render one local calendar date as the stored date key.
 * @param date - Zone-local calendar date.
 * @returns The date as `YYYY-MM-DD`.
 */
function formatLocalDate(date) {
    const year = String(date.year).padStart(4, '0');
    const month = String(date.month).padStart(2, '0');
    const day = String(date.day).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
/**
 * Shift one local calendar date by whole days.
 * @param date - Zone-local calendar date.
 * @param days - Number of days to add; a negative value moves back.
 * @returns The shifted calendar date.
 */
function addDays(date, days) {
    const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}
/**
 * Resolve the daily slot on one local date.
 * @param date - Zone-local calendar date.
 * @param daily - Clock fields of the slot.
 * @param timeZone - Canonical IANA zone.
 * @returns The slot instant in epoch milliseconds, or `undefined` when the zone does not have that wall-clock time.
 */
function slotInstant(date, daily, timeZone) {
    const local = {
        year: date.year,
        month: date.month,
        day: date.day,
        hour: daily.hour,
        minute: daily.minute,
        second: 0,
        millisecond: 0,
    };
    return resolveLocalInstant(local, timeZone);
}
//# sourceMappingURL=schedule-math.js.map