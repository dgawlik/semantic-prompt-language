import type { PausedBlock, StepChoice, TerminalView } from './cli-view.js';
import type { FinishReason, LogEvent, ModelStreamEvent } from './log-events.js';
import { formatEvent, sanitize, terminalColor } from './log-format.js';

export interface TerminalCapabilities {
    stdinTTY: boolean;
    stderrTTY: boolean;
    rawMode: boolean;
    term?: string;
}

export function canInteract(capabilities: TerminalCapabilities = {
    stdinTTY: Boolean(process.stdin.isTTY), stderrTTY: Boolean(process.stderr.isTTY),
    rawMode: typeof process.stdin.setRawMode === 'function', term: process.env.TERM,
}): boolean {
    return capabilities.stdinTTY && capabilities.stderrTTY && capabilities.rawMode && capabilities.term !== 'dumb';
}

export interface MountedUi {
    unmount(): Promise<void>;
    readonly exited: Promise<unknown>;
}

interface PresentationOptions {
    interactive: boolean;
    color?: boolean;
    /** Workflow shown in the header. */
    title?: string;
    /** Stop before the first block and step with n/v/c/e. */
    debug?: boolean;
    write?: (line: string) => void;
    cancel?: () => void;
    /** Draws the view; defaults to the Ink UI on stderr. */
    mount?: (view: TerminalView) => MountedUi | Promise<MountedUi>;
}

/**
 * Presents execution logs: an Ink terminal UI when stdin and stderr are terminals,
 * otherwise append-only text on stderr. The UI leaves nothing behind on exit.
 */
export class CliLogging {
    state: 'plain' | 'starting' | 'interactive' | 'closed' = 'plain';
    private readonly history: LogEvent[] = [];
    private readonly color: boolean;
    private readonly write: (line: string) => void;
    private view?: TerminalView;
    private ui?: MountedUi;
    private startPromise?: Promise<void>;
    private closePromise?: Promise<void>;
    private printed = 0;

    constructor(private readonly options: PresentationOptions) {
        this.color = options.color ?? terminalColor();
        this.write = options.write ?? (line => { process.stderr.write(line + '\n'); });
        // Events logged before the UI starts are held for it, not printed under it.
        if (options.interactive) this.state = 'starting';
    }

    /** Whether the terminal UI owns the screen and input. */
    get interactive(): boolean {
        return this.state === 'interactive';
    }

    readonly sink = (event: LogEvent): void => {
        if (this.state === 'closed') throw new Error('logging session is closed');
        this.history.push(event);
        if (this.view) this.view.append(event);
        else if (this.state === 'plain') this.transcript();
    };

    readonly streamSink = (event: ModelStreamEvent): void => {
        if (this.state === 'closed') throw new Error('logging session is closed');
        this.view?.stream(event);
    };

    start(): Promise<void> {
        return this.startPromise ??= this.open();
    }

    private async open(): Promise<void> {
        if (!this.options.interactive) return;
        try {
            const { TerminalView } = await import('./cli-view.js');
            const view = new TerminalView({
                color: this.color, title: this.options.title ?? '', debug: this.options.debug,
                onCancel: () => this.options.cancel?.(),
            });
            for (const event of this.history) view.append(event);
            this.view = view;
            const mount = this.options.mount ?? (async (target: TerminalView) => (await import('./cli-tui.js')).mountTui(target));
            const ui = await mount(view);
            this.ui = ui;
            this.state = 'interactive';
            ui.exited.then(
                () => { if (this.ui === ui && this.state === 'interactive') this.fallback('terminal UI stopped unexpectedly'); },
                error => { if (this.ui === ui && this.state === 'interactive') this.fallback(`terminal UI: ${error instanceof Error ? error.message : String(error)}`); },
            );
        } catch (error) {
            this.fallback(`terminal UI startup: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** Reads a human answer inside the UI. Only valid while the UI is active. */
    async ask(question: string): Promise<string> {
        await this.startPromise;
        if (!this.view || this.state !== 'interactive') throw new Error('the terminal UI is not active');
        return this.view.ask(question);
    }

    /** Waits for the `--debug` stepper before a block runs. */
    async pause(block: PausedBlock): Promise<StepChoice> {
        await this.startPromise;
        return this.view && this.state === 'interactive' ? this.view.pause(block) : 'continue';
    }

    /** Ends the session. A completed or failed interactive run waits for `e` before leaving the screen. */
    close(reason: FinishReason): Promise<void> {
        return this.closePromise ??= this.finish(reason);
    }

    private async finish(reason: FinishReason): Promise<void> {
        await this.startPromise;
        const { view, ui } = this;
        if (this.state === 'interactive' && view && ui) {
            await view.finish(reason);
            this.state = 'closed';
            await ui.unmount();
        } else if (this.state === 'starting') this.transcript();
        this.state = 'closed';
    }

    private fallback(diagnostic: string): void {
        const { view, ui } = this;
        this.view = undefined;
        this.ui = undefined;
        this.state = 'plain';
        void ui?.unmount().catch(() => undefined);
        this.write(`x error ${sanitize(diagnostic)}; using append-only logs.`);
        this.transcript();
        view?.abandon(new Error(diagnostic));
    }

    private transcript(): void {
        while (this.printed < this.history.length) this.write(formatEvent(this.history[this.printed++], this.color));
    }
}
