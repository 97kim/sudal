import { parentPort, workerData } from "node:worker_threads";
import type { SearchReply, SearchRequest } from "./chat-search-worker";
import { SearchIndex } from "./search-index";

const port = parentPort;
if (!port || typeof workerData !== "string") throw new Error("Chat search worker requires a cache path");
const index = new SearchIndex(workerData);
port.on("message", (request: SearchRequest) => {
  const { id } = request;
  try {
    if (request.kind === "forget") index.forget(request.tabId);
    const hits = request.kind === "search" ? index.search(request.threads, request.query) : [];
    port.postMessage({ id, hits } satisfies SearchReply);
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies SearchReply);
  }
});
