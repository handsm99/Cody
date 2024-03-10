/**
 * A range of text in a document. Unlike {@link vscode.Range}, this just contains the data. Do not
 * use {@link vscode.Range} when serializing to JSON because it serializes to an array `[start,
 * end]`, which is impossible to deserialize correctly without knowing that the value is for a
 * {@link vscode.Range}.
 *
 * The line and character numbers are 0-indexed.
 */
export interface RangeData {
    start: { line: number; character: number }
    end: { line: number; character: number }
}

/**
 * Return the plain {@link RangeData} for a rich instance of the class {@link vscode.Range}.
 */
export function toRangeData<R extends RangeData>(range: R): RangeData
export function toRangeData<R extends RangeData>(range: R | undefined): RangeData | undefined
export function toRangeData(
    badVSCodeSerializedRange: [{ line: number; character: number }, { line: number; character: number }]
): RangeData
export function toRangeData<R extends RangeData>(
    range: R | [{ line: number; character: number }, { line: number; character: number }] | undefined
): RangeData | undefined {
    // HACK: Handle if the `vscode.Range` value was accidentally JSON-serialized as [start, end],
    // which `vscode.Range` instances do when JSON-serialized because of their `toJSON()` method
    // that misleading and not represented in the type system).
    const data = Array.isArray(range) ? { start: range[0], end: range[1] } : range

    return data
        ? {
              start: { line: data.start.line, character: data.start.character },
              end: { line: data.end.line, character: data.end.character },
          }
        : undefined
}

/**
 * Return the display text for the line range, such as `1-3` (meaning lines 1 through 3, which we
 * assume humans interpret as an inclusive range) or just `2` (meaning just line 2). Callers that
 * need the characters in the returned string should use {@link displayRange}.
 *
 * If the range ends on a line at character 0, it's assumed to only include the prior line.
 *
 * `RangeData` is 0-indexed but humans use 1-indexed line ranges.
 */
export function displayLineRange(range: RangeData): string {
    const startLine = range.start.line + 1
    const endLine =
        range.end.line + (range.end.line !== range.start.line && range.end.character === 0 ? 0 : 1)
    if (endLine === startLine) {
        return startLine.toString()
    }
    return `${startLine}-${endLine}`
}

/**
 * Return the display text for the range, such as `1:2-3:4` (meaning from character 2 on line 1 to
 * character 4 on line 3), `1:2-3` (meaning from character 2 to 3 on line 1), or `1:2` (meaning an
 * empty range that starts and ends at character 2 on line 1). Callers that need only the lines in
 * the returned string should use {@link displayLineRange}.
 *
 * `RangeData` is 0-indexed but humans use 1-indexed line ranges.
 */
export function displayRange(range: RangeData): string {
    if (range.end.line === range.start.line) {
        if (range.end.character === range.start.character) {
            return `${range.start.line + 1}:${range.start.character + 1}`
        }
        return `${range.start.line + 1}:${range.start.character + 1}-${range.end.character + 1}`
    }
    return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${
        range.end.character + 1
    }`
}
