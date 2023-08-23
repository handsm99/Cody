import IntervalTree from '@flatten-js/interval-tree'

import { JointRange, Position, Range } from '.'

/**
 * Utility class to convert line/character positions into offsets.
 */
export class DocumentOffsets {
    private lines_: number[] | null = null
    private intervalTree_: IntervalTree<number> | null = null

    constructor(public readonly content: string) {}

    private compute(): void {
        this.lines_ = []
        this.intervalTree_ = new IntervalTree()

        this.lines_.push(0)
        let index = 1
        while (index < this.content.length) {
            if (this.content[index] === '\n') {
                this.intervalTree.insert([this.lines_[this.lines_.length - 1], index], this.lines.length - 1)
                this.lines_.push(index + 1)
            }
            index++
        }

        this.intervalTree.insert([this.lines_[this.lines_.length - 1], index], this.lines.length - 1)
        this.lines_.push(this.content.length + 1) // sentinel value
    }

    public get lines(): number[] {
        if (this.lines_ === null) {
            this.compute()
        }

        return this.lines_!
    }

    public get intervalTree(): IntervalTree {
        if (this.intervalTree_ === null) {
            this.compute()
        }

        return this.intervalTree_!
    }

    public offset(position: Position): number {
        const lineStartOffset = this.lines[position.line]
        if (lineStartOffset === undefined) {
            throw new Error('Invalid position')
        }

        return lineStartOffset + position.character
    }

    public position(offset: number): Position {
        const result = this.intervalTree.search([offset, offset])
        if (result.length !== 1) {
            throw new Error('Invalid offset')
        }

        return {
            line: result[0],
            character: offset - this.lines[result[0]],
        }
    }

    public rangeSlice(range: Range): string {
        const start = this.offset(range.start)
        const end = this.offset(range.end)

        return this.content.slice(start, end)
    }

    public jointRangeSlice(range: JointRange): string {
        if (!range.offsetStart) {
            range.offsetStart = this.offset(range.start)
            range.offsetEnd = this.offset(range.end)
        }

        return this.content.slice(range.offsetStart, range.offsetEnd)
    }

    public toJointRange(range: Range): JointRange {
        return {
            ...range,
            offsetStart: this.offset(range.start),
            offsetEnd: this.offset(range.end),
        }
    }

    public getLineRange(line: number): Range {
        return {
            start: {
                line,
                character: 0,
            },
            end: {
                line,
                character: this.lines[line + 1] - this.lines[line] - 1,
            },
        }
    }

    public getLine(line: number): string {
        return this.rangeSlice(this.getLineRange(line))
    }
}
