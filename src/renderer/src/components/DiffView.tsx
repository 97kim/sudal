import { useMemo, useState } from "react";
import { diffLines } from "diff";
import { useTranslation } from "react-i18next";

const MAX_LINES = 400;

/** 긴 diff 는 앞 400줄만 그리고, 나머지는 눌러서 펼친다. 승인 카드에서 뒷부분을 못 보고 허용하는 일이 없게 늘 펼칠 길을 둔다. */
function useLimit(total: number) {
  const [all, setAll] = useState(false);
  return { limit: all ? total : MAX_LINES, more: all ? 0 : Math.max(0, total - MAX_LINES), showAll: () => setAll(true) };
}

function MoreLines({ count, onClick }: { count: number; onClick: () => void }) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return (
    <button type="button" onClick={onClick} className="mt-1 text-accent hover:underline" data-diff-more>
      … {t("panel.diff.showMoreLines", { count })}
    </button>
  );
}

/** unified diff 문자열(Codex fileChange 의 diff·팬아웃 비교)을 줄 단위로 색칠한다. 파일 헤더(diff --git/index/---/+++)는 숨기고 hunk 헤더(@@)는 흐리게. */
export function UnifiedDiff({ diff }: { diff: string }) {
  const rows = useMemo(
    () =>
      diff
        .replace(/\n$/, "")
        .split("\n")
        .filter((l) => !/^(---|\+\+\+) |^diff --git |^index [0-9a-f]+\.\.|^(new|deleted) file mode |^similarity index |^rename (from|to) /.test(l)),
    [diff],
  );
  const { limit, more, showAll } = useLimit(rows.length);
  const shown = rows.slice(0, limit);
  return (
    <pre className="diff mono overflow-x-auto rounded-md border border-line bg-inset p-2 leading-5" style={{ userSelect: "text" }}>
      {/* 줄 배경이 가로 스크롤 끝까지 이어지게 — 줄 칸은 기본으로 보이는 너비까지만 늘어난다 */}
      <div className="w-max min-w-full">
        {shown.map((line, i) => {
          const sign = line[0];
          const cls = sign === "+" ? "bg-ok-bg text-ok" : sign === "-" ? "bg-err-bg text-err" : sign === "@" ? "text-muted-2" : "text-muted";
          return (
            <div key={i} className={cls}>
              {line}
            </div>
          );
        })}
      </div>
      <MoreLines count={more} onClick={showAll} />
    </pre>
  );
}

/** old → new 라인 diff. Edit 툴의 old_string/new_string, Write 의 content(old="") 에 쓴다. */
export function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const rows = useMemo(() => {
    const parts = diffLines(oldText, newText);
    const out: { sign: " " | "+" | "-"; text: string }[] = [];
    for (const p of parts) {
      const sign = p.added ? "+" : p.removed ? "-" : " ";
      const lines = p.value.replace(/\n$/, "").split("\n");
      for (const line of lines) out.push({ sign, text: line });
    }
    return out;
  }, [oldText, newText]);

  const { limit, more, showAll } = useLimit(rows.length);
  const shown = rows.slice(0, limit);
  return (
    <pre className="diff mono overflow-x-auto rounded-md border border-line bg-inset p-2 leading-5" style={{ userSelect: "text" }}>
      <div className="w-max min-w-full">
        {shown.map((r, i) => (
          <div
            key={i}
            className={
              r.sign === "+"
                ? "bg-ok-bg text-ok"
                : r.sign === "-"
                  ? "bg-err-bg text-err"
                  : "text-muted"
            }
          >
            <span className="inline-block w-4 select-none opacity-70">{r.sign}</span>
            {r.text}
          </div>
        ))}
      </div>
      <MoreLines count={more} onClick={showAll} />
    </pre>
  );
}
