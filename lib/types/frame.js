/**
 * The `<system-reminder>` frame of the saved-notes block.
 *
 * The memory injector owns the complete frame, so only the closing tag a note
 * carries is escaped: an opening tag inside note text cannot end the block
 * early. The injection budget prices the escaped text, because that is what the
 * block carries.
 * @module @deepseek-ai/dsh-sleep/frame
 */
/** Opening tag of the frame. */
export const FRAME_OPEN = '<system-reminder>';
/** Closing tag of the frame, and the tag carried text must not repeat. */
export const FRAME_CLOSE = '</system-reminder>';
/** What a closing tag inside carried text becomes. */
const FRAME_CLOSE_ESCAPED = '<\\/system-reminder>';
/**
 * Keep carried text from closing the frame early.
 * @param body - Rendered block content, without the frame.
 * @returns The content with every closing tag escaped.
 */
export function escapeFrameBody(body) {
    return body.replaceAll(FRAME_CLOSE, FRAME_CLOSE_ESCAPED);
}
//# sourceMappingURL=frame.js.map