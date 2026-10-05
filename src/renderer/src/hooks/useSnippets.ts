import { useEffect, useState } from "react";
import type { SnippetDto } from "@shared/snippets";

/** 스니펫 전체 목록. main 이 바뀔 때마다 밀어 준다. */
export function useSnippets(): SnippetDto[] {
  const [items, setItems] = useState<SnippetDto[]>([]);
  useEffect(() => {
    let alive = true;
    window.sudal.snippets.list().then((s) => alive && setItems(s)).catch(console.error);
    const off = window.sudal.snippets.onChanged((s) => setItems(s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return items;
}
