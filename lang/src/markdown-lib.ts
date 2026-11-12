import { Failure } from './errors.js';

function check(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Failure('assertion_failed', message);
}

const normalize = (text: string): string => String(text).replace(/\r\n?/g, '\n');

function line(text: string): string {
    check(!/[\r\n]/.test(text), 'Markdown inline text must not contain newlines');
    return text;
}

function fence(text: string, minimum: number): string {
    let longest = 0;
    for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
    return '`'.repeat(Math.max(minimum, longest + 1));
}

/** Escapes Markdown punctuation so text renders literally. */
export function escape(text: string): string {
    return String(text).replace(/[\\`*_{}[\]<>()#+\-.!|~&]/g, '\\$&');
}

export function bold(text: string): string {
    return `**${line(text)}**`;
}

export function italic(text: string): string {
    return `*${line(text)}*`;
}

/** Inline code; the fence grows to fit backticks in the text. */
export function code(text: string): string {
    let content = normalize(text).replace(/\n/g, ' ');
    check(content !== '', 'Markdown inline code must not be empty');
    const marks = fence(content, 1);
    if (content.startsWith('`') || content.endsWith('`') || (content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '')) {
        content = ` ${content} `;
    }
    return marks + content + marks;
}

const destination = (url: string): string => String(url)
    .replace(/\\/g, '%5C').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/ /g, '%20')
    .replace(/\t/g, '%09').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export function link(label: string, url: string): string {
    return `[${escape(line(label))}](<${destination(url)}>)`;
}

export function image(alt: string, url: string): string {
    return `!${link(alt, url)}`;
}

function cell(text: string): string {
    let result = '';
    let slashes = 0;
    for (const character of normalize(text)) {
        if (character === '|' && slashes % 2 === 0) result += '\\';
        result += character === '\n' ? '<br>' : character;
        slashes = character === '\\' ? slashes + 1 : 0;
    }
    return result;
}

const row = (cells: readonly string[]): string => `| ${cells.map(cell).join(' | ')} |`;

/** Builds a Markdown document block by block; every method returns the document for chaining. */
export class Document {
    readonly blocks: string[] = [];

    /** Appends Markdown as written. */
    raw(text: string): this {
        if (text !== '') this.blocks.push(normalize(text));
        return this;
    }

    heading(text: string, level = 1): this {
        check(Number.isInteger(level) && level >= 1 && level <= 6, 'Markdown heading level must be between 1 and 6');
        return this.raw(`${'#'.repeat(level)} ${line(text)}`);
    }

    paragraph(text: string): this {
        return this.raw(text);
    }

    bulletList(items: readonly string[]): this {
        return this.raw(items.map(item => `- ${normalize(item).replace(/\n/g, '\n  ')}`).join('\n'));
    }

    orderedList(items: readonly string[], start = 1): this {
        check(Number.isInteger(start) && start >= 0 && start + items.length <= 1_000_000_000, 'Markdown ordered list numbers must have at most nine digits');
        return this.raw(items.map((item, index) => {
            const prefix = `${start + index}. `;
            return prefix + normalize(item).replace(/\n/g, `\n${' '.repeat(prefix.length)}`);
        }).join('\n'));
    }

    quote(text: string): this {
        return this.raw(`> ${normalize(text).replace(/\n/g, '\n> ')}`);
    }

    codeBlock(text: string, language = ''): this {
        check(!line(language).includes('`'), 'Markdown code block language must not contain backticks');
        const marks = fence(text, 3);
        let content = normalize(text);
        if (content !== '' && !content.endsWith('\n')) content += '\n';
        return this.raw(`${marks}${language}\n${content}${marks}`);
    }

    table(headers: readonly string[], rows: readonly (readonly string[])[]): this {
        check(headers.length > 0, 'Markdown tables require at least one column');
        const lines = [row(headers), row(headers.map(() => '---'))];
        for (const cells of rows) {
            check(cells.length === headers.length, 'Markdown table row width must match the headers');
            lines.push(row(cells));
        }
        return this.raw(lines.join('\n'));
    }

    thematicBreak(): this {
        return this.raw('---');
    }

    toString(): string {
        return this.blocks.length ? `${this.blocks.join('\n\n')}\n` : '';
    }
}

/** Starts an empty document: `markdown.document().heading('Report')`. */
export function document(): Document {
    return new Document();
}
