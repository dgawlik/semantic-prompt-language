/** Quotes a file path for the shell of the integrated terminal. */
function quote(file: string, platform: NodeJS.Platform): string {
    // Windows paths cannot contain double quotes, and cmd knows no other quoting; POSIX shells take everything literally in single quotes.
    return platform === 'win32' ? `"${file}"` : `'${file.replaceAll("'", "'\\''")}'`;
}

/** The command line that runs a workflow, or steps through it with `--debug`. */
export function commandLine(executable: string, file: string, debug: boolean, platform: NodeJS.Platform = process.platform): string {
    return `${executable.trim() || 'spl'} run ${quote(file, platform)}${debug ? ' --debug' : ''}`;
}
