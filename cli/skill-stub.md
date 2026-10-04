---
name: sudal-cli
description: >-
  Control the Sudal app's workspaces, tabs, and sessions (워크스페이스·탭·세션) with the `sudal` CLI.
  Sudal is a macOS app that runs Claude Code and Codex as chat tabs. Use for opening a session in Sudal,
  sending a prompt to a tab, reading a tab's reply, handing work off to another tab, or opening a file in Sudal:
  "sudal tab", "open a new session in Sudal", "send it to that tab", "read that tab's result", "hand this off",
  "sudal 탭", "Sudal 에서 새 세션 열어", "그 탭에 보내", "탭 결과 읽어", "다른 탭에 넘겨/핸드오프",
  "sudal 로 파일 열어", "$sudal-cli". Use only when the task depends on the running Sudal app's state;
  for anything else, use your usual shell tools.
---

# Sudal CLI

This stub is short. The actual commands and rules live in **the guide for the app version that is installed now**. Run this first and follow what it says:

```text
sudal skills get sudal-cli
```

- If `sudal` is missing (command not found), tell the user to install the sudal CLI under Sudal Settings > General > CLI and agent skills, and stop. Do not dig through source files.
- If a command returns `{"error":{"code":"not_running"}}`, ask the user to open the Sudal app first, and stop.
- Commands print JSON (the guide above and `--help` are plain text). When you report to a person, pick out only the fields that matter.
- Write everything the user reads in the user's language: follow their language setting, and otherwise the language of their request.
