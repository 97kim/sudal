import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

export interface VirtualRow { key: string; gap: number; estimate: number }
export interface VirtualRowsApi { reveal(key: string): void }

/** Variable-height rows. Keep the visible row anchored when history is prepended or measured. */
export function VirtualRows({ rows, container, following, api, render }: {
  rows: VirtualRow[];
  container: RefObject<HTMLDivElement | null>;
  following: RefObject<boolean>;
  api: RefObject<VirtualRowsApi | null>;
  render(index: number): ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const nodes = useRef(new Map<string, HTMLElement>());
  const refs = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const [tick, setTick] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 900 });
  const layouts = useMemo(() => {
    let start = 0;
    return rows.map((row) => {
      const height = heights.current.get(row.key) ?? row.estimate;
      const item = { ...row, start, height };
      start += height + row.gap;
      return item;
    });
  }, [rows, tick]);
  const previous = useRef(layouts);
  const previousOrigin = useRef(0);
  const origin = () => {
    const el = container.current, wrapper = root.current;
    return el && wrapper ? wrapper.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop : 0;
  };
  const readViewport = () => {
    const el = container.current;
    if (!el) return;
    const top = Math.max(0, el.scrollTop - origin());
    const height = el.clientHeight;
    setViewport((v) => v.top === top && v.height === height ? v : { top, height });
  };
  useLayoutEffect(() => {
    const el = container.current;
    const old = previous.current;
    const nextOrigin = origin();
    if (el && !following.current && old !== layouts && old.length) {
      const top = Math.max(0, el.scrollTop - previousOrigin.current);
      const anchor = old.find((row) => row.start >= top) ?? old.at(-1);
      const next = anchor && layouts.find((row) => row.key === anchor.key);
      if (anchor && next) el.scrollTop += next.start - anchor.start + nextOrigin - previousOrigin.current;
    }
    previous.current = layouts;
    previousOrigin.current = nextOrigin;
    const keys = new Set(rows.map((r) => r.key));
    for (const key of heights.current.keys()) if (!keys.has(key)) heights.current.delete(key);
    for (const key of refs.current.keys()) if (!keys.has(key)) refs.current.delete(key);
    api.current = { reveal(key) {
      const row = layouts.find((r) => r.key === key);
      if (row && el) {
        el.scrollTop = origin() + row.start - Math.max(0, (el.clientHeight - row.height) / 2);
        readViewport();
      }
    } };
    readViewport();
  });
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    let frame = 0;
    const scroll = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; readViewport(); });
    };
    const resize = new ResizeObserver(scroll);
    resize.observe(el);
    el.addEventListener("scroll", scroll, { passive: true });
    readViewport();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); el.removeEventListener("scroll", scroll); api.current = null; };
  }, [container]);
  const resize = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        const key = node.dataset.virtualRow!;
        const height = node.getBoundingClientRect().height;
        if (Math.abs((heights.current.get(key) ?? -1) - height) > 0.5) { heights.current.set(key, height); changed = true; }
      }
      if (changed) setTick((n) => n + 1);
    });
    resize.current = observer;
    for (const node of nodes.current.values()) observer.observe(node);
    return () => { observer.disconnect(); resize.current = null; };
  }, []);
  const total = layouts.length ? layouts.at(-1)!.start + layouts.at(-1)!.height : 0;
  const rowRef = (key: string) => {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = (node) => {
        const old = nodes.current.get(key);
        if (old) resize.current?.unobserve(old);
        if (node) { nodes.current.set(key, node); resize.current?.observe(node); }
        else nodes.current.delete(key);
      };
      refs.current.set(key, ref);
    }
    return ref;
  };
  return <div ref={root} data-virtual-list style={{ position: "relative", height: total, overflowAnchor: "none" }}>
    {layouts.map((row, index) => {
      if (row.start + row.height < viewport.top - 800 || row.start > viewport.top + viewport.height + 800) return null;
      return <div key={row.key} data-virtual-row={row.key}
        ref={rowRef(row.key)}
        style={{ position: "absolute", top: row.start, left: 0, right: 0 }}>
        {render(index)}
      </div>;
    })}
  </div>;
}
