/**
 * Configuration contract of the daily sleep plugin.
 *
 * The Cordis row supplies a partially defaulted {@link Config}; {@link resolveConfig}
 * turns it into the runtime values every other module reads. Time, zone, the
 * notes directory, byte limits, and the two identity names are normalized once
 * here, so no consumer repeats a default or re-validates a value.
 * @module @deepseek-ai/dsh-sleep/config
 */
import { resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { canonicalizeTimeZone } from '@deepseek-ai/dsh-util-time';
import { invalidConfigError } from "./errors.js";
import { parseDailyTime } from "./schedule-math.js";
/** Scheduled runs are enabled unless the row disables them. */
const DEFAULT_ENABLED = true;
/** Fallback daily slot, written to the same `HH:mm` form the row accepts. */
const DEFAULT_TIME = '03:00';
/** One new non-sleep Session is enough evidence that the day holds something to reflect on. */
const DEFAULT_MIN_SESSIONS = 1;
/** Note texts loaded into a working Session start here; 16 KiB keeps the injected block small. */
const DEFAULT_INJECT_MAX_BYTES = 16_384;
/** Ceiling for one note read, matching the workspace instruction loader's per-file cap. */
const DEFAULT_MAX_SOURCE_BYTES = 1_048_576;
/**
 * Bytes of note content one injection pass may read to classify notes as text
 * or binary. The pass drops a note it cannot classify within the budget, so a
 * large notes tree cannot stall a step.
 */
const DEFAULT_INSPECT_MAX_BYTES = 4_194_304;
/**
 * Directory entries one injection pass may examine while it lists the notes
 * tree. The walk stops when the count is spent, so many small notes cost the
 * same bounded work as a few large ones.
 */
const DEFAULT_INSPECT_MAX_ENTRIES = 1_024;
/** Preset name the shipped `cordis.patch.yml` composes. */
const DEFAULT_PRESET_ID = 'sleep';
/** Highest reasoning effort the sleep Session requests. */
const DEFAULT_REASONING_EFFORT = 'max';
/** Zone used when neither the row nor the host names a usable IANA zone. */
const FALLBACK_TIME_ZONE = 'UTC';
/** Loader-validated sleep row; defaults are applied again by {@link resolveConfig}. */
export const Config = z.object({
    dir: z.string().required(),
    enabled: z.boolean().default(DEFAULT_ENABLED),
    time: z.string().default(DEFAULT_TIME),
    timeZone: z.string(),
    minSessions: z.number().step(1).min(0).default(DEFAULT_MIN_SESSIONS),
    injectMaxBytes: z.number().step(1).min(1).default(DEFAULT_INJECT_MAX_BYTES),
    maxSourceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_BYTES),
    inspectMaxBytes: z.number().step(1).min(1).default(DEFAULT_INSPECT_MAX_BYTES),
    inspectMaxEntries: z.number().step(1).min(1).default(DEFAULT_INSPECT_MAX_ENTRIES),
    presetId: z.string().default(DEFAULT_PRESET_ID),
    reasoningEffort: z.string().default(DEFAULT_REASONING_EFFORT),
});
/**
 * Normalize the plugin row into runtime values.
 *
 * Defaults apply to omitted fields only. A configured value that violates the
 * contract fails here instead of degrading later, so a bad `time` or a
 * misspelled zone stops the plugin at load.
 * @param config - Plugin row after loader validation.
 * @param options - Host zone used when the row leaves `timeZone` blank.
 * @returns Every field required, with `timeZone` canonical.
 * @throws SleepError with code `SLEEP_CONFIG_INVALID` when a value cannot be used.
 */
export function resolveConfig(config, options = {}) {
    return {
        dir: resolveDir(config.dir),
        enabled: config.enabled ?? DEFAULT_ENABLED,
        time: resolveTime(config.time),
        timeZone: resolveTimeZone(config.timeZone, options.hostTimeZone),
        minSessions: resolveInteger(config.minSessions, DEFAULT_MIN_SESSIONS, 'minSessions', 0),
        injectMaxBytes: resolveInteger(config.injectMaxBytes, DEFAULT_INJECT_MAX_BYTES, 'injectMaxBytes', 1),
        maxSourceBytes: resolveInteger(config.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES, 'maxSourceBytes', 1),
        inspectMaxBytes: resolveInteger(config.inspectMaxBytes, DEFAULT_INSPECT_MAX_BYTES, 'inspectMaxBytes', 1),
        inspectMaxEntries: resolveInteger(config.inspectMaxEntries, DEFAULT_INSPECT_MAX_ENTRIES, 'inspectMaxEntries', 1),
        presetId: resolveName(config.presetId, DEFAULT_PRESET_ID, 'presetId'),
        reasoningEffort: resolveName(config.reasoningEffort, DEFAULT_REASONING_EFFORT, 'reasoningEffort'),
    };
}
/**
 * Read the note directory.
 * @param value - Configured directory text.
 * @returns The directory as an absolute path.
 * @throws SleepError when the text is empty.
 */
function resolveDir(value) {
    const dir = value.trim();
    if (dir === '')
        throw invalidConfigError('dir', 'must name the directory that holds the sleep notes');
    return resolve(dir);
}
/**
 * Read the daily slot.
 * @param value - Configured `HH:mm` text, or `undefined` to take the default.
 * @returns The slot in zero-padded `HH:mm` form.
 * @throws SleepError when the text is not a 24-hour clock time.
 */
function resolveTime(value) {
    const time = (value ?? DEFAULT_TIME).trim();
    // The timer parses this slot on every tick; requiring that parse to succeed
    // here keeps one accepted spelling for the loader and the schedule.
    parseDailyTime(time);
    return time;
}
/**
 * Read the schedule zone.
 *
 * A configured zone must canonicalize, because the stored schedule and every
 * later comparison depend on one spelling. The host zone is only a
 * convenience, so an unusable host value degrades to `UTC` instead of failing.
 * @param configured - Configured zone text, or `undefined` when the row omits it.
 * @param hostTimeZone - Zone the running host reports.
 * @returns The canonical zone, or `UTC` when nothing usable is configured.
 * @throws SleepError when a configured zone is not a known IANA zone.
 */
function resolveTimeZone(configured, hostTimeZone) {
    const explicit = configured?.trim() ?? '';
    if (explicit !== '') {
        const resolved = canonicalizeTimeZone(explicit);
        if (resolved.kind === 'rejected') {
            throw invalidConfigError('timeZone', `expected an IANA zone or UTC, received ${JSON.stringify(explicit)} (${resolved.reason})`);
        }
        return resolved.timeZone;
    }
    const host = hostTimeZone?.trim() ?? '';
    if (host !== '') {
        const resolved = canonicalizeTimeZone(host);
        if (resolved.kind === 'accepted')
            return resolved.timeZone;
    }
    return FALLBACK_TIME_ZONE;
}
/**
 * Read one integer bound with a lower limit.
 * @param value - Configured value, or `undefined` to take the default.
 * @param fallback - Default applied to an omitted field.
 * @param field - Field name used in the diagnostic.
 * @param minimum - Smallest accepted value.
 * @returns The configured or default value.
 * @throws SleepError when the value is not an integer of at least `minimum`.
 */
function resolveInteger(value, fallback, field, minimum) {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < minimum) {
        throw invalidConfigError(field, `expected an integer of at least ${minimum}, received ${String(value)}`);
    }
    return resolved;
}
/**
 * Read one required non-empty name.
 * @param value - Configured text, or `undefined` to take the default.
 * @param fallback - Default applied to an omitted field.
 * @param field - Field name used in the diagnostic.
 * @returns The trimmed name.
 * @throws SleepError when the configured text is empty.
 */
function resolveName(value, fallback, field) {
    const name = (value ?? fallback).trim();
    if (name === '')
        throw invalidConfigError(field, 'must not be empty');
    return name;
}
//# sourceMappingURL=config.js.map