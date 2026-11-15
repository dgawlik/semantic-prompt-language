import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text, render, useInput, useWindowSize } from 'ink';
import type { TerminalView } from './cli-view.js';

function App({ view }: { view: TerminalView }) {
    useSyncExternalStore(view.subscribe, view.snapshot);
    const { columns, rows } = useWindowSize();
    const [tick, setTick] = useState(0);
    const animating = view.animating;
    useEffect(() => {
        if (!animating) return;
        const timer = setInterval(() => setTick(value => value + 1), 100);
        return () => clearInterval(timer);
    }, [animating]);
    useInput((input, key) => view.key(input, key));
    // One row short of the screen: a full-height frame makes some terminals redraw everything.
    const frame = view.frame(columns, rows - 1, tick);
    return (
        <Box flexDirection="column" width={columns}>
            <Text wrap="truncate-end">{frame.header}</Text>
            <Box flexDirection="column" height={frame.viewport}>
                {frame.rows.map((row, index) => <Text key={index} wrap="truncate-end">{row || ' '}</Text>)}
            </Box>
            <Box borderStyle="round" flexDirection="column" paddingX={1}>
                {frame.footer.map((line, index) => <Text key={index} wrap="truncate-end">{line || ' '}</Text>)}
            </Box>
            <Text wrap="truncate-end">{frame.hints}</Text>
        </Box>
    );
}

export interface MountedTui {
    unmount(): Promise<void>;
    /** Settles when Ink stops; rejects if rendering failed. */
    readonly exited: Promise<unknown>;
}

export interface TuiStreams {
    stdout: NodeJS.WriteStream;
    stdin: NodeJS.ReadStream;
}

/** Draws the view on the alternate screen of stderr, so stdout keeps only the workflow result. */
export function mountTui(view: TerminalView, streams: TuiStreams = { stdout: process.stderr, stdin: process.stdin }): MountedTui {
    const instance = render(<App view={view} />, {
        stdout: streams.stdout, stdin: streams.stdin, stderr: streams.stdout,
        exitOnCtrlC: false, patchConsole: false, alternateScreen: true, interactive: true,
    });
    const exited = instance.waitUntilExit();
    return {
        exited,
        async unmount() {
            instance.unmount();
            await exited.catch(() => undefined);
        },
    };
}
