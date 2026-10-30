import { fork, type ChildProcess } from 'node:child_process';
import type { CellResult, ExecuteCell, WorkerReply } from './notebookProtocol';
import { isModelStreamEvent, type ModelStreamSink } from '../../lang/src/log-events.js';

export class NotebookKernel {
    private worker?: ChildProcess;
    private stopped?: string;
    private pending?: {
        id: number;
        resolve: (reply: CellResult) => void;
        reject: (error: Error) => void;
        log: (text: string, output: boolean) => void;
        stream: ModelStreamSink;
    };

    constructor(
        private readonly workerPath: string,
        private readonly cwd: string,
        private readonly nodePath: string,
        private readonly log: (text: string) => void,
    ) {}

    execute(request: ExecuteCell, log: (text: string, output: boolean) => void, stream: ModelStreamSink = () => {}): Promise<CellResult> {
        if (this.stopped) return Promise.reject(new Error(this.stopped));
        if (this.pending) return Promise.reject(new Error('another notebook cell is already running'));
        return new Promise((resolve, reject) => {
            this.pending = { id: request.id, resolve, reject, log, stream };
            try {
                if (!this.worker) {
                    this.worker = fork(this.workerPath, [], {
                        cwd: this.cwd, execPath: this.nodePath, execArgv: [], silent: true,
                        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                    });
                    this.worker.stdout?.on('data', data => this.log(String(data)));
                    this.worker.stderr?.on('data', data => this.log(String(data)));
                    this.worker.on('message', (reply: WorkerReply) => {
                        if (!this.pending || reply.id !== this.pending.id) return;
                        if (reply.kind === 'log') {
                            this.pending.log(reply.text, reply.output ?? false);
                        } else if (reply.kind === 'stream') {
                            if (!isModelStreamEvent(reply.event)) {
                                this.dispose('SPL notebook runtime sent an invalid model stream event.');
                                return;
                            }
                            try { this.pending.stream(reply.event); }
                            catch (error) { this.dispose(`Could not update streaming cell output: ${error instanceof Error ? error.message : String(error)}`); }
                        } else {
                            const pending = this.pending;
                            this.pending = undefined;
                            pending.resolve(reply);
                        }
                    });
                    this.worker.on('error', error => this.dispose(`Could not run the SPL notebook runtime: ${error.message}. Check spl.notebook.nodePath.`));
                    this.worker.on('exit', (code, signal) => this.dispose(`SPL notebook runtime exited (${signal ?? code}); rerun the cell to start a new session.`));
                }
                this.worker.send(request, error => {
                    if (error) this.dispose(`Could not send cell to the SPL notebook runtime: ${error.message}`);
                });
            } catch (error) {
                this.dispose(error instanceof Error ? error.message : String(error));
            }
        });
    }

    get isStopped(): boolean { return this.stopped !== undefined; }

    dispose(reason = 'Notebook session reset; all variables and functions were cleared.'): void {
        if (this.stopped) return;
        this.stopped = reason;
        this.log(reason);
        this.pending?.reject(new Error(reason));
        this.pending = undefined;
        this.worker?.kill();
        this.worker = undefined;
    }
}
