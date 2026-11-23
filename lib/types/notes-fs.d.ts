/**
 * Filesystem of the sleep notes directory.
 *
 * Every operation takes a note path from a model tool argument and refuses
 * anything that canonicalizes outside the notes directory: a `..` segment or a
 * NUL byte is refused before the filesystem is touched, and containment is
 * checked on the `realpath` of the nearest existing ancestor, so a symbolic
 * link inside the tree cannot redirect a read, write, move, or delete to
 * another location.
 *
 * The canonical path is checked again immediately before each filesystem call,
 * and a path that now resolves elsewhere is refused. A read also proves that the
 * opened file is the file that check described, so an ancestor swapped for a
 * symbolic link after the check is detected instead of followed. Node has no
 * descriptor-relative operation, so a directory swapped inside the remaining gap
 * between that check and the call is not preventable, and a platform that
 * reports no file identity cannot prove the opened file at all; reads
 * additionally refuse a final symbolic link through `O_NOFOLLOW` where the
 * platform provides it. The residual race is documented in the package README.
 *
 * A note path is split on the separators the host filesystem uses: a backslash
 * names a directory on Windows and is an ordinary character in a POSIX filename,
 * so the two are not interchangeable.
 *
 * A symbolic link that stays inside the notes directory is a listed entry, so a
 * move or a delete acts on that entry rather than on the note the link points
 * at, and deleting a duplicate listing cannot destroy the note it duplicates.
 * For the same reason, a recursive delete never reports the note a removed link
 * named among the notes it removed. A relative link is read from the directory
 * that holds it, and the text is resolved in the order the operating system
 * resolves it, so a move is refused when the new directory would leave it naming
 * another path or no path at all, instead of placing such a link. For the same
 * reason, a move refuses a link whose text would resolve through the entry it
 * replaces: that entry would hold the link and become part of its own
 * resolution. A move also refuses a link whose text resolves through the entry
 * it leaves, because that text names no note once the link moved from that path.
 *
 * A recursive delete waits for every removal it starts before it returns or
 * fails, and it starts them one at a time so a wide tree cannot exhaust the
 * process's file descriptors. It proves each entry again immediately before it
 * opens or removes it, and it proves the emptied directory again before it
 * removes that too, so a directory replaced by a symbolic link during the walk is
 * refused instead of followed. A removal that fails reports that the
 * deletion may be partial: the next sleep run starts when the call returns, so
 * no removal may still run beside it.
 *
 * A move reads the note it reports before the rename and before the last check
 * of both paths: a rename cannot be undone, so a failure afterwards must not
 * report a move that already happened as a failed one, and no await may separate
 * the checks from the rename. The new name stays as the caller spelled it, so a
 * host that compares names without case still renames the entry.
 *
 * A note is UTF-8 text. A file holding a NUL byte or bytes that are not valid
 * UTF-8 is reported as not text instead of decoded, and a write of text with a
 * NUL byte is refused so it cannot turn a readable note into a binary one.
 *
 * Writes go through `writeFileAtomic`, so a reader observes either the previous
 * note or the complete new text.
 * @module @deepseek-ai/dsh-sleep/notes-fs
 */
/** One note file inside the notes directory. */
export interface NoteEntry {
    /** Path relative to the notes directory, with `/` separators. */
    readonly path: string;
    /** Size on disk in bytes. */
    readonly bytes: number;
    /** Last modification time in epoch milliseconds. */
    readonly mtimeMs: number;
}
/** One note whose text the memory injection pass carries. */
export interface IncludedNote extends NoteEntry {
    /** UTF-8 text of the note, or its prefix when the byte cap cut it. */
    readonly text: string;
    /** Whether the per-note byte cap cut the text before its end. */
    readonly truncated: boolean;
}
/** Result of one scan of the notes directory for the memory injection pass. */
export interface CollectedNotes {
    /** Notes whose rendered block fits the injection budget, in path order. */
    readonly included: readonly IncludedNote[];
    /** Text notes left out of the text block, in path order. */
    readonly remaining: readonly NoteEntry[];
    /**
     * Why the pass examined only part of the notes tree, so notes it never read
     * appear in neither list; absent when the pass saw the whole tree.
     */
    readonly partial?: PartialCause;
}
/**
 * Budget that stopped one bounded injection pass before it examined the whole
 * notes tree.
 */
export type PartialCause = 
/** The walk examined `inspectMaxEntries` directory entries. */
'entries'
/** The pass read `inspectMaxBytes` of note content to classify notes. */
 | 'bytes';
/** Limits one injection pass applies. */
export interface NoteInjectionBudget {
    /** Maximum UTF-8 bytes the pass carries altogether, headings and paths included. */
    readonly injectMaxBytes: number;
    /** Maximum UTF-8 bytes read from one note. */
    readonly maxSourceBytes: number;
    /** Maximum UTF-8 bytes the pass reads altogether to classify notes as text or binary. */
    readonly inspectMaxBytes: number;
    /** Maximum directory entries the pass examines altogether while it lists the tree. */
    readonly inspectMaxEntries: number;
    /**
     * UTF-8 bytes one carried note adds to the block besides its path and text:
     * its heading, the line break, the separator to the previous block, and the
     * marker a cut note carries.
     */
    readonly headingBytes: number;
}
/** Limits one note write applies. */
export interface NoteWriteOptions {
    /** Maximum UTF-8 bytes the written text may hold. */
    readonly maxBytes: number;
}
/** Line window one note read returns. */
export interface NoteReadOptions {
    /** 1-based number of the first line to return. Defaults to 1. */
    readonly offset?: number;
    /** Maximum number of lines to return. Defaults to every line through the end. */
    readonly limit?: number;
    /** Maximum bytes read from the note; the text stops at that byte. */
    readonly maxBytes: number;
}
/** One note read, ready for a tool result. */
export interface NoteText {
    /** Path relative to the notes directory, with `/` separators. */
    readonly path: string;
    /** Selected lines joined with a newline. */
    readonly text: string;
    /** 1-based number of the first returned line. */
    readonly offset: number;
    /** Number of lines the loaded part of the note holds; a truncated note holds fewer than the file. */
    readonly total: number;
    /** Number of lines the returned window holds. */
    readonly shown: number;
    /** Whether the returned window reaches the last line. */
    readonly eof: boolean;
    /** Whether the byte cap cut the note before its last line. */
    readonly truncated: boolean;
}
/** One deleted note. */
export interface DeletedNote {
    /** Path relative to the notes directory, with `/` separators. */
    readonly path: string;
    /** Whether the removed entry was a file, a directory, or a symbolic link. */
    readonly kind: 'file' | 'directory' | 'link';
    /** Number of note files removed with the path; a removed symbolic link is not a note file. */
    readonly removedFiles: number;
    /** Total size in bytes of the removed note files; a removed symbolic link adds none. */
    readonly removedBytes: number;
    /** Removed note paths in path order, up to {@link DELETED_PATHS_LIMIT}. */
    readonly removedPaths: readonly string[];
    /** Number of removed notes whose path is not listed in {@link DeletedNote.removedPaths}. */
    readonly omittedPaths: number;
}
/** One note moved to a new path. */
export interface MovedNote extends NoteEntry {
    /** Whether a note already at the new path was replaced. */
    readonly replaced: boolean;
}
/**
 * One note written to disk.
 *
 * The write lands before the modification time is read, so a metadata read that
 * fails leaves {@link WrittenNote.mtimeMs} absent instead of reporting the
 * committed write as failed.
 */
export interface WrittenNote {
    /** Path relative to the notes directory, with `/` separators. */
    readonly path: string;
    /** Bytes the write put on disk. */
    readonly bytes: number;
    /** Last modification time in epoch milliseconds, or `undefined` when it cannot be read. */
    readonly mtimeMs?: number;
}
/**
 * List every note file under the notes directory.
 *
 * A directory that does not exist has no notes. Directories are entered, plain
 * files are listed, and a symbolic link is listed only when it resolves to a
 * regular file inside the directory. Each subdirectory is proved again
 * immediately before it is opened, so a directory replaced by a link after it
 * was listed is skipped instead of entered. The result is ordered by path, which
 * keeps the memory injection deterministic.
 * @param rootDir - Configured notes directory.
 * @returns The notes found, ordered by path.
 * @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when the directory cannot be read.
 */
export declare function listNotes(rootDir: string): Promise<NoteEntry[]>;
/**
 * Read one note, optionally a line window of it.
 *
 * At most `maxBytes` are read, so an oversized note cannot exhaust memory; a
 * note cut by that cap reports `truncated` and never reaches `eof`.
 * @param rootDir - Configured notes directory.
 * @param notePath - Note path relative to the directory, or an absolute path inside it.
 * @param options - Line window and byte cap.
 * @returns The requested note window.
 * @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path leaves the
 * directory, or `SLEEP_NOTE_UNAVAILABLE` when the note is absent, unreadable,
 * or not UTF-8 text.
 */
export declare function readNote(rootDir: string, notePath: string, options: NoteReadOptions): Promise<NoteText>;
/**
 * Write one note, creating the note and its directories.
 *
 * An existing note of that path is replaced in one atomic step. Text above
 * `maxBytes` is refused before the file is touched, so a note cannot grow past
 * the byte cap later reads and injections rely on. The written bytes are
 * reported even when the modification time cannot be read back afterwards.
 * @param rootDir - Configured notes directory, created when it does not exist.
 * @param notePath - Note path relative to the directory, or an absolute path inside it.
 * @param text - Complete next content of the note.
 * @param options - Byte limit of the written text.
 * @returns The written note.
 * @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path leaves the
 * directory, or `SLEEP_NOTE_UNAVAILABLE` when the text exceeds the byte limit
 * or the file cannot be written.
 */
export declare function writeNote(rootDir: string, notePath: string, text: string, options: NoteWriteOptions): Promise<WrittenNote>;
/**
 * Move or rename one note, creating the directories of its new path.
 *
 * A path that names a symbolic link moves the link entry, not the note the link
 * resolves to, so the note keeps its own location and the moved link still names
 * it; a link whose text would stop resolving to that note from the new directory,
 * or would resolve through the new path itself, is refused, because `rename`
 * moves the link text verbatim. An existing entry at
 * the new path is replaced, and the result says so, because the replaced note or
 * link is gone; a new path that names the entry the note already occupies
 * replaces nothing. The note is described before the rename, so a completed move
 * is never reported as a failure.
 * @param rootDir - Configured notes directory.
 * @param fromPath - Current note path.
 * @param toPath - New note path.
 * @returns The note at its new path, with whether it replaced one there.
 * @throws SleepError with code `SLEEP_PATH_UNSAFE` when either path leaves the
 * directory, or `SLEEP_NOTE_UNAVAILABLE` when the note cannot be moved.
 */
export declare function moveNote(rootDir: string, fromPath: string, toPath: string): Promise<MovedNote>;
/**
 * Delete one note or one directory of notes.
 *
 * A directory is removed with everything under it, and the result reports how
 * many note files and bytes went with it, so the caller sees the blast radius of
 * one delete call. Every removal the call starts settles before it returns or
 * fails, because the next sleep run starts when the call returns and must not
 * share the notes directory with removals that are still running; a removal that
 * fails reports that the deletion may be partial. The removals run one at a
 * time, and each entry is proved again immediately before it is opened or
 * removed, so a wide tree cannot exhaust descriptors and a parent swapped for a
 * symbolic link during the walk cannot redirect a removal. A symbolic link is
 * removed as the link it is: the path it resolves to names the note the link
 * points at, so removing that path would delete the note and leave the link
 * dangling. For the same reason, a link inside a removed directory is not
 * reported among the removed notes, and the bytes of the note it names are not
 * counted.
 * @param rootDir - Configured notes directory.
 * @param notePath - Note path relative to the directory, or an absolute path inside it.
 * @returns The removed path, its kind, and the entries removed with it.
 * @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path leaves the
 * directory, or `SLEEP_NOTE_UNAVAILABLE` when the note cannot be deleted.
 */
export declare function deleteNote(rootDir: string, notePath: string): Promise<DeletedNote>;
/**
 * Scan the notes directory for the memory injection pass.
 *
 * Text notes are collected in path order until the rendered block reaches
 * `injectMaxBytes`; the budget charges each carried note's heading and path as
 * well as its text. Text notes that do not fit are listed by path and size
 * instead. The pass reads to classify, so it bounds that work twice over: at
 * most `inspectMaxBytes` of note content, and at most `inspectMaxEntries`
 * directory entries examined by the walk, which stops when that count is spent. A note
 * neither read nor listed appears in neither list, so the pass never offers the
 * model a note it cannot open, and {@link CollectedNotes.partial} names the
 * budget that stopped it examining the whole tree.
 *
 * The scan and the read are separate steps, so each note is resolved again
 * immediately before it is read: a directory swapped for a symbolic link after
 * the walk cannot redirect a read outside the directory. The read itself is
 * capped by what is left of the inspection budget, and the pass charges the
 * bytes it actually read, so a note that grew after the scan cannot make it
 * read past `inspectMaxBytes`.
 * @param rootDir - Configured notes directory.
 * @param budget - Text, per-note, inspection-byte, and inspection-entry limits of the pass.
 * @returns The notes to embed, the ones to list, and why the pass stayed partial.
 * @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when the directory cannot be read.
 */
export declare function collectNotesForInjection(rootDir: string, budget: NoteInjectionBudget): Promise<CollectedNotes>;
/**
 * Create the notes directory when it is missing and read its canonical spelling.
 *
 * The directories are created with user-only permissions, so other local users
 * cannot list note names where the platform enforces modes. An existing
 * directory keeps the mode it has: this operation creates, and never changes
 * permissions of, a directory the user already owns.
 * @param rootDir - Configured notes directory.
 * @returns The canonical directory.
 * @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when the directory cannot be created or resolved.
 */
export declare function ensureNotesDirectory(rootDir: string): Promise<string>;
/**
 * Order two note paths.
 *
 * The order is by Unicode code unit, which is total: two distinct paths never
 * compare equal. A collation order cannot page a listing, because
 * `localeCompare` reports two canonically equivalent spellings as equal and
 * depends on the runtime locale, so a page cursor compared with it would drop
 * the note on the other side of that tie.
 * @param left - First note path.
 * @param right - Second note path.
 * @returns A negative number when the first path sorts first, `0` for the same path, or a positive number.
 */
export declare function compareNotePaths(left: string, right: string): number;
//# sourceMappingURL=notes-fs.d.ts.map