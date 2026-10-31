import { test } from "node:test";
import assert from "node:assert/strict";
import { userErrorMessage } from "./error-message";

test("IPC 오류는 메서드 경로와 Error·MsgError 이름 없이 안내 문장만 표시한다", () => {
  const message = "/fast on 또는 /fast off로 입력해 주세요.";
  for (const prefix of ["", "Error: ", "MsgError: ", "Error: MsgError: "]) {
    assert.equal(userErrorMessage(new Error(`Error invoking remote method 'chat:configure': ${prefix}${message}`)), message);
  }
  assert.equal(userErrorMessage(`Error invoking remote method "chat:codex-control": MsgError: ${message}`), message);
});

test("표시용 문자열로 한 번 더 감싼 IPC 오류와 중첩 IPC 오류도 정리한다", () => {
  assert.equal(userErrorMessage("Error: Error invoking remote method 'chat:configure': MsgError: 다른 작업이 끝난 뒤 실행해 주세요."), "다른 작업이 끝난 뒤 실행해 주세요.");
  assert.equal(userErrorMessage("Error invoking remote method 'outer': Error: Error invoking remote method 'inner': MsgError: Request timed out"), "Request timed out");
});

test("사용자가 판단할 수 있는 일반 오류 내용과 상세 정보는 보존한다", () => {
  for (const message of ["Authentication required", "ENOENT: C:/work/missing.txt", "권한을 변경하지 못했습니다.\n다시 시도해 주세요.", "TypeError: invalid value"]) {
    assert.equal(userErrorMessage(new Error(message)), message);
    assert.equal(userErrorMessage(message), message);
  }
});

test("본문 중간의 IPC 문구는 지우지 않으며 빈 오류도 그대로 반환한다", () => {
  const detail = "진단 내용: Error invoking remote method 'chat:configure': unavailable";
  assert.equal(userErrorMessage(new Error(detail)), detail);
  assert.equal(userErrorMessage(new Error("")), "");
});
