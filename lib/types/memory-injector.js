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
import { join } from 'node:path';
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { isSleepAgent } from "./activity.js";
import { FRAME_CLOSE, FRAME_OPEN, escapeFrameBody } from "./frame.js";
import { collectNotesForInjection } from "./notes-fs.js";
/** Separator note paths use, independent of the host. */
const PATH_SEPARATOR = '/';
/** Separator the block puts between its blocks. */
const BLOCK_SEPARATOR = '\n\n';
/** Projection key of the durable startup block, owned by this injector. */
const SLEEP_MEMORY_PROJECTION_KEY = 'sleepMemory';
/**
 * Durable record of the startup block.
 *
 * The block is one durable `user/message`, so a Session that recorded it never
 * needs a second one. The surface can lose the message to a compaction, which
 * is why the injector reads this record instead of the derived history alone.
 */
const sleepMemoryProjection = {
    key: SLEEP_MEMORY_PROJECTION_KEY,
    stateSchema: z.boolean(),
    stateVersion: 1,
    init: () => false,
    apply: (recorded, event) => recorded || (event.type === 'user/message' && isMemoryMessage(event.data)),
};
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
export async function installMemoryInjector(ctx, config) {
    const dir = config.dir;
    // The registry is optional: without it the injected block is still durable,
    // and a resumed Session finds it on its own surface until a compaction
    // shadows it.
    const projections = ctx.get('sessionProjections');
    const recorded = projections === undefined ? undefined : await projections.register(sleepMemoryProjection);
    ctx.on('agent/pre-step', async ({ agent, step }, next) => {
        const decision = await next();
        // An empty first entry owns a no-step turn. Keep the notes for the step that
        // actually runs, and for the turn it belongs to.
        if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0))
            return decision;
        if (isSleepAgent(ctx, agent, config.presetId))
            return decision;
        if (hasMemoryBaseline(agent, decision.messages, recorded?.stateOf(agent.session) ?? false))
            return decision;
        const notes = await collectNotes(ctx, dir, config);
        if (notes === undefined)
            return decision;
        const totalFiles = notes.included.length + notes.remaining.length;
        // A bounded pass can classify nothing while the directory still holds notes;
        // the block then carries only the sentence that says the listing is partial.
        if (totalFiles === 0 && notes.partial === undefined)
            return decision;
        return {
            ...decision,
            messages: [...decision.messages, memoryMessage(dir, notes, totalFiles, config)],
        };
    });
}
/**
 * Whether the Session already carries the startup block.
 *
 * The block is durable, so a step that repeats it finds it in the proposed
 * messages, a resumed Session finds it in its model-visible surface, and a
 * Session whose surface lost it to a compaction finds it through the injector's
 * own projection when the registry is composed.
 * @param agent - Agent that proposed the step.
 * @param messages - Messages the decision proposes to enter.
 * @param recorded - Whether the Session log already holds the block.
 * @returns `true` when one baseline memory message is already present.
 */
function hasMemoryBaseline(agent, messages, recorded) {
    if (recorded)
        return true;
    if (messages.some(isMemoryMessage))
        return true;
    return agent.session.deriveMessages().some(message => message.role === 'user' && isMemoryMessage(message));
}
/**
 * Whether one message is the startup block this injector writes.
 * @param message - Message to test.
 * @returns `true` when the message carries a baseline memory source.
 */
function isMemoryMessage(message) {
    const { source } = message;
    return source.kind === 'sleep-memory' && source.baseline;
}
/**
 * Scan the notes directory for the block.
 *
 * A directory this host cannot read leaves the turn untouched: the notes enrich
 * the work, and failing here would break the work they enrich. The next step
 * retries the scan.
 * @param ctx - Host context whose logger reports the skipped scan.
 * @param dir - Absolute notes directory.
 * @param config - Resolved sleep configuration carrying every byte limit.
 * @returns The collected notes, or `undefined` when the scan cannot run.
 */
async function collectNotes(ctx, dir, config) {
    try {
        return await collectNotesForInjection(dir, {
            injectMaxBytes: config.injectMaxBytes,
            maxSourceBytes: config.maxSourceBytes,
            inspectMaxBytes: config.inspectMaxBytes,
            inspectMaxEntries: config.inspectMaxEntries,
            headingBytes: headingOverheadBytes(config),
        });
    }
    catch (error) {
        ctx.logger.warn(`sleep memory injection skipped: ${String(error)}`);
        return undefined;
    }
}
/**
 * Bytes one carried note adds to the block besides its path and text.
 *
 * The budget in {@link collectNotesForInjection} charges this overhead for
 * every note, so a notes tree full of long paths cannot inflate the block past
 * `injectMaxBytes` through headings alone. It prices the rendered heading - the
 * prefix, the cut marker, and the line break that closes it - and the separator
 * the block puts before it. The cut marker is counted even for a note the
 * per-note cap did not cut, which over-reserves by a few bytes.
 * @param config - Resolved sleep configuration carrying the per-note cap.
 * @returns Bytes of the heading and of the separator before it.
 */
function headingOverheadBytes(config) {
    const heading = Buffer.byteLength(`## ${cutMarker(config.maxSourceBytes)}\n`, 'utf8');
    return heading + Buffer.byteLength(BLOCK_SEPARATOR, 'utf8');
}
/**
 * Marker a note carries when the per-note byte cap cut it.
 * @param maxSourceBytes - Per-note byte cap the marker names.
 * @returns The marker, including its leading space.
 */
function cutMarker(maxSourceBytes) {
    return ` (cut after ${maxSourceBytes} bytes)`;
}
/**
 * Build the startup block message.
 * @param dir - Absolute notes directory the block was read from.
 * @param notes - Collected notes of that directory.
 * @param totalFiles - Number of text notes found.
 * @param config - Resolved sleep configuration carrying every byte limit.
 * @returns One durable user message carrying the block and its source.
 */
function memoryMessage(dir, notes, totalFiles, config) {
    return createUserMessage({
        content: [{ type: 'text', text: renderMemory(dir, notes, config) }],
        source: {
            kind: 'sleep-memory',
            form: 'notice',
            summary: boundContextSummary(`sleep notes: ${notes.included.length} of ${totalFiles} loaded from ${dir}`),
            baseline: true,
            dir,
            includedFiles: notes.included.map(note => note.path),
            totalFiles,
        },
    });
}
/**
 * Render the notes as one `<system-reminder>` block.
 *
 * The heading names where the notes come from and asks for nothing else: the
 * sleep preset writes the notes, so no style is prescribed here. Note text is
 * escaped before it joins the frame, and a note cut at the per-note byte cap
 * says so.
 * @param dir - Absolute notes directory the notes came from.
 * @param notes - Collected notes of that directory.
 * @param config - Resolved sleep configuration carrying every byte limit.
 * @returns The complete block, frame included.
 */
function renderMemory(dir, notes, config) {
    const blocks = [`Sleep notes from earlier sessions, kept in ${dir}.`];
    for (const note of notes.included)
        blocks.push(includedBlock(note, config.maxSourceBytes));
    if (notes.remaining.length > 0)
        blocks.push(remainingBlock(dir, notes.remaining, config.injectMaxBytes));
    // A bounded pass leaves notes out of both lists; the block says so instead of
    // implying that what it names is the whole tree.
    if (notes.partial !== undefined)
        blocks.push(unexaminedBlock(notes.partial));
    return [FRAME_OPEN, escapeFrameBody(blocks.join(BLOCK_SEPARATOR)), FRAME_CLOSE].join('\n');
}
/**
 * Render one note whose text the block carries.
 * @param note - Collected note with its text.
 * @param maxSourceBytes - Per-note byte cap, named when the text was cut.
 * @returns The note heading and its text.
 */
function includedBlock(note, maxSourceBytes) {
    const cut = note.truncated ? cutMarker(maxSourceBytes) : '';
    return `## ${note.path}${cut}\n${note.text}`;
}
/**
 * Render the notes the block does not carry.
 *
 * The listed notes are bounded by the configured byte budget, so a notes tree
 * the sleep model keeps growing cannot inflate every later request of a working
 * Session. The budget prices the rendered line, including the escape a path
 * holding a closing frame tag needs. A listing that names every note is offered
 * whole, because it needs no count sentence; when notes must be left out, the
 * budget also keeps room for the sentence that counts them, so any listing that
 * names a note stays inside the budget it was given. A budget that cannot hold
 * the fixed heading and that sentence still carries both, because the block must
 * say that the list is incomplete; no listing fits a budget below them.
 * @param dir - Absolute notes directory the notes came from.
 * @param remaining - Collected notes left out of the text block, in path order.
 * @param budget - Most UTF-8 bytes the listed lines may take.
 * @returns The heading, the reading hint, and the lines that fit the budget.
 */
function remainingBlock(dir, remaining, budget) {
    const heading = `Other notes in ${dir}, not carried above; open one at its absolute path when it matters:`;
    const listed = remaining.map(note => `- ${note.path} (${note.bytes} bytes) at ${join(dir, ...note.path.split(PATH_SEPARATOR))}`);
    const headingBytes = renderedBytes(heading);
    const fullBytes = listed.reduce((bytes, line) => bytes + 1 + renderedBytes(line), headingBytes);
    // The complete list needs no count sentence, so it is offered whole when it
    // fits; reserving room for that sentence here would leave out notes that all
    // fit.
    if (fullBytes <= budget)
        return [heading, ...listed].join('\n');
    // A listing that does not fit keeps room for the sentence that counts the
    // notes it leaves out, so that sentence always stays inside the budget too.
    const lines = [heading];
    let bytes = headingBytes;
    for (const [index, line] of listed.entries()) {
        const tail = 1 + renderedBytes(omissionLine(listed.length - index - 1, dir));
        const cost = 1 + renderedBytes(line);
        if (bytes + cost + tail > budget)
            break;
        bytes += cost;
        lines.push(line);
    }
    // The complete list did not fit, so at least one note is counted here.
    lines.push(omissionLine(listed.length + 1 - lines.length, dir));
    return lines.join('\n');
}
/**
 * Measure one rendered line of the block as the frame carries it.
 * @param line - Line before the frame escaping.
 * @returns UTF-8 bytes of the escaped line.
 */
function renderedBytes(line) {
    return Buffer.byteLength(escapeFrameBody(line), 'utf8');
}
/**
 * Build the sentence that counts the notes the listing leaves out.
 * @param count - Notes neither carried nor listed.
 * @param dir - Absolute notes directory the notes came from.
 * @returns The closing count line.
 */
function omissionLine(count, dir) {
    return `- and ${count} more notes in ${dir}`;
}
/**
 * Note the part of the tree the bounded pass did not examine.
 * @param cause - Budget that stopped the pass before it examined the whole tree.
 * @returns The sentences that close a partial block.
 */
function unexaminedBlock(cause) {
    const bound = cause === 'entries'
        ? 'a bounded number of directory entries'
        : 'a bounded amount of note content';
    return 'Only part of this directory was examined. '
        + `The pass is limited to ${bound}, so notes it did not reach are not listed here.`;
}
//# sourceMappingURL=memory-injector.js.map