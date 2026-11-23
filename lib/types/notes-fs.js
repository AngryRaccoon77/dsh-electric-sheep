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
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, readlink, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { SleepError, noteUnavailableError, unsafePathError } from "./errors.js";
import { escapeFrameBody } from "./frame.js";
/** Permission bits of a note file: notes are private user data. */
const NOTE_FILE_MODE = 0o600;
/** Permission bits of a note directory, for the same reason. */
const NOTE_DIR_MODE = 0o700;
/** A NUL byte cannot name a file, and its presence alone marks a note as binary. */
const NUL_BYTE = 0;
/** The same NUL byte as note text, which a write must refuse. */
const NUL_CHARACTER = '\u0000';
/**
 * `O_NOFOLLOW` where the platform defines it, and `0` where it has no such
 * flag, as on Windows.
 */
/* v8 ignore next -- `O_NOFOLLOW` exists on one platform only, so one arm is unreachable on every host */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
/**
 * Open flags of a note read: `O_NOFOLLOW` refuses a symbolic link at the final
 * path element, so a target swapped after the canonical check cannot redirect
 * the read. Windows has no such flag, so the read there falls back to a plain
 * open and the check before it is the only defence.
 */
const NOTE_READ_FLAGS = constants.O_RDONLY | O_NOFOLLOW;
/** Path segment that leaves the notes directory. */
const PARENT_SEGMENT = '..';
/** Path segment that names the directory it sits in. */
const CURRENT_SEGMENT = '.';
/**
 * Separators that split one note path.
 *
 * A backslash separates directories on Windows, so both spellings name the same
 * note there. POSIX treats a backslash as an ordinary filename character, so
 * splitting on it would address a different note than the one the scan lists.
 */
/* v8 ignore next -- the separator set is fixed per platform, so one arm never runs on a given host */
const PATH_SEPARATOR = process.platform === 'win32' ? /[\\/]/u : /\//u;
/** One trailing line terminator closes the last line instead of opening another. */
const TRAILING_LINE_BREAK = /\r?\n$/u;
/** Line separator of note text. */
const LINE_BREAK = /\r?\n/u;
/** Encoding every note is read and written as. */
const NOTE_ENCODING = 'utf8';
/** Most symbolic links one target chain may hold before the walk stops. */
const MAX_LINK_DEPTH = 40;
/** Most removed note paths one deletion reports, so a removed tree stays a bounded result. */
const DELETED_PATHS_LIMIT = 20;
/** Empty injection collection, shared by every missing notes directory. */
const NO_NOTES = Object.freeze({ included: [], remaining: [] });
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
export async function listNotes(rootDir) {
    const root = await existingRoot(rootDir);
    if (root === undefined)
        return [];
    return await scanNotes(root, '');
}
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
export async function readNote(rootDir, notePath, options) {
    const root = await requiredRoot(rootDir);
    const target = await confinedTarget(root, notePath);
    // A window read charges no inspection budget, so the counter this reader
    // requires stays local to the call.
    const loaded = await loadNote(await confirmedTarget(root, target), options.maxBytes, { read: 0 });
    if (loaded.text === undefined)
        throw noteUnavailableError(target.path, 'not UTF-8 text');
    const lines = splitLines(loaded.text);
    const offset = options.offset ?? 1;
    const limit = options.limit ?? lines.length;
    const window = lines.slice(offset - 1, offset - 1 + limit);
    return {
        path: target.path,
        text: window.join('\n'),
        offset,
        total: lines.length,
        shown: window.length,
        eof: !loaded.truncated && offset - 1 + window.length >= lines.length,
        truncated: loaded.truncated,
    };
}
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
export async function writeNote(rootDir, notePath, text, options) {
    const bytes = Buffer.byteLength(text, NOTE_ENCODING);
    if (text.includes(NUL_CHARACTER)) {
        throw noteUnavailableError(notePath, 'would not be readable text because it contains a NUL byte');
    }
    const root = await ensureNotesDirectory(rootDir);
    const target = await confinedTarget(root, notePath);
    if (bytes > options.maxBytes) {
        throw noteUnavailableError(notePath, `would hold ${bytes} bytes, above the ${options.maxBytes} byte note limit`);
    }
    try {
        await writeFileAtomic((await confirmedTarget(root, target)).target, text, { mode: NOTE_FILE_MODE, dirMode: NOTE_DIR_MODE });
    }
    catch (error) {
        throw noteFailure(notePath, 'write', error);
    }
    // The replacement already landed: a metadata read that fails now reports the
    // write without a time instead of reporting the note as unwritten.
    return { path: target.path, bytes, ...await writtenMtime(target) };
}
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
export async function moveNote(rootDir, fromPath, toPath) {
    const root = await requiredRoot(rootDir);
    const sourceLink = await namedLink(root, fromPath);
    const destinationLink = await namedLink(root, toPath);
    let sourceEntry;
    let sourcePath;
    if (sourceLink === undefined) {
        const source = await confinedTarget(root, fromPath);
        sourceEntry = source.target;
        sourcePath = source.path;
    }
    else {
        sourceEntry = sourceLink.entry;
        sourcePath = sourceLink.path;
    }
    let destinationEntry;
    let destinationPath;
    if (destinationLink === undefined) {
        const destination = await confinedDestination(root, toPath);
        destinationEntry = destination.target;
        destinationPath = destination.path;
        // Renaming a link onto the note it names would replace that note with the
        // link and leave the link pointing at itself.
        if (sourceLink !== undefined && samePath(destinationEntry, sourceLink.target)) {
            throw noteUnavailableError(fromPath, 'would replace the note its link names');
        }
    }
    else {
        destinationEntry = destinationLink.entry;
        destinationPath = destinationLink.path;
    }
    try {
        // A link keeps its own text, so the move is refused before it touches either
        // path when that text would stop naming the same note from the new directory.
        if (sourceLink !== undefined) {
            const problem = await movedLinkProblem(sourceLink, destinationEntry);
            if (problem !== undefined) {
                throw noteUnavailableError(fromPath, `${problem}, so ${destinationPath} would name no note`);
            }
        }
        // Prove the destination still resolves inside the notes directory before
        // creating any of its directories: `mkdir` follows every ancestor of the
        // path it is given, so a parent swapped for a symbolic link in the gap would
        // otherwise create directories outside the tree.
        await confirmedDestination(root, destinationEntry, destinationPath, destinationLink !== undefined);
        await mkdir(dirname(destinationEntry), { recursive: true, mode: NOTE_DIR_MODE });
        // The destination's existence is read before the last check of both paths:
        // the `stat` that answers it is an await, and a path re-checked before it
        // would be stale by the time `rename` runs. A destination that names the
        // entry the note already occupies replaces nothing, so it is not counted as
        // a replacement.
        const replaced = !samePath(destinationEntry, sourceEntry) && await noteExists(destinationEntry);
        // The note is described before the last check of both paths. A rename
        // changes neither its bytes nor its modification time, so the description is
        // as accurate as one taken afterwards, while no await is left between the
        // checks and the rename.
        const described = await describeNote({ target: sourceEntry, path: destinationPath });
        const checkedSource = await confirmedEntry(root, sourceEntry, sourcePath, sourceLink !== undefined);
        const checkedDestination = await confirmedDestination(root, destinationEntry, destinationPath, destinationLink !== undefined);
        await rename(checkedSource, checkedDestination);
        return { ...described, replaced };
    }
    catch (error) {
        throw noteFailure(fromPath, 'move', error);
    }
}
/**
 * Why moving one symbolic link would leave it naming no note.
 *
 * A symbolic link keeps its text, and that text is read from the directory that
 * holds the link, so the move changes what the text resolves to. A text that
 * reaches the destination entry would resolve through the moved link itself,
 * which is why such a move is refused. A text that resolves through the entry
 * the rename removes would stop resolving at all, because the old path is gone
 * once the link moved; both checks therefore run while the move can still be
 * refused. A relative text can also name another path from the new directory,
 * and that path is the one the operating system resolves: every link on the way
 * is followed before a `..` segment climbs. An absolute text names its note
 * wherever the link goes.
 * @param link - Link the caller named.
 * @param destinationEntry - Absolute path the link would move to.
 * @returns Why the move would leave the link naming no note, or `undefined` when it keeps naming its note.
 * @throws The filesystem failure that stopped a resolution.
 */
async function movedLinkProblem(link, destinationEntry) {
    const text = await readlink(link.entry);
    const directory = dirname(destinationEntry);
    if (await resolutionVisits(directory, text, destinationEntry)) {
        return 'names a symbolic link whose target resolves through its new path';
    }
    if (await resolutionVisits(directory, text, link.entry)) {
        return 'names a symbolic link whose target resolves through the entry it leaves';
    }
    if (directory === dirname(link.entry))
        return undefined;
    if (isAbsolute(text))
        return undefined;
    const landing = await landingPath(directory, text);
    return landing === link.target
        ? undefined
        : 'names a relative symbolic link that would not resolve from its new directory';
}
/**
 * Resolve one link text the way the operating system resolves it from a directory.
 *
 * The walk follows every symbolic link it meets, so a `..` segment climbs from the
 * directory the walk has reached rather than from the directory the text is
 * spelled in: a directory link before that segment moves where the text lands.
 * Collapsing the text lexically first would answer a path the operating system
 * never visits.
 * @param fromDir - Canonical directory the text is read from.
 * @param text - Link text.
 * @returns The canonical path the text names, or `undefined` when a segment does
 * not exist or the link depth is spent.
 * @throws The filesystem failure that stopped the walk.
 */
async function landingPath(fromDir, text) {
    const walked = await walkResolution(resolutionBase(fromDir, text), splitPathSegments(text), undefined, MAX_LINK_DEPTH);
    if (walked.landing === undefined)
        return undefined;
    return await realpath(walked.landing);
}
/**
 * Directory one link text is resolved from.
 * @param fromDir - Canonical directory that holds the text.
 * @param text - Link text.
 * @returns The filesystem root for an absolute text, or the holding directory.
 */
function resolutionBase(fromDir, text) {
    return isAbsolute(text) ? parse(text).root : fromDir;
}
/**
 * Whether resolving one link text from a directory visits one entry.
 * @param fromDir - Canonical directory the text is read from.
 * @param text - Link text.
 * @param entry - Absolute path the resolution must not visit.
 * @returns `true` when the text resolves through that entry.
 * @throws The filesystem failure that is not an absent path.
 */
async function resolutionVisits(fromDir, text, entry) {
    const walked = await walkResolution(resolutionBase(fromDir, text), splitPathSegments(text), entry, MAX_LINK_DEPTH);
    return walked.visited;
}
/**
 * Walk one path in the order the operating system resolves it.
 *
 * Each segment is examined in order, and a `..` segment climbs from the
 * directory the walk has reached, not from the directory the text is spelled in:
 * once a symbolic link is followed, that directory is the link's target. A
 * lexical collapse of `..` before the links are followed would erase the
 * segments that pass through the entry, so the walk keeps the operating system's
 * order. Every symbolic link it meets is followed together with the segments
 * that remain after it, because the operating system resolves those from the
 * link's target rather than from the link's own path. A path segment that does
 * not exist ends the walk, and the depth bound stops a chain of links that could
 * never resolve.
 * @param base - Canonical directory the first segment is resolved from.
 * @param segments - Path segments in the order the operating system resolves them.
 * @param entry - Absolute path the walk must not visit, or `undefined` to resolve without that check.
 * @param depth - Symbolic links the walk may still follow.
 * @returns Whether the walk visited that entry, and the canonical path it reached.
 * @throws The filesystem failure that is not an absent path.
 */
async function walkResolution(base, segments, entry, depth) {
    if (depth === 0)
        return { visited: false, landing: undefined };
    let current = base;
    for (const [index, segment] of segments.entries()) {
        if (segment === CURRENT_SEGMENT)
            continue;
        if (segment === PARENT_SEGMENT) {
            current = dirname(current);
            continue;
        }
        current = join(current, segment);
        if (current === entry)
            return { visited: true, landing: undefined };
        let info;
        try {
            info = await lstat(current);
        }
        catch (error) {
            if (errnoCode(error) === 'ENOENT')
                return { visited: false, landing: undefined };
            throw error;
        }
        if (!info.isSymbolicLink())
            continue;
        const text = await readlink(current);
        return await walkResolution(resolutionBase(dirname(current), text), [...splitPathSegments(text), ...segments.slice(index + 1)], entry, depth - 1);
    }
    return { visited: false, landing: current };
}
/**
 * Split one path into the segments it names.
 * @param path - Absolute or relative path.
 * @returns The segments, without the path root and without an empty segment.
 */
function splitPathSegments(path) {
    const root = isAbsolute(path) ? parse(path).root : '';
    return path.slice(root.length).split(sep).filter(segment => segment !== '');
}
/**
 * Prove again, immediately before a filesystem call, that the entry an operation
 * acts on still resolves to the same place.
 *
 * A note path is re-resolved exactly as every other operation does. A named
 * symbolic link is proved through its parent instead, because resolving the link
 * itself would answer its target, which is not the entry being moved.
 * @param root - Canonical notes directory.
 * @param entry - Absolute path of the note or link entry.
 * @param path - Entry path relative to the directory, used in failures.
 * @param link - Whether the entry is a symbolic link rather than a resolved note.
 * @returns The entry path, after resolving it or its parent again.
 * @throws SleepError with code `SLEEP_PATH_UNSAFE` when a note now resolves to a
 * different location, or `SLEEP_NOTE_UNAVAILABLE` when the parent cannot be resolved.
 */
async function confirmedEntry(root, entry, path, link) {
    if (!link)
        return (await confirmedTarget(root, { target: entry, path })).target;
    await confirmedParent(root, entry, path);
    return entry;
}
/**
 * Prove again, immediately before the rename, that the destination still names
 * the entry the move prepared.
 *
 * A destination that names a symbolic link is proved through that entry, exactly
 * as a removal proves the link it removes. A plain path is proved through its
 * parent: its own name is the one the move creates and keeps the spelling the
 * caller asked for, so the parent is what the move acts through.
 * @param root - Canonical notes directory.
 * @param entry - Absolute destination path.
 * @param path - Destination path relative to the directory, used in failures.
 * @param link - Whether the destination names a symbolic link.
 * @returns The destination path, after resolving the entry the move acts through.
 * @throws SleepError with code `SLEEP_PATH_UNSAFE` when the destination now
 * resolves to a different location, or `SLEEP_NOTE_UNAVAILABLE` when it cannot be resolved.
 */
async function confirmedDestination(root, entry, path, link) {
    if (link)
        return await confirmedEntry(root, entry, path, true);
    await confirmedParent(root, entry, path);
    return entry;
}
/**
 * Prove again, immediately before a filesystem call, that the directory an entry
 * lives in still resolves to the same place.
 *
 * A link entry is acted on through its own path, so its parent is what a swapped
 * directory would redirect: resolving the link itself would answer its target,
 * which is not the entry being moved or removed.
 * @param root - Canonical notes directory.
 * @param entry - Absolute path of the entry.
 * @param path - Entry path relative to the directory, used in failures.
 * @throws SleepError with code `SLEEP_PATH_UNSAFE` when the parent now resolves
 * to a different location, or `SLEEP_NOTE_UNAVAILABLE` when it cannot be resolved.
 */
async function confirmedParent(root, entry, path) {
    let parent;
    try {
        parent = await canonicalPath(dirname(entry));
    }
    catch (error) {
        throw noteFailure(path, 'confirm', error);
    }
    if (parent !== dirname(entry) || (parent !== root && !isInside(root, parent))) {
        throw unsafePathError(path, 'resolves to a different path after validation');
    }
}
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
export async function deleteNote(rootDir, notePath) {
    const root = await requiredRoot(rootDir);
    const link = await namedLink(root, notePath);
    if (link !== undefined)
        return await removeNamedLink(link, notePath);
    const target = await confinedTarget(root, notePath);
    let kind = 'file';
    let removed;
    try {
        const checked = await confirmedTarget(root, target);
        const info = await stat(checked.target);
        kind = info.isDirectory() ? 'directory' : 'file';
        removed = kind === 'directory'
            ? await scanRemovedEntries(root, checked.path)
            : [{ path: checked.path, bytes: info.size, kind: 'file' }];
        // The walk above can take a while; a parent swapped for a symbolic link
        // during it must not redirect the recursive removal.
        const failures = await removeEntry(root, (await confirmedTarget(root, checked)).target, checked.path);
        if (failures.length > 0) {
            const first = failures[0];
            throw noteUnavailableError(notePath, `${failures.length} of its entries could not be removed (${first.path}: ${first.code}), `
                + 'so the deletion may be partial');
        }
    }
    catch (error) {
        throw noteFailure(notePath, 'delete', error);
    }
    return {
        path: target.path,
        kind,
        ...deleteSummary(removed),
    };
}
/**
 * Remove one note entry, every entry below it, and nothing else.
 *
 * `fs.rm` starts the removal of every sibling at once and rejects as soon as one
 * of them fails, so a caller that observes the rejection starts the next sleep
 * run while sibling removals are still running. This walk awaits every removal
 * it starts and reports the ones that failed instead, so a failed delete states
 * that it may be partial. It removes one entry at a time, so a wide directory
 * cannot hold a descriptor open for every sibling and drain the process's file
 * descriptors. Each entry is read without following a symbolic link, so a link
 * is removed as the link it is and a directory swapped for a link is not
 * entered, and each entry is proved again immediately before it is opened or
 * removed, because a parent replaced by a symbolic link during the walk would
 * otherwise make the removal act outside the notes directory.
 * @param root - Canonical notes directory.
 * @param entry - Absolute path of the entry to remove.
 * @param entryPath - Entry path relative to the notes directory, used in the report.
 * @returns The entries the walk could not remove, in path order.
 */
async function removeEntry(root, entry, entryPath) {
    let info;
    try {
        info = await lstat(entry);
    }
    catch (error) {
        const code = errnoCode(error);
        return code === 'ENOENT' ? [] : [{ path: entryPath, code }];
    }
    // The walk that listed this tree ran before the removals. A parent replaced by
    // a symbolic link since then would redirect the open or the removal, so the
    // entry is proved again, exactly as every other operation proves its target.
    let checked;
    try {
        checked = await confirmedEntry(root, entry, entryPath, info.isSymbolicLink());
    }
    catch (error) {
        return [{ path: entryPath, code: errnoCode(error) }];
    }
    if (!info.isDirectory()) {
        const problem = await removeOneEntry(checked);
        return problem === undefined ? [] : [{ path: entryPath, code: problem }];
    }
    let names;
    try {
        const handle = await opendir(checked);
        names = [];
        for await (const name of handle)
            names.push(name.name);
    }
    catch (error) {
        return [{ path: entryPath, code: errnoCode(error) }];
    }
    // Every removal runs before any failure is reported: the caller must not start
    // the next run while this one still has removals in flight.
    const failures = [];
    for (const name of names) {
        failures.push(...await removeEntry(root, join(checked, name), `${entryPath}/${name}`));
    }
    // A directory that kept an entry is not empty, so `rmdir` would only restate
    // the failure that kept it.
    if (failures.length === 0) {
        try {
            // The removals above awaited, so the directory is proved again immediately
            // before the call that removes it: a parent swapped for a symbolic link
            // during them would otherwise remove an empty directory outside the notes
            // directory.
            await rmdir(await confirmedEntry(root, entry, entryPath, false));
        }
        catch (error) {
            const code = errnoCode(error);
            if (code !== 'ENOENT')
                failures.push({ path: entryPath, code });
        }
    }
    return failures;
}
/**
 * Remove one file or one symbolic link entry.
 * @param entry - Absolute path of the entry.
 * @returns The errno code that stopped the removal, or `undefined` when the entry is gone.
 */
async function removeOneEntry(entry) {
    try {
        // `rm` on a symbolic link removes the link; it never follows it.
        await rm(entry);
        return undefined;
    }
    catch (error) {
        const code = errnoCode(error);
        return code === 'ENOENT' ? undefined : code;
    }
}
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
export async function collectNotesForInjection(rootDir, budget) {
    const root = await existingRoot(rootDir);
    if (root === undefined)
        return NO_NOTES;
    const included = [];
    const remaining = [];
    const window = { remaining: budget.inspectMaxEntries, stopped: false };
    let includedBytes = 0;
    let inspectedBytes = 0;
    let unclassified = false;
    for (const entry of await scanNotes(root, '', window)) {
        // Classifying a note as text or binary needs its bytes. A note the byte
        // budget cannot cover stays out of both lists: the block offers only the
        // notes the model can open, and `partial` says the card is incomplete.
        const left = budget.inspectMaxBytes - inspectedBytes;
        if (left <= 0) {
            unclassified = true;
            continue;
        }
        // The walk reported a path; a directory replaced by a symbolic link since
        // then would make the read follow it, so the target is proved again here.
        const target = await confirmedScannedNote(root, entry);
        if (target === undefined)
            continue;
        // The read is capped by the per-note limit and by what is left of the
        // inspection budget, so a note that grew after the scan cannot make the
        // pass read past `inspectMaxBytes`.
        const cap = Math.min(budget.maxSourceBytes, left);
        const inspected = await inspectNote(target.target, entry.path, cap);
        // The pass charges the bytes the attempt read, which the read reports even
        // when it failed partway: a note that grew after the scan therefore cannot
        // make the pass read past `inspectMaxBytes`.
        inspectedBytes += inspected.spent;
        const loaded = inspected.note;
        if (loaded === undefined)
            continue;
        // A read the inspection window cut rather than the per-note limit was not
        // fully classified, so it stays out of both lists like any other note the
        // byte budget cannot cover.
        if (loaded.size > cap && cap < budget.maxSourceBytes) {
            unclassified = true;
            continue;
        }
        const textBytes = Buffer.byteLength(loaded.text, NOTE_ENCODING);
        // The block also carries a heading and the note path, so the budget covers
        // the complete rendered note instead of its text alone. Escaping a closing
        // frame tag inside the text or the path adds a byte each, and the block
        // renders the escaped spelling, so the budget charges that spelling too.
        const carriedBytes = Buffer.byteLength(escapeFrameBody(loaded.text), NOTE_ENCODING)
            + Buffer.byteLength(escapeFrameBody(entry.path), NOTE_ENCODING) + budget.headingBytes;
        // An empty note would inject a heading with nothing under it.
        if (textBytes === 0 || includedBytes + carriedBytes > budget.injectMaxBytes) {
            remaining.push(entry);
            continue;
        }
        includedBytes += carriedBytes;
        included.push({ ...entry, text: loaded.text, truncated: loaded.truncated });
    }
    const partial = window.stopped
        ? 'entries'
        : unclassified ? 'bytes' : undefined;
    return { included, remaining, ...partial === undefined ? {} : { partial } };
}
/**
 * Resolve a note path and prove the result stays inside the notes directory.
 * @param root - Canonical notes directory.
 * @param notePath - Note path as the caller supplied it.
 * @returns The absolute target and its path relative to the directory.
 * @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path names the
 * directory itself or resolves outside it, or `SLEEP_NOTE_UNAVAILABLE` when it
 * cannot be resolved.
 */
async function confinedTarget(root, notePath) {
    const segments = noteSegments(notePath);
    const candidate = isAbsolute(notePath) ? resolve(notePath) : join(root, ...segments);
    let target;
    try {
        target = await canonicalPath(candidate);
    }
    catch (error) {
        throw noteFailure(notePath, 'resolve', error);
    }
    if (target === root)
        throw unsafePathError(notePath, 'names the sleep notes directory itself');
    if (!isInside(root, target)) {
        throw unsafePathError(notePath, 'resolves outside the sleep notes directory');
    }
    return { target, path: relative(root, target).split(sep).join('/') };
}
/**
 * Resolve a destination note path and keep the spelling the caller asked for.
 *
 * The parent is canonicalized, so a link inside the tree cannot redirect the
 * rename and a path that leaves the directory is refused. The final name stays as
 * the caller spelled it: a name that already exists resolves to the spelling the
 * filesystem keeps, which would erase a requested change of that spelling, and a
 * case-insensitive host would then rename the entry onto itself and report a move
 * that changed nothing.
 * @param root - Canonical notes directory.
 * @param notePath - New note path as the caller supplied it.
 * @returns The requested path and its path relative to the directory.
 * @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path names the
 * directory itself or resolves outside it, or `SLEEP_NOTE_UNAVAILABLE` when it
 * cannot be resolved.
 */
async function confinedDestination(root, notePath) {
    const segments = noteSegments(notePath);
    const candidate = isAbsolute(notePath) ? resolve(notePath) : join(root, ...segments);
    let parent;
    try {
        parent = await canonicalPath(dirname(candidate));
    }
    catch (error) {
        throw noteFailure(notePath, 'resolve', error);
    }
    if (parent !== root && !isInside(root, parent)) {
        throw unsafePathError(notePath, 'resolves outside the sleep notes directory');
    }
    const target = join(parent, basename(candidate));
    return { target, path: relative(root, target).split(sep).join('/') };
}
/**
 * Prove again, immediately before the filesystem call, that a resolved target
 * still spells the same path.
 *
 * Resolution and the operation are separate steps, so a parent directory
 * replaced by a symbolic link between them would redirect the operation. The
 * operation therefore re-resolves the target and refuses a different answer;
 * it acts only on the path this function confirms. Node exposes no
 * descriptor-relative call, so an ancestor swapped inside this function's own
 * final gap remains possible, as the module documentation states.
 * @param root - Canonical notes directory.
 * @param target - Target resolved when the operation was prepared.
 * @returns The same target, after resolving every segment again.
 * @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path now resolves
 * to a different location, or `SLEEP_NOTE_UNAVAILABLE` when it cannot be resolved.
 */
async function confirmedTarget(root, target) {
    let fresh;
    try {
        fresh = await canonicalPath(target.target);
    }
    catch (error) {
        throw noteFailure(target.path, 'confirm', error);
    }
    if (fresh !== target.target || !isInside(root, fresh)) {
        throw unsafePathError(target.path, 'resolves to a different path after validation');
    }
    return { target: fresh, path: target.path };
}
/**
 * Prove one note the scan reported still resolves inside the notes directory.
 *
 * The injection pass scans the tree and then reads it, so a directory replaced
 * by a symbolic link in between would make the read follow a path the scan
 * never validated. The answer is the path the note resolves to now, which may
 * be the note a link inside the tree names; a note that no longer resolves
 * inside the directory is left out of the pass, exactly like a note the pass
 * cannot classify.
 * @param root - Canonical notes directory.
 * @param entry - Note the scan reported.
 * @returns The confirmed target, or `undefined` when it no longer stays inside.
 */
async function confirmedScannedNote(root, entry) {
    try {
        const fresh = await canonicalPath(absoluteNotePath(root, entry.path));
        return isInside(root, fresh) ? { target: fresh, path: entry.path } : undefined;
    }
    catch (error) {
        // A note a concurrent change moved elsewhere must not fail the step that
        // carries the other notes.
        void error;
        return undefined;
    }
}
/**
 * Read the symbolic link one note path names, if it names one.
 *
 * Resolution follows a link, so a path that names a listed link would otherwise
 * be read as the note the link points at. The answer keeps the link's own
 * spelling by canonicalizing its parent instead, and only a link that resolves
 * inside the notes directory is answered; the operations that follow keep
 * refusing a link that leaves it, or that names no existing file.
 * @param root - Canonical notes directory.
 * @param notePath - Note path as the caller supplied it.
 * @returns The named link, or `undefined` when the path names any other kind of entry.
 * @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path or the link leaves the
 * directory, or `SLEEP_NOTE_UNAVAILABLE` when the entry cannot be read.
 */
async function namedLink(root, notePath) {
    const segments = noteSegments(notePath);
    const named = isAbsolute(notePath) ? resolve(notePath) : join(root, ...segments);
    let parent;
    try {
        parent = await canonicalPath(dirname(named));
    }
    catch (error) {
        throw noteFailure(notePath, 'resolve', error);
    }
    if (parent !== root && !isInside(root, parent)) {
        throw unsafePathError(notePath, 'resolves outside the sleep notes directory');
    }
    const entry = join(parent, basename(named));
    let info;
    try {
        info = await lstat(entry);
    }
    catch (error) {
        if (errnoCode(error) === 'ENOENT')
            return undefined;
        throw noteFailure(notePath, 'resolve', error);
    }
    if (!info.isSymbolicLink())
        return undefined;
    let resolved;
    try {
        resolved = await realpath(entry);
    }
    catch (error) {
        // A link that resolves to nothing names no note: the operation that follows
        // reports the path as absent.
        void error;
        return undefined;
    }
    if (!isInside(root, resolved)) {
        throw unsafePathError(notePath, 'resolves outside the sleep notes directory');
    }
    return { entry, path: relative(root, entry).split(sep).join('/'), target: resolved };
}
/**
 * Remove one symbolic link entry without touching the note it names.
 *
 * The link's parent was canonicalized when the link was read; the removal proves
 * it again immediately before the call, exactly as every other operation does.
 * @param link - Link the caller named.
 * @param notePath - Note path as the caller supplied it, used in failures.
 * @returns The removed link entry, with no note files removed with it.
 * @throws SleepError with code `SLEEP_PATH_UNSAFE` when the parent now resolves
 * elsewhere, or `SLEEP_NOTE_UNAVAILABLE` when the link cannot be removed.
 */
async function removeNamedLink(link, notePath) {
    try {
        // The link was read through this parent, so a parent that resolves to a
        // different path now would make the removal act on another entry.
        const parent = await canonicalPath(dirname(link.entry));
        if (parent !== dirname(link.entry)) {
            throw unsafePathError(notePath, 'resolves to a different path after validation');
        }
        // `rm` on a symbolic link removes the link; it never follows it.
        await rm(link.entry);
    }
    catch (error) {
        throw noteFailure(notePath, 'delete', error);
    }
    return {
        path: link.path,
        kind: 'link',
        removedFiles: 0,
        removedBytes: 0,
        removedPaths: [],
        omittedPaths: 0,
    };
}
/**
 * Split a note path into its segments, refusing forms that could leave the directory.
 * @param notePath - Note path as the caller supplied it.
 * @returns The path segments, without empty or current-directory segments.
 * @throws SleepError with code `SLEEP_PATH_UNSAFE` when the path holds a NUL byte, a `..` segment, or no name at all.
 */
function noteSegments(notePath) {
    if (notePath.includes(NUL_CHARACTER))
        throw unsafePathError(notePath, 'contains a NUL byte');
    if (notePath.trim() === '')
        throw unsafePathError(notePath, 'names no note');
    const segments = notePath.split(PATH_SEPARATOR);
    if (segments.includes(PARENT_SEGMENT)) {
        throw unsafePathError(notePath, 'must not contain a ".." segment');
    }
    const named = segments.filter(segment => segment !== '' && segment !== CURRENT_SEGMENT);
    if (named.length === 0)
        throw unsafePathError(notePath, 'names no note');
    return named;
}
/**
 * Resolve a path to its canonical spelling, including a part that does not exist yet.
 *
 * The nearest existing ancestor is the one realpath resolves, and the missing
 * segments are re-appended, so the answer is stable before and after the
 * intermediate directories are created.
 * @param path - Absolute path to resolve.
 * @returns The canonical path.
 * @throws The filesystem failure that stopped the walk.
 */
async function canonicalPath(path) {
    const missing = [];
    let current = path;
    for (;;) {
        try {
            return join(await realpath(current), ...missing);
        }
        catch (error) {
            // Only an absent path continues the walk; a permission failure, a symlink
            // loop, or a parent that is a file must reach the caller as it stands.
            if (errnoCode(error) !== 'ENOENT')
                throw error;
        }
        const parent = dirname(current);
        /* v8 ignore next -- the filesystem root always exists, so the walk stops before it. */
        if (parent === current)
            return path;
        missing.unshift(basename(current));
        current = parent;
    }
}
/**
 * Whether one canonical path sits strictly inside the notes directory.
 * @param root - Canonical notes directory.
 * @param target - Canonical path to test.
 * @returns `true` when the target is a path below the directory.
 */
function isInside(root, target) {
    const relativePath = relative(root, target);
    /* v8 ignore next -- POSIX never escapes through a drive letter; only a target on another Windows drive answers absolutely. */
    if (isAbsolute(relativePath))
        return false;
    return relativePath !== '' && relativePath !== PARENT_SEGMENT && !relativePath.startsWith(`${PARENT_SEGMENT}${sep}`);
}
/**
 * Whether two canonical paths name one entry on this host.
 *
 * A host that compares path names without case resolves a requested change of
 * spelling to the file that is already there, so both spellings then name the
 * entry the note occupies; on a case-sensitive host the spellings differ exactly
 * when the entries do.
 * @param left - First canonical path.
 * @param right - Second canonical path.
 * @returns `true` when both name one entry.
 */
function samePath(left, right) {
    /* v8 ignore next -- the platform fixes this comparison, so only one arm runs on any host */
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
/**
 * Read the note directory as it is, without creating it.
 * @param rootDir - Configured notes directory.
 * @returns The canonical directory, or `undefined` when it does not exist.
 * @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when the directory exists but cannot be resolved.
 */
async function existingRoot(rootDir) {
    try {
        return await realpath(resolve(rootDir));
    }
    catch (error) {
        if (errnoCode(error) === 'ENOENT')
            return undefined;
        throw noteFailure(rootDir, 'open the notes directory', error);
    }
}
/**
 * Read the note directory as it is, refusing a directory that does not exist.
 * @param rootDir - Configured notes directory.
 * @returns The canonical directory.
 * @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when the directory is absent or cannot be resolved.
 */
async function requiredRoot(rootDir) {
    const root = await existingRoot(rootDir);
    if (root === undefined)
        throw noteUnavailableError(rootDir, 'the notes directory does not exist');
    return root;
}
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
export async function ensureNotesDirectory(rootDir) {
    try {
        await mkdir(resolve(rootDir), { recursive: true, mode: NOTE_DIR_MODE });
    }
    catch (error) {
        throw noteFailure(rootDir, 'create the notes directory', error);
    }
    return await requiredRoot(rootDir);
}
/**
 * List the regular files below one directory of the notes tree.
 * @param root - Canonical notes directory.
 * @param relativeDir - Directory being listed, relative to the root, or `''` for the root itself.
 * @param window - Entry budget of a bounded walk, or `undefined` for an unbounded one.
 * @returns The notes found below that directory, ordered by path.
 * @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when a directory cannot be read.
 */
async function scanNotes(root, relativeDir, window) {
    const label = relativeDir === '' ? '.' : relativeDir;
    try {
        return await scanDirectory(root, relativeDir, window);
    }
    catch (error) {
        throw noteFailure(label, 'read the directory', error);
    }
}
/**
 * List the entries a recursive delete removes below one directory.
 *
 * The report must state what actually went: a symbolic link inside the removed
 * directory is removed as the entry it is, so the note it names outside the
 * deleted tree stays and is not counted. Each subdirectory is proved again
 * before it is opened, exactly as the note scan does.
 * @param root - Canonical notes directory.
 * @param relativeDir - Directory being removed, relative to the root.
 * @returns The removed entries in path order.
 * @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when a directory cannot be read.
 */
async function scanRemovedEntries(root, relativeDir) {
    try {
        return await walkRemovedEntries(root, relativeDir);
    }
    catch (error) {
        throw noteFailure(relativeDir, 'read the directory', error);
    }
}
/**
 * Walk one directory of the tree a recursive delete removes.
 * @param root - Canonical notes directory.
 * @param relativeDir - Directory being walked, relative to the root.
 * @returns The removed entries under that directory, ordered by path.
 * @throws The filesystem failure that stopped the walk.
 */
async function walkRemovedEntries(root, relativeDir) {
    const directory = absoluteNotePath(root, relativeDir);
    const openedDirectory = await containedDirectory(root, directory);
    if (openedDirectory === undefined)
        return [];
    const handle = await opendir(openedDirectory);
    const entries = [];
    for await (const entry of handle) {
        const path = `${relativeDir}/${entry.name}`;
        if (entry.isDirectory()) {
            entries.push(...await scanRemovedEntries(root, path));
        }
        else if (entry.isSymbolicLink()) {
            entries.push({ path, bytes: 0, kind: 'link' });
        }
        else {
            const info = await stat(join(directory, entry.name));
            entries.push({ path, bytes: info.size, kind: 'file' });
        }
    }
    return entries.sort((left, right) => compareNotePaths(left.path, right.path));
}
/**
 * Walk one directory of the notes tree and collect the notes below it.
 *
 * A subdirectory is proved again immediately before it is opened: the entry that
 * reported it as a directory can have been replaced by a symbolic link since the
 * listing, and opening it would otherwise list names and sizes outside the notes
 * directory.
 * @param root - Canonical notes directory.
 * @param relativeDir - Directory being listed, relative to the root, or `''` for the root itself.
 * @param window - Entry budget of a bounded walk, or `undefined` for an unbounded one.
 * @returns The notes found below that directory, ordered by path.
 * @throws The filesystem failure that stopped the walk.
 */
async function scanDirectory(root, relativeDir, window) {
    const directory = relativeDir === '' ? root : absoluteNotePath(root, relativeDir);
    const openedDirectory = relativeDir === '' ? directory : await containedDirectory(root, directory);
    if (openedDirectory === undefined)
        return [];
    // The async iterator closes the directory when the loop finishes, breaks, or
    // throws, so no explicit close can race the iterator's own.
    const handle = await opendir(openedDirectory);
    const notes = [];
    // `opendir` reads the directory in bounded batches, so a wide directory
    // costs the walk only the entries it examines, not the whole listing.
    for await (const entry of handle) {
        // Every examined entry costs one unit, so a wide tree of small notes and a
        // deep tree of the same size cost the same bounded walk.
        if (window !== undefined) {
            if (window.remaining === 0) {
                window.stopped = true;
                break;
            }
            window.remaining -= 1;
        }
        const notePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
        const target = join(directory, entry.name);
        if (entry.isDirectory()) {
            notes.push(...await scanNotes(root, notePath, window));
            if (window?.stopped === true)
                break;
        }
        else if (entry.isSymbolicLink()) {
            const linked = await linkedNote(root, target, notePath);
            if (linked !== undefined)
                notes.push(linked);
        }
        else {
            // Only a regular file is a note the read tool can open. A host can hold a
            // FIFO, socket, or device in the notes directory, and the listing leaves
            // one out instead of offering a path the read refuses.
            let info;
            try {
                info = await stat(target);
            }
            catch (error) {
                // Another writer removed the note after this walk listed it. A note that
                // no longer exists cannot reach the session, and the rest of the tree
                // still can, so the walk continues.
                if (errnoCode(error) === 'ENOENT')
                    continue;
                throw error;
            }
            if (info.isFile())
                notes.push({ path: notePath, bytes: info.size, mtimeMs: info.mtimeMs });
        }
    }
    return notes.sort((left, right) => compareNotePaths(left.path, right.path));
}
/**
 * Resolve one subdirectory of the scan and prove it stays inside the notes directory.
 *
 * The scan lists the tree and then enters each directory it found, so a
 * directory replaced by a symbolic link in between would make the walk list a
 * location the scan never validated.
 * @param root - Canonical notes directory.
 * @param directory - Absolute directory the scan is about to open.
 * @returns The canonical directory, or `undefined` when it leaves the notes directory.
 * @throws The filesystem failure that stopped the resolution.
 */
async function containedDirectory(root, directory) {
    const resolved = await canonicalPath(directory);
    return isInside(root, resolved) ? resolved : undefined;
}
/**
 * Describe a symbolic link that resolves to a regular file inside the directory.
 * @param root - Canonical notes directory.
 * @param target - Absolute path of the link.
 * @param notePath - Link path relative to the notes directory.
 * @returns The note the link names, or `undefined` when it leaves the directory or names no regular file.
 */
async function linkedNote(root, target, notePath) {
    try {
        const resolved = await realpath(target);
        if (!isInside(root, resolved))
            return undefined;
        const info = await stat(resolved);
        if (!info.isFile())
            return undefined;
        return { path: notePath, bytes: info.size, mtimeMs: info.mtimeMs };
    }
    catch (error) {
        // A link that does not resolve to a readable file lists nothing: a scan
        // reports the notes it can open, never the links that point elsewhere.
        void error;
        return undefined;
    }
}
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
export function compareNotePaths(left, right) {
    if (left === right)
        return 0;
    return left < right ? -1 : 1;
}
/**
 * Read the size and modification time of a note.
 * @param note - Resolved note.
 * @returns The note with its current size and modification time.
 * @throws The filesystem failure that stopped the read.
 */
async function describeNote(note) {
    const info = await stat(note.target);
    return { path: note.path, bytes: info.size, mtimeMs: info.mtimeMs };
}
/**
 * Read the modification time of a note that was just written.
 *
 * The write already landed, so a metadata read that fails reports no time
 * instead of turning the committed write into a failed one.
 * @param note - Resolved note.
 * @returns The modification time, or nothing when the note cannot be read.
 */
async function writtenMtime(note) {
    try {
        return { mtimeMs: (await stat(note.target)).mtimeMs };
    }
    catch (error) {
        // The note is on disk; only its timestamp is unknown.
        void error;
        return {};
    }
}
/**
 * Whether one destination path already holds a note.
 *
 * A dangling symbolic link at that path is not a note, so it reports false; a
 * rename still replaces the link entry, which removes nothing a reader could
 * open.
 * @param target - Absolute destination path.
 * @returns `true` when the path names an existing note.
 * @throws The filesystem failure that is not an absent path.
 */
async function noteExists(target) {
    try {
        await stat(target);
        return true;
    }
    catch (error) {
        /* v8 ignore next -- a non-ENOENT stat failure on a canonicalized destination is an external I/O fault */
        if (errnoCode(error) !== 'ENOENT')
            throw error;
        return false;
    }
}
/**
 * Summarize the note files one deletion removed.
 *
 * Only note files count: a symbolic link inside the removed tree went with it,
 * but the note it named did not, so neither its path nor its target's bytes
 * belong in a report about removed notes.
 * @param removed - Removed entries in path order.
 * @returns The note-file counts, the total size, and the removed note paths up to the reporting bound.
 */
function deleteSummary(removed) {
    const files = removed.filter(entry => entry.kind === 'file');
    let removedBytes = 0;
    for (const note of files)
        removedBytes += note.bytes;
    return {
        removedFiles: files.length,
        removedBytes,
        removedPaths: files.slice(0, DELETED_PATHS_LIMIT).map(note => note.path),
        omittedPaths: Math.max(0, files.length - DELETED_PATHS_LIMIT),
    };
}
/**
 * Read a note as UTF-8 text, at most `maxBytes` of it.
 * @param note - Resolved note.
 * @param maxBytes - Maximum bytes read.
 * @param progress - Receives the bytes read so far, so a failed read still reports its cost.
 * @returns The decoded text, the byte cap's verdict, the note's size, and the bytes read.
 * @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when the note is absent, not a regular file, or unreadable.
 */
async function loadNote(note, maxBytes, progress) {
    const loaded = await readNoteBytes(note, maxBytes, progress);
    const truncated = loaded.size > maxBytes;
    return {
        text: decodeNoteText(loaded.bytes, truncated),
        truncated,
        size: loaded.size,
        read: loaded.bytes.byteLength,
    };
}
/**
 * Read one note for the injection pass, charging the bytes the attempt cost.
 *
 * A note the pass cannot offer is reported without text, so the caller leaves
 * it out of both lists. The read window bounds every attempt, so a note that
 * grew after the scan cannot cost more than the budget still holds, and a read
 * that fails partway charges the bytes it did consume.
 * @param target - Absolute path of the note.
 * @param notePath - Note path relative to the notes directory.
 * @param maxBytes - Maximum bytes the read window holds.
 * @returns The note, or why the pass cannot offer it, and the bytes charged.
 */
async function inspectNote(target, notePath, maxBytes) {
    const progress = { read: 0 };
    let loaded;
    try {
        loaded = await loadNote({ target, path: notePath }, maxBytes, progress);
    }
    catch (error) {
        // One unusable note must not fail the step that carries the others.
        void error;
        return { note: undefined, spent: progress.read };
    }
    if (loaded.text === undefined)
        return { note: undefined, spent: loaded.read };
    return {
        note: { text: loaded.text, truncated: loaded.truncated, size: loaded.size },
        spent: loaded.read,
    };
}
/**
 * Read the first bytes of a note.
 *
 * The file is proved again after the open: an ancestor directory replaced by a
 * symbolic link between the containment check and the open would make the open
 * read a different file, and that file reports a different identity. The size
 * comes from the opened file rather than the check before it, so a note whose
 * content grew between those two steps is read as it is now.
 * @param note - Resolved note.
 * @param maxBytes - Maximum bytes read.
 * @param progress - Receives the bytes read so far, including a read that fails partway.
 * @returns The bytes read, which can be fewer when the note shrank, and the size of the opened file.
 * @throws SleepError with code `SLEEP_NOTE_UNAVAILABLE` when the note is absent,
 * not a regular file, not the file the path check described, or unreadable.
 */
async function readNoteBytes(note, maxBytes, progress) {
    let handle;
    try {
        const info = await stat(note.target);
        if (!info.isFile())
            throw noteUnavailableError(note.path, 'not a regular file');
        handle = await open(note.target, NOTE_READ_FLAGS);
        const opened = await handle.stat();
        if (!sameFile(info, opened)) {
            throw noteUnavailableError(note.path, 'the opened file is not the one the path check described');
        }
        const count = Math.min(opened.size, maxBytes);
        const buffer = new Uint8Array(count);
        let read = 0;
        // One read call may fill less than the requested range; keep reading until
        // the range is complete so a short read cannot truncate the note silently.
        while (read < count) {
            const part = await handle.read(buffer, read, count - read, read);
            /* v8 ignore next -- a regular file that did not shrink since the descriptor was read fills the range */
            if (part.bytesRead === 0)
                break;
            read += part.bytesRead;
            progress.read = read;
        }
        return { bytes: buffer.subarray(0, read), size: opened.size };
    }
    catch (error) {
        throw noteFailure(note.path, 'read', error);
    }
    finally {
        // A read-only descriptor holds nothing to flush, so a close fault after a
        // successful read cannot change the bytes already read. Reporting it as a
        // failed read would charge the injection pass the size the scan saw instead
        // of the bytes the read consumed.
        await handle?.close().catch((error) => { void error; });
    }
}
/**
 * Whether two filesystem stat results describe the same file.
 *
 * `dev` and `ino` are the identity a stat reports. A platform or filesystem that
 * reports no inode number cannot answer, so the check accepts the pair and the
 * containment check before the open stays the only defence there.
 * @param before - Stat of the note path taken before the open.
 * @param opened - Stat of the opened descriptor.
 * @returns `true` when both results describe one file.
 */
function sameFile(before, opened) {
    if (before.ino === 0 || opened.ino === 0)
        return true;
    return before.ino === opened.ino && before.dev === opened.dev;
}
/**
 * Decode note bytes, refusing anything that is not UTF-8 text.
 * @param bytes - Bytes read from the note.
 * @param truncated - Whether the byte cap cut the note, so its tail may end inside one character.
 * @returns The text, or `undefined` when the bytes are not UTF-8 text.
 */
function decodeNoteText(bytes, truncated) {
    if (bytes.includes(NUL_BYTE))
        return undefined;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
        // A cut at the byte cap can fall inside one character; streaming mode keeps
        // that partial tail out of the text instead of failing or replacing it.
        return truncated ? decoder.decode(bytes, { stream: true }) : decoder.decode(bytes);
    }
    catch (error) {
        // `fatal` rejects exactly the byte sequences that are not UTF-8.
        void error;
        return undefined;
    }
}
/**
 * Split note text into its lines.
 * @param text - Note text.
 * @returns The lines, without the terminator of the last one.
 */
function splitLines(text) {
    if (text === '')
        return [];
    return text.replace(TRAILING_LINE_BREAK, '').split(LINE_BREAK);
}
/**
 * Report one failed note operation, naming the errno the filesystem reported.
 * @param notePath - Note path as the caller supplied it.
 * @param operation - Operation that failed, in the imperative voice.
 * @param error - Failure the filesystem raised.
 * @returns The coded note failure, with the original failure as its cause.
 */
function noteFailure(notePath, operation, error) {
    // A failure this module already classified keeps its own detail and code.
    if (error instanceof SleepError)
        return error;
    return noteUnavailableError(notePath, `cannot ${operation} (${errnoCode(error)})`, { cause: error });
}
/**
 * Read the errno code of a filesystem failure.
 * @param error - Failure the filesystem raised.
 * @returns The errno code, or `unknown` when the failure carries none.
 */
function errnoCode(error) {
    const code = error?.code;
    /* v8 ignore next -- a Node filesystem call reports an errno string; the fallback only keeps a foreign failure readable. */
    return typeof code === 'string' ? code : 'unknown';
}
/**
 * Join a directory and a relative note path.
 * @param root - Canonical notes directory.
 * @param notePath - Note path relative to the directory, with `/` separators.
 * @returns The absolute path of the note.
 */
function absoluteNotePath(root, notePath) {
    return join(root, ...notePath.split('/'));
}
//# sourceMappingURL=notes-fs.js.map