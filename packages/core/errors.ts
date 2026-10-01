/** An error the CLI should show as-is, with a specific exit code. */
export class SbError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}
