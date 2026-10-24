import { mkdirSync, watch } from "node:fs";
import path from "node:path";

import { dataRoot, readMount } from "@superpose/agent-core";

export type WatchOptions = { expectedCoreId?: string; intervalMs?: number };

/**
 * mount 指针看门狗：fs.watch 负责低延迟，200ms 轮询兜底（部分平台不派发事件）。
 * 指针消失或指向其他 Agent Core 时触发一次 onLost，之后自动停止。
 */
export function watchMount(onLost: () => void, options: WatchOptions = {}): () => void {
  const dir = path.join(dataRoot(), "terminal", "mount");
  mkdirSync(dir, { recursive: true });

  let stopped = false;
  let fired = false;

  function check(): void {
    if (stopped || fired) return;
    try {
      const pointer = readMount();
      if (options.expectedCoreId !== undefined && pointer.coreId !== options.expectedCoreId) fire();
    } catch {
      fire();
    }
  }

  function fire(): void {
    if (stopped || fired) return;
    fired = true;
    onLost();
  }

  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(dir, (_event, filename) => {
      if (filename === null || filename === "core.json") check();
    });
  } catch {
    watcher = undefined;
  }

  const timer = setInterval(check, options.intervalMs ?? 200);

  return () => {
    stopped = true;
    clearInterval(timer);
    watcher?.close();
  };
}
