import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type { DevChild } from "./dev-config";

/**
 * Minimal process supervisor for the local development chains.
 *
 * The children are started in their own process group so a Ctrl-C reaches the
 * real `go run` binary / pnpm wrapper instead of only the shell. A non-zero
 * child exit tears the rest of the chain down and is returned to the caller as
 * the launcher's exit code; no child is left running after shutdown.
 *
 * `go run` is a wrapper: it can exit on SIGTERM while the compiled server is
 * still draining, so the controller waits for the process group to disappear
 * before it resolves and keeps the SIGKILL fallback armed for the group.
 */

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdio: "inherit";
    detached: boolean;
  },
) => ChildProcess;

export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface RunChildrenOptions {
  spawnImpl?: SpawnImpl;
  signalSource?: SignalSource;
  /** Grace period between SIGTERM and SIGKILL during teardown. */
  killTimeoutMs?: number;
}

const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
};

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function isProcessGroupAlive(pid: number): boolean {
  if (process.platform === "win32") {
    return false;
  }
  try {
    // Signal 0 checks for the process group without delivering a signal.
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    if (isRunning(child)) {
      child.kill(signal);
    }
    return;
  }
  try {
    // Negative PID signals the whole group, including the go run wrapper's
    // compiled child even after the wrapper itself has exited.
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH" && isRunning(child)) {
      child.kill(signal);
    }
  }
}

/**
 * Run every child and resolve with the process exit code the CLI should expose.
 *
 * Resolves:
 * - the first non-zero child exit code;
 * - 128+signal when the launcher itself is interrupted (130 for SIGINT,
 *   143 for SIGTERM);
 * - 0 when every child exits cleanly.
 */
export function runChildren(
  children: DevChild[],
  options: RunChildrenOptions = {},
): Promise<number> {
  const spawnImpl: SpawnImpl =
    options.spawnImpl ??
    ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const signalSource = options.signalSource ?? process;
  const killTimeoutMs = options.killTimeoutMs ?? 65_000;

  if (children.length === 0) {
    return Promise.resolve(0);
  }

  return new Promise<number>((resolve) => {
    const started: ChildProcess[] = [];
    const alive = new Set<ChildProcess>();
    const listeners: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
    let shuttingDown = false;
    let settled = false;
    let finalExitCode = 0;
    let killTimer: NodeJS.Timeout | undefined;
    let groupPoll: NodeJS.Timeout | undefined;

    const removeSignalListeners = (): void => {
      for (const { signal, handler } of listeners) {
        signalSource.off(signal, handler);
      }
      listeners.length = 0;
    };

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      if (groupPoll) {
        clearInterval(groupPoll);
        groupPoll = undefined;
      }
      removeSignalListeners();
      resolve(finalExitCode);
    };

    const groupsAlive = (): boolean =>
      started.some(
        (child) => typeof child.pid === "number" && isProcessGroupAlive(child.pid),
      );

    const maybeFinish = (): void => {
      if (alive.size === 0 && !groupsAlive()) {
        finish();
      }
    };

    const ensureGroupPoll = (): void => {
      if (!groupPoll) {
        // A go run wrapper can exit before the compiled binary finishes its
        // own 30s graceful drain; poll the process group until it is gone.
        groupPoll = setInterval(maybeFinish, 100);
      }
    };

    const beginShutdown = (
      exitCode: number,
      signal: NodeJS.Signals = "SIGTERM",
    ): void => {
      if (exitCode > finalExitCode) {
        finalExitCode = exitCode;
      }
      if (shuttingDown) {
        maybeFinish();
        return;
      }
      shuttingDown = true;
      for (const child of started) {
        signalProcessGroup(child, signal);
      }
      killTimer = setTimeout(() => {
        for (const child of started) {
          signalProcessGroup(child, "SIGKILL");
        }
      }, killTimeoutMs);
      ensureGroupPoll();
      maybeFinish();
    };

    for (const spec of children) {
      const child = spawnImpl(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: "inherit",
        detached: process.platform !== "win32",
      });
      started.push(child);
      alive.add(child);

      child.on("error", (error) => {
        process.stderr.write(
          `[dev] ${spec.name} failed to start: ${error.message}\n`,
        );
        alive.delete(child);
        beginShutdown(1);
      });

      child.on("exit", (code, signal) => {
        alive.delete(child);
        if (shuttingDown) {
          ensureGroupPoll();
          maybeFinish();
          return;
        }
        if (code !== null && code !== 0) {
          beginShutdown(code);
          return;
        }
        if (signal !== null) {
          // A child killed by an external signal is a failure of the chain.
          beginShutdown(128 + (SIGNAL_NUMBERS[signal] ?? 0));
          return;
        }
        // One server exited cleanly on its own; stop the rest instead of
        // leaving half a development chain behind.
        beginShutdown(0);
      });
    }

    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of signals) {
      const handler = (): void => {
        beginShutdown(128 + (SIGNAL_NUMBERS[signal] ?? 0), signal);
      };
      signalSource.on(signal, handler);
      listeners.push({ signal, handler });
    }
  });
}
