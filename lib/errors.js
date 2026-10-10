/**
 * One error type for every failure the CLI reports, with a defined exit code.
 *
 * bin/valorbrain.js catches it once: with --json the error goes to stdout as
 * `{ ok: false, error, code, exit_code, ...extra }`; without, to stderr as
 * `error: <message>`. Commands never call process.exit on failure.
 */
export const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1, // the server or the network failed the request
  USAGE: 2, // unknown command or flag, missing or invalid value
  AUTH: 3, // no credential, wrong credential type, or rejected by the server (401/403)
});

export class CliError extends Error {
  /**
   * @param {string} message human-readable, also the JSON `error`
   * @param {{ code?: string, exit?: number, extra?: object }} [opts]
   */
  constructor(message, { code = "error", exit = EXIT.FAILURE, extra = {} } = {}) {
    super(message);
    this.code = code;
    this.exit = exit;
    this.extra = extra;
  }
}

export const usage = (message, code = "usage", extra) => new CliError(message, { code, exit: EXIT.USAGE, extra });
export const authError = (message, code = "no_credential", extra) => new CliError(message, { code, exit: EXIT.AUTH, extra });
