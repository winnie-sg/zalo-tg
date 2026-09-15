type ShutdownHandler = (reason: string, exitCode: number) => Promise<void>;

let shutdownHandler: ShutdownHandler | null = null;
let shutdownPromise: Promise<void> | null = null;

/** Register the process-level graceful shutdown implementation. */
export function registerShutdownHandler(handler: ShutdownHandler): void {
  shutdownHandler = handler;
}

/** Whether a shutdown/restart has already been requested. */
export function isShutdownRequested(): boolean {
  return shutdownPromise !== null;
}

/** Request one idempotent graceful shutdown/restart from any module. */
export function requestShutdown(reason: string, exitCode = 0): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = shutdownHandler
    ? shutdownHandler(reason, exitCode)
    : Promise.resolve().then(() => { process.exit(exitCode); });
  return shutdownPromise;
}
