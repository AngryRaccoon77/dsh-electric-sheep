/**
 * Configuration contract of the daily sleep plugin.
 *
 * The Cordis row supplies a partially defaulted {@link Config}; {@link resolveConfig}
 * turns it into the runtime values every other module reads. Time, zone, the
 * notes directory, byte limits, and the two identity names are normalized once
 * here, so no consumer repeats a default or re-validates a value.
 * @module @deepseek-ai/dsh-sleep/config
 */
import z from '@deepseek-ai/schemastery';
/**
 * Sleep plugin row.
 *
 * Fields carrying a default are optional in the row and required in
 * {@link ResolvedConfig}; `dir` stays required because only the composition
 * knows where the user's notes live.
 */
export interface Config {
    /**
     * Directory that holds the sleep notes. The shipped patch sets it to
     * `dshHomePath('sleep')`. {@link resolveConfig} resolves the value against
     * the process working directory, so every consumer reads one absolute path.
     */
    dir: string;
    /**
     * Whether the daily slot may start a sleep run on its own. Manual `/sleep`
     * runs regardless of this flag. Default `true`.
     */
    enabled?: boolean;
    /**
     * Wall-clock slot the daily run follows, as `HH:mm` in {@link Config.timeZone}.
     * Default `'03:00'`.
     */
    time?: string;
    /**
     * IANA zone the daily slot follows. A blank value uses `hostTimeZone`, then
     * `UTC`. An explicitly configured name that is not a known zone fails at load.
     */
    timeZone?: string;
    /**
     * Non-sleep Sessions with activity newer than the last completed sleep that a
     * scheduled run requires. `0` always runs. Default `1`.
     */
    minSessions?: number;
    /**
     * Maximum UTF-8 bytes the notes block carries inline, counting each note's
     * heading and path as well as its text; further notes are listed by path
     * instead. Default `16384`.
     */
    injectMaxBytes?: number;
    /**
     * Maximum UTF-8 bytes read from one note file, so an oversized note cannot
     * exhaust memory. Default `1048576`.
     */
    maxSourceBytes?: number;
    /**
     * Maximum bytes of note content one injection pass reads to classify notes as
     * text or binary. The pass leaves out a note whose bytes the budget cannot
     * cover, and the block says the listing is partial. Default `4194304`.
     */
    inspectMaxBytes?: number;
    /**
     * Maximum directory entries one injection pass examines while it lists the
     * notes tree, directories included. Once the count is spent the walk stops,
     * and the block says the listing is partial. Default `1024`.
     */
    inspectMaxEntries?: number;
    /**
     * Agent preset mounted for the sleep Session, which must match the
     * `preset-sleep` row of `cordis.patch.yml`. Default `'sleep'`.
     */
    presetId?: string;
    /**
     * Reasoning effort selected for the sleep Session model before its first
     * request. Working Sessions keep the user's own selection. Default `'max'`.
     */
    reasoningEffort?: string;
}
/** Loader-validated sleep row; defaults are applied again by {@link resolveConfig}. */
export declare const Config: z<Config>;
/** Fully resolved sleep configuration every runtime module reads. */
export type ResolvedConfig = Required<Config>;
/** Host facts {@link resolveConfig} cannot read from the plugin row. */
export interface ResolveConfigOptions {
    /**
     * IANA zone the running host reports, such as
     * `Intl.DateTimeFormat().resolvedOptions().timeZone`. It applies only when
     * the row leaves `timeZone` blank; an unusable value falls back to `UTC`.
     */
    readonly hostTimeZone?: string | undefined;
}
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
export declare function resolveConfig(config: Config, options?: ResolveConfigOptions): ResolvedConfig;
//# sourceMappingURL=config.d.ts.map