import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { shellQuote } from "./codex-lang-hooks";

test("shellQuote: 공백·작은따옴표·$ 가 든 경로도 셸에서 그대로 한 인자다", () => {
  for (const p of ["/Users/a/Library/Application Support/Sudal/codex-hooks/x.sh", "/tmp/it's here/x.sh", "/tmp/$(touch pwned)/`id`/x.sh"]) {
    assert.equal(execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(p)}`], { encoding: "utf8" }), p);
  }
});
