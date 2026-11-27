import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { SearchThread, TabSearchHits } from "./search-index";

type Operation = { kind: "search"; threads: SearchThread[]; query: string } | { kind: "forget"; tabId: string };
export type SearchRequest = Operation & { id: number };
export type SearchReply = { id: number } & ({ hits: TabSearchHits[] } | { error: string });

type Pending = {
  resolve: (hits: TabSearchHits[]) => void;
  reject: (error: Error) => void;
  cleared?: Set<string>;
};

export class ChatSearchWorker {
  private worker?: Worker;
  private closed = false;
  private id = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly cachePath: string) {}

  search(threads: SearchThread[], query: string): Promise<TabSearchHits[]> {
    return this.request({ kind: "search", threads, query });
  }

  async forget(tabId: string): Promise<void> {
    // The worker may have read the old contents of a tab already.
    for (const pending of this.pending.values()) (pending.cleared ??= new Set()).add(tabId);
    if (this.worker || existsSync(this.cachePath)) await this.request({ kind: "forget", tabId });
  }

  private start(): Worker {
    const worker = new Worker(join(import.meta.dirname, "search-index-worker.js"), { workerData: this.cachePath });
    this.worker = worker;
    worker.on("message", (reply: SearchReply) => {
      if (worker !== this.worker) return;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (this.pending.size === 0) worker.unref();
      if ("error" in reply) pending.reject(new Error(reply.error));
      else {
        const cleared = pending.cleared;
        pending.resolve(cleared ? reply.hits.filter(({ tabId }) => !cleared.has(tabId)) : reply.hits);
      }
    });
    worker.on("error", (error) => this.failed(worker, error));
    worker.on("exit", (code) => this.failed(worker, new Error(`Chat search worker exited (${code})`)));
    return worker;
  }

  private async request(operation: Operation): Promise<TabSearchHits[]> {
    if (this.closed) throw new Error("Chat search worker closed");
    const worker = this.worker ?? this.start();
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.ref();
      try {
        worker.postMessage({ ...operation, id } satisfies SearchRequest);
      } catch (error) {
        this.pending.delete(id);
        if (this.pending.size === 0) worker.unref();
        reject(error);
      }
    });
  }

  private failed(worker: Worker, error: Error): void {
    if (worker !== this.worker) return;
    this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close(): void {
    this.closed = true;
    const worker = this.worker;
    if (worker) {
      this.failed(worker, new Error("Chat search worker closed"));
      void worker.terminate();
    }
  }
}
