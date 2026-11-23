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
export declare const FRAME_OPEN = "<system-reminder>";
/** Closing tag of the frame, and the tag carried text must not repeat. */
export declare const FRAME_CLOSE = "</system-reminder>";
/**
 * Keep carried text from closing the frame early.
 * @param body - Rendered block content, without the frame.
 * @returns The content with every closing tag escaped.
 */
export declare function escapeFrameBody(body: string): string;
//# sourceMappingURL=frame.d.ts.map