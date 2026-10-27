export interface ExecuteCell {
    id: number;
    value: string;
    language: string;
    frontmatter: string;
    source: string;
    version?: number;
}

export type WorkerReply =
    | { id: number; kind: 'log'; text: string; output?: boolean }
    | { id: number; kind: 'result'; text?: string }
    | { id: number; kind: 'error'; message: string; line: number; column: number; source: string; version?: number };
