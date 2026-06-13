/**
 * Telemetry: a tiny dependency-free structured logger.
 *
 * Each call emits a single line of JSON to stdout shaped as
 * `{ ts, level, component, msg, ...fields }`, where `ts` is unix milliseconds.
 * No dependencies, no buffering — one `console.log` per call.
 */

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** JSON.stringify replacer so bigint values (reward amounts) don't throw. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Create a structured logger bound to a component name. */
export function makeLogger(component: string): Logger {
  function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    const record: Record<string, unknown> = {
      ts: Date.now(),
      level,
      component,
      msg,
      ...fields,
    };
    console.log(JSON.stringify(record, replacer));
  }
  return {
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
