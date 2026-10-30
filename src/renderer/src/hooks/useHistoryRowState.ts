import { createContext, useContext, useState, type Dispatch, type SetStateAction } from "react";

export const HistoryRowContext = createContext<string | null>(null);
const values = new Map<string, unknown>();
const MAX_ROW_STATES = 2000;

/** Tiny UI choices survive virtual unmounts; bodies and images are never cached here. */
export function useHistoryRowState<T>(slot: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const row = useContext(HistoryRowContext);
  const key = row ? `${row}:${slot}` : null;
  const [value, setValue] = useState<T>(() => key && values.has(key) ? values.get(key) as T : typeof initial === "function" ? (initial as () => T)() : initial);
  const update: Dispatch<SetStateAction<T>> = (action) => setValue((previous) => {
    const next = typeof action === "function" ? (action as (v: T) => T)(previous) : action;
    if (key) {
      values.delete(key);
      values.set(key, next);
      if (values.size > MAX_ROW_STATES) values.delete(values.keys().next().value!);
    }
    return next;
  });
  return [value, update];
}
