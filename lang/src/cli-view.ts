import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import type { BodySegment, LogEvent, ModelInteraction, ModelStreamEvent } from './log-events.js';
import { formatSegments, paint, prettyJson, prettyListing, sanitize, textSegments } from './log-format.js';

export type Outcome = 'completed' | 'failed' | 'cancelled';
export type StepChoice = 'next' | 'continue';

/** A step the `--debug` stepper stops before: a `---` block or a top-level statement. */
export interface PausedBlock {
    kind: 'code' | 'block';
    line: number;
    /** `ts` for code; `ask`, `agent` or `codegen` for a block. */
    language: string;
    source: string;
    /** JSON-shaped snapshot of the top-level variables. */
    variables(): Record<string, unknown>;
}

/** The subset of Ink's key flags the view reacts to. */
export interface KeyInput {
    upArrow?: boolean;
    downArrow?: boolean;
    pageUp?: boolean;
    pageDown?: boolean;
    home?: boolean;
    end?: boolean;
    return?: boolean;
    backspace?: boolean;
    delete?: boolean;
    escape?: boolean;
    tab?: boolean;
    ctrl?: boolean;
    meta?: boolean;
}

export interface Frame {
    header: string;
    /** Exactly `viewport` timeline rows, each fitting the width. */
    rows: string[];
    viewport: number;
    /** Lines inside the bordered status box. */
    footer: string[];
    hints: string;
}

interface Fold {
    id: string;
    summary: string;
    body: () => string;
    open: boolean;
}

type Part = string | Fold;

interface Card {
    header: string;
    /** Diagnostics continue on the header row; model and tool cards start their body below it. */
    inline: boolean;
    /** Marks text from the workflow, as opposed to folded generated preambles. */
    gutter?: string;
    parts: Part[];
}

type Mode =
    | { kind: 'running' }
    | { kind: 'paused'; block: PausedBlock; resolve: (choice: StepChoice) => void }
    | { kind: 'input'; question: string; value: string; resolve: (answer: string) => void; reject: (error: Error) => void }
    | { kind: 'done'; outcome: Outcome; resolve: () => void };

interface Stream {
    interaction: ModelInteraction;
    channel: 'response' | 'reasoning';
    messageId: string;
    text: string;
}

const INDENT = '  ';
const SPINNER = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];

function wrapRow(text: string, width: number): string[] {
    if (!text) return [''];
    return wrapAnsi(text, Math.max(1, width), { hard: true, trim: false }).split('\n');
}

/** One terminal row: longer text is cut, never wrapped. */
function fit(text: string, width: number): string {
    return stringWidth(text) <= width ? text : wrapRow(text, Math.max(1, width - 1))[0] + '\u2026';
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
const lineCount = (text: string): number => text.replace(/\r?\n$/, '').split('\n').length;

const stepLabel = (block: PausedBlock): string => block.kind === 'block' ? `${block.language} block` : 'statement';

function displayLanguage(language: string): string {
    return language === 'ts' ? 'typescript' : 'markdown';
}

export class TerminalView {
    private readonly cards: Card[] = [];
    private readonly folds: Fold[] = [];
    private readonly owners = new Map<string, Card>();
    private readonly cache = new Map<Card, { width: number; rows: string[]; offsets: Map<string, number> }>();
    private readonly streams = new Map<string, Stream>();
    private readonly listeners = new Set<() => void>();
    private revision = 0;
    private mode: Mode = { kind: 'running' };
    private selected?: string;
    /** Until the user navigates, the newest fold is selected so Space expands the latest tool call. */
    private autoSelect = true;
    private following = true;
    private reveal = false;
    private scroll = 0;
    private page = 1;
    private maxScroll = 0;
    private notes = 0;
    private stepping: boolean;

    constructor(private readonly options: { color: boolean; title: string; debug?: boolean; onCancel: () => void }) {
        this.stepping = Boolean(options.debug);
    }

    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    readonly snapshot = (): number => this.revision;

    /** Whether the status spinner should animate. */
    get animating(): boolean { return this.mode.kind === 'running'; }

    get status(): Mode['kind'] { return this.mode.kind; }

    append(event: LogEvent): void {
        this.add(eventCard(event, this.options.color));
    }

    stream(event: ModelStreamEvent): void {
        if (event.type === 'end') {
            for (const [key, stream] of this.streams) {
                if (stream.interaction.requestId === event.interaction.requestId) this.streams.delete(key);
            }
        } else {
            const { update } = event;
            const key = `${event.interaction.requestId}:${update.channel}`;
            const previous = this.streams.get(key);
            this.streams.set(key, {
                interaction: event.interaction, channel: update.channel, messageId: update.messageId,
                text: update.mode === 'append' && previous?.messageId === update.messageId ? previous.text + update.text : update.text,
            });
        }
        this.changed();
    }

    /** Stops before a block until the user picks Next or Continue; Exit cancels the run. */
    pause(block: PausedBlock): Promise<StepChoice> {
        if (!this.stepping) return Promise.resolve('continue');
        const { color } = this.options;
        const id = `note:${++this.notes}:source`;
        const language = displayLanguage(block.language);
        const label = stepLabel(block);
        this.add({
            header: `${paint('\u25b6', 33, color, true)} ${paint(label, 33, color, true)} ${paint(`\u00b7 line ${block.line}`, 90, color)}`,
            inline: false,
            parts: [{ id, summary: plural(lineCount(block.source), 'line'), body: () => prettyListing(block.source, language, color), open: false }],
        });
        return new Promise(resolve => {
            this.mode = { kind: 'paused', block, resolve: choice => {
                if (choice === 'continue') this.stepping = false;
                this.mode = { kind: 'running' };
                this.changed();
                resolve(choice);
            } };
            this.changed();
        });
    }

    /** Reads a human answer in the status box. */
    ask(question: string): Promise<string> {
        return new Promise((resolve, reject) => {
            this.mode = { kind: 'input', question: sanitize(question), value: '', reject, resolve: answer => {
                const { color } = this.options;
                this.add({
                    header: `${paint('?', 33, color, true)} ${paint(sanitize(question), 1, color)}`,
                    inline: false,
                    parts: [`${paint('\u203a', 36, color, true)} ${answer}`],
                });
                this.mode = { kind: 'running' };
                this.changed();
                resolve(answer);
            } };
            this.changed();
        });
    }

    /** Shows the outcome and resolves when the user presses `e`. */
    finish(outcome: Outcome): Promise<void> {
        this.streams.clear();
        const pending = this.mode;
        if (pending.kind === 'input') pending.reject(new Error('the run finished while waiting for input'));
        if (outcome === 'cancelled') {
            this.mode = { kind: 'done', outcome, resolve: () => {} };
            this.changed();
            return Promise.resolve();
        }
        return new Promise(resolve => {
            this.mode = { kind: 'done', outcome, resolve };
            this.changed();
        });
    }

    /** Releases anything waiting on the view, after the terminal UI stopped unexpectedly. */
    abandon(error: Error): void {
        const mode = this.mode;
        this.stepping = false;
        this.mode = { kind: 'running' };
        if (mode.kind === 'paused') mode.resolve('continue');
        else if (mode.kind === 'input') mode.reject(error);
        else if (mode.kind === 'done') mode.resolve();
    }

    key(input: string, key: KeyInput): void {
        const mode = this.mode;
        const letter = !key.ctrl && !key.meta ? input.toLowerCase() : '';
        if (key.ctrl && input.toLowerCase() === 'c') {
            if (mode.kind === 'done') mode.resolve();
            else this.options.onCancel();
            return;
        }
        if (mode.kind === 'input') {
            if (key.return) { mode.resolve(mode.value); return; }
            if (key.backspace || key.delete) {
                mode.value = [...mode.value].slice(0, -1).join('');
                this.changed();
                return;
            }
            const typed = key.ctrl || key.meta || key.escape || key.tab ? '' : sanitize(input).replace(/\n/g, ' ');
            if (typed && !this.navigation(key)) {
                mode.value += typed;
                this.changed();
                return;
            }
        } else if (mode.kind === 'paused' && ['n', 'c', 'v', 'e'].includes(letter)) {
            if (letter === 'n') mode.resolve('next');
            else if (letter === 'c') mode.resolve('continue');
            else if (letter === 'e') this.options.onCancel();
            else this.showVariables(mode.block);
            return;
        } else if (mode.kind === 'done' && letter === 'e') {
            mode.resolve();
            return;
        }
        this.navigate(input, key);
    }

    frame(width: number, height: number, tick = 0): Frame {
        width = Math.max(20, Math.floor(width) || 80);
        height = Math.max(8, Math.floor(height) || 24);
        const { color } = this.options;
        const footer = this.footer(tick).map(line => fit(line, width - 4));
        const viewport = Math.max(1, height - 1 - (footer.length + 2) - 1);
        this.page = viewport;
        const { rows, offsets } = this.layout(width);
        this.maxScroll = Math.max(0, rows.length - viewport);
        if (this.following) this.scroll = this.maxScroll;
        if (this.reveal && this.selected) {
            const row = offsets.get(this.selected);
            if (row !== undefined) {
                if (row < this.scroll) this.scroll = row;
                else if (row >= this.scroll + viewport) this.scroll = row - viewport + 1;
            }
        }
        this.reveal = false;
        this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll));
        // Being at the bottom means following, however the user got there.
        if (this.scroll === this.maxScroll) this.following = true;
        const hints = fit(this.hints(), width);
        const visible = rows.slice(this.scroll, this.scroll + viewport);
        while (visible.length < viewport) visible.push('');
        const title = `${paint('\u25cf', 35, color, true)} ${paint('SPL', 1, color)} ${paint(sanitize(this.options.title), 90, color)}`;
        const badge = this.options.debug ? paint(' debug ', 33, color, true) : '';
        const gap = width - stringWidth(title) - stringWidth(badge);
        const header = gap > 0 ? title + ' '.repeat(gap) + badge : fit(title, width);
        return { header, rows: visible, viewport, footer, hints };
    }

    private add(card: Card): void {
        this.cards.push(card);
        for (const part of card.parts) {
            if (typeof part === 'string') continue;
            this.folds.push(part);
            this.owners.set(part.id, card);
        }
        if (this.autoSelect) {
            const last = this.folds.at(-1)?.id;
            if (last !== this.selected) this.select(last);
        }
        this.changed();
    }

    private changed(): void {
        this.revision++;
        for (const listener of this.listeners) listener();
    }

    private select(id: string | undefined): void {
        for (const old of [this.selected, id]) {
            const owner = old === undefined ? undefined : this.owners.get(old);
            if (owner) this.cache.delete(owner);
        }
        this.selected = id;
    }

    private navigation(key: KeyInput): boolean {
        return Boolean(key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end);
    }

    private navigate(input: string, key: KeyInput): void {
        const ids = this.folds.map(fold => fold.id);
        if (key.upArrow || key.downArrow) {
            const direction = key.upArrow ? -1 : 1;
            const index = this.selected === undefined ? -1 : ids.indexOf(this.selected);
            const next = index < 0 ? (direction < 0 ? ids.at(-1) : undefined) : ids[index + direction];
            if (next !== undefined) {
                this.select(next);
                this.reveal = true;
            } else this.scroll += direction;
            this.autoSelect = false;
            this.following = direction > 0 && this.scroll >= this.maxScroll;
        } else if (key.pageUp || key.pageDown) {
            this.scroll += key.pageUp ? -this.page : this.page;
            this.following = Boolean(key.pageDown) && this.scroll >= this.maxScroll;
        } else if (key.home) {
            this.scroll = 0;
            this.following = false;
            this.autoSelect = false;
            this.select(ids[0]);
        } else if (key.end) {
            this.following = true;
            this.autoSelect = true;
            this.select(ids.at(-1));
        } else if ((input === ' ' || key.return) && this.selected !== undefined) {
            const fold = this.folds.find(item => item.id === this.selected)!;
            fold.open = !fold.open;
            this.cache.delete(this.owners.get(fold.id)!);
            this.reveal = true;
        } else return;
        this.changed();
    }

    private showVariables(block: PausedBlock): void {
        const { color } = this.options;
        let values: Record<string, unknown>;
        try { values = block.variables(); }
        catch (error) { values = { error: error instanceof Error ? error.message : String(error) }; }
        const names = Object.keys(values);
        const source = JSON.stringify(values) ?? '{}';
        this.add({
            header: `${paint('\u25c6', 34, color, true)} ${paint('Variables', 34, color, true)} ${paint(`before line ${block.line}`, 90, color)}`,
            inline: false,
            parts: names.length
                ? [{ id: `note:${++this.notes}:variables`, summary: plural(names.length, 'variable'), body: () => prettyJson(source, color) ?? source, open: true }]
                : [paint('no top-level variables yet', 90, color)],
        });
    }

    private footer(tick: number): string[] {
        const { color } = this.options;
        const mode = this.mode;
        switch (mode.kind) {
            case 'running':
                return [`${paint(SPINNER[tick % SPINNER.length], 36, color)} ${paint('Running', 1, color)}${this.stepping ? paint(' \u00b7 stepping', 90, color) : ''}`];
            case 'paused': {
                const first = mode.block.source.split('\n').find(line => line.trim()) ?? '';
                return [`${paint('\u2016', 33, color, true)} ${paint('Paused', 33, color, true)} before ${stepLabel(mode.block)} at line ${mode.block.line}`,
                    paint(sanitize(first.trim()), 90, color)];
            }
            case 'input': {
                const question = mode.question.split('\n').filter(Boolean);
                return [...(question.length ? question : ['']).map(line => `${paint('?', 33, color, true)} ${line}`),
                    `${paint('\u203a', 36, color, true)} ${mode.value}${color ? '\u001b[7m \u001b[27m' : '_'}`];
            }
            case 'done':
                return [mode.outcome === 'completed' ? `${paint('\u2713', 32, color, true)} ${paint('Completed', 32, color, true)}`
                    : mode.outcome === 'failed' ? `${paint('\u2717', 31, color, true)} ${paint('Failed', 31, color, true)}`
                    : paint('Cancelled', 90, color)];
        }
    }

    private hints(): string {
        const { color } = this.options;
        const key = (name: string, label: string) => `${paint(name, 1, color)} ${paint(label, 90, color)}`;
        const navigation = [key('\u2191\u2193', 'select'), key('space', 'expand'), key('pgup/pgdn', 'scroll')];
        if (!this.following) navigation.push(key('end', 'follow'));
        const sets: Record<Mode['kind'], string[]> = {
            running: [...navigation, key('ctrl+c', 'cancel')],
            paused: [key('n', 'Next'), key('v', 'Variables'), key('c', 'Continue'), key('e', 'Exit'), ...navigation],
            input: [key('enter', 'submit'), key('ctrl+c', 'cancel'), key('\u2191\u2193', 'scroll')],
            done: [key('e', 'Exit'), ...navigation],
        };
        return ' ' + sets[this.mode.kind].join(paint(' \u00b7 ', 90, color));
    }

    private layout(width: number): { rows: string[]; offsets: Map<string, number> } {
        const rows: string[] = [];
        const offsets = new Map<string, number>();
        this.cards.forEach((card, index) => {
            let cached = this.cache.get(card);
            if (!cached || cached.width !== width) {
                cached = { width, ...this.render(card, width) };
                this.cache.set(card, cached);
            }
            if (index) rows.push('');
            for (const [id, row] of cached.offsets) offsets.set(id, rows.length + row);
            rows.push(...cached.rows);
        });
        for (const stream of this.streams.values()) {
            if (rows.length) rows.push('');
            rows.push(...this.render(streamCard(stream, this.options.color), width).rows);
        }
        return { rows, offsets };
    }

    private render(card: Card, width: number): { rows: string[]; offsets: Map<string, number> } {
        const { color } = this.options;
        const rows: string[] = [];
        const offsets = new Map<string, number>();
        const prefix = card.gutter ? `${INDENT}${card.gutter} ` : INDENT;
        const inner = Math.max(1, width - stringWidth(prefix));
        let buffer = '';
        let headed = !card.inline;
        if (headed) rows.push(...wrapRow(card.header, width));
        const flush = (): void => {
            if (!headed) {
                const [first = '', ...rest] = buffer.replace(/\n+$/, '').split('\n');
                const wrapped = wrapRow(`${card.header} ${first}`.trimEnd(), width - INDENT.length);
                rows.push(wrapped[0], ...wrapped.slice(1).map(row => INDENT + row));
                for (const line of rest) rows.push(...wrapRow(line.trimEnd(), inner).map(row => prefix + row));
                headed = true;
            } else if (buffer.trim()) {
                for (const line of buffer.replace(/^\s+|\n+$/g, '').split('\n')) rows.push(...wrapRow(line.trimEnd(), inner).map(row => prefix + row));
            }
            buffer = '';
        };
        for (const part of card.parts) {
            if (typeof part === 'string') { buffer += part; continue; }
            flush();
            offsets.set(part.id, rows.length);
            const selected = this.selected === part.id;
            const marker = selected ? paint('\u203a', 36, color, true) + ' ' : INDENT;
            const arrow = part.open ? '\u25be' : '\u25b8';
            const hint = selected ? paint(part.open ? '  space to collapse' : '  space to expand', 90, color) : '';
            rows.push(fit(`${marker}${paint(`${arrow} ${part.summary}`, selected ? 36 : 90, color, selected)}${hint}`, width));
            if (part.open) {
                const body = INDENT + INDENT;
                for (const line of part.body().split('\n')) rows.push(...wrapRow(line, Math.max(1, width - body.length)).map(row => body + row));
            }
        }
        flush();
        return { rows, offsets };
    }
}

function jsonSummary(source: string, container: 'object' | 'array'): string {
    try {
        const value: unknown = JSON.parse(source);
        if (Array.isArray(value)) return `[\u2026] ${plural(value.length, 'item')}`;
        if (value && typeof value === 'object') return `{\u2026} ${plural(Object.keys(value).length, 'key')}`;
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
    }
    return container === 'object' ? '{\u2026}' : '[\u2026]';
}

function segmentParts(event: LogEvent, color: boolean): Part[] {
    return event.segments.map((segment: BodySegment, index): Part => {
        switch (segment.type) {
            case 'text': case 'inspection': return segment.text;
            case 'json': return {
                id: segment.payloadId, summary: jsonSummary(segment.source, segment.container),
                body: () => prettyJson(segment.source, color) ?? segment.source, open: false,
            };
            case 'preface': return {
                id: segment.payloadId, summary: `preamble \u00b7 ${plural(lineCount(segment.source), 'line')}`,
                body: () => formatSegments(textSegments(segment.source, segment.payloadId, 'expanded'), color), open: false,
            };
            case 'code': return {
                id: `${event.id}:code:${index}`, summary: `JavaScript \u00b7 ${plural(lineCount(segment.source), 'line')}`,
                body: () => prettyListing(segment.source, 'javascript', color), open: false,
            };
            case 'listing': return {
                id: segment.payloadId, summary: segment.summary,
                body: () => prettyListing(segment.source, segment.language, color), open: false,
            };
        }
    });
}

function eventCard(event: LogEvent, color: boolean): Card {
    const strong = (text: string, shade: number) => paint(text, shade, color, true);
    const dim = (text: string) => paint(text, 90, color);
    const parts = segmentParts(event, color);
    if (event.origin === 'script') {
        return { header: strong('\u25aa', { error: 31, warning: 33, info: 34, debug: 90 }[event.kind]), inline: true, parts };
    }
    switch (event.kind) {
        case 'model-input':
            return { header: `${strong('\u276f', 35)} ${strong(event.interaction.kind, 35)} ${dim('prompt')}`, inline: false,
                gutter: paint('\u2502', 35, color), parts };
        case 'model-output':
            return event.interaction.role === 'action'
                ? { header: `${strong('\u25cf', 36)} ${strong(event.interaction.kind, 36)} ${dim('action')}`, inline: false, parts }
                : { header: `${strong('\u25cf', 36)} ${strong(event.interaction.kind, 36)} ${dim('response')}`, inline: false, parts };
        case 'tool': {
            const ok = event.tool.status === 'success';
            const listing = parts.filter(part => typeof part !== 'string');
            return {
                header: `${ok ? strong('\u25cf', 32) : strong('\u2717', 31)} ${paint(event.tool.name, 1, color)} ${event.tool.target}`,
                inline: false,
                parts: listing.length ? listing : [dim('no output')],
            };
        }
        case 'state': return { header: strong('~', 33), inline: true, parts };
        case 'error': return { header: strong('\u2717', 31), inline: true, parts };
        case 'warning': return { header: strong('!', 33), inline: true, parts };
        case 'info': return { header: paint('\u2022', 34, color), inline: true, parts };
        case 'debug': return { header: dim('\u00b7'), inline: true, parts };
    }
}

function streamCard(stream: Stream, color: boolean): Card {
    const kind = stream.interaction.kind;
    if (stream.channel === 'reasoning') {
        return { header: paint(`\u2234 ${kind} reasoning`, 90, color), inline: false, parts: [paint(stream.text, 90, color)] };
    }
    return {
        header: `${paint('\u25cf', 36, color, true)} ${paint(kind, 36, color, true)} ${paint('responding\u2026', 90, color)}`,
        inline: false,
        parts: [kind === 'codegen' ? prettyListing(stream.text, 'javascript', color) : stream.text],
    };
}
