/**
 * downloadManager.ts — Progress-tracked download wrapper.
 *
 * Wraps the Tauri `download_url` command. Uses invoke from hostAPI
 * (passed by the caller) to avoid dynamic imports that fail in asset://
 * Shadow DOM contexts. Progress events from the Rust side are emitted
 * but not listened to here — the caller shows indeterminate progress
 * during the download and transitions to "done" on completion.
 */

export interface DownloadCallbacks {
  onProgress?: (bytes: number, total: number) => void;
  onComplete?: () => void;
  onError?: (err: string) => void;
}

export interface DownloadHandle {
  cancel: () => void;
}

/**
 * Downloads a URL to a file on disk.
 *
 * Uses `invoke` (from hostAPI, passed by the caller) to call the
 * Tauri `download_url` command. No longer re-imports @tauri-apps/*
 * dynamically.
 *
 * @param url    - The URL to download.
 * @param dest   - Absolute destination path on disk.
 * @param invoke - The hostAPI invoke function.
 * @param callbacks - Lifecycle callbacks.
 */
export function downloadWithProgress(
  url: string,
  dest: string,
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
  callbacks: DownloadCallbacks,
): DownloadHandle {
  let cancelled = false;

  const progressId = `mc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  invoke("download_url", { url, dest, progressId })
    .then(() => {
      if (!cancelled) {
        callbacks.onComplete?.();
      }
    })
    .catch((err: unknown) => {
      if (!cancelled) {
        callbacks.onError?.(String(err));
      }
    });

  return {
    cancel: () => {
      cancelled = true;
    },
  };
}

/**
 * Downloads and extracts a Temurin JDK of the given major version into
 * `destDir` (the instance sandbox's `jdk/` folder). Wraps the Tauri
 * `download_java` command.
 *
 * Progress events from the Rust side are emitted but not listened to here —
 * the caller shows indeterminate progress during the download and transitions
 * to "done" on completion, matching `downloadWithProgress`.
 */
/** A detected/installed JDK, returned by the `download_java` command. */
export interface JavaInstallResult {
  path: string;
  version: string;
  majorVersion: number;
}

export function downloadJava(
  major: number,
  destDir: string,
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
  callbacks: Omit<DownloadCallbacks, "onComplete"> & {
    onComplete?: (install: JavaInstallResult) => void;
  },
): DownloadHandle {
  let cancelled = false;

  const progressId = `jdk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  invoke("download_java", { major, destDir, progressId })
    .then((result) => {
      if (!cancelled) {
        callbacks.onComplete?.(result as JavaInstallResult);
      }
    })
    .catch((err: unknown) => {
      if (!cancelled) {
        callbacks.onError?.(String(err));
      }
    });

  return {
    cancel: () => {
      cancelled = true;
    },
  };
}
