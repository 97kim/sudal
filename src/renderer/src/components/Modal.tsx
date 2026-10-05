import type { ReactNode } from "react";

/**
 * 어두운 배경 위의 패널. 배경을 누르면 닫히고, 패널 안의 클릭은 배경까지 가지 않는다.
 *   window  — 창 전체를 덮는 큰 화면(포털로 띄우는 것들)
 *   pane    — 채팅 칸 안에서 뜨는 작은 확인 창
 *   palette — 위쪽에 붙는 검색·전환 창
 * 키 처리(Esc·방향키·Enter)는 창마다 달라서 각자 한다.
 */
const BACKDROP = {
  window: "fixed inset-0 z-40 flex items-center justify-center bg-overlay/60 p-5",
  pane: "absolute inset-0 z-20 flex items-center justify-center bg-overlay/60",
  palette: "absolute inset-0 z-30 flex items-start justify-center bg-overlay/50 pt-24",
} as const;

export function Modal({
  variant,
  onClose,
  className,
  children,
  ...data
}: {
  variant: keyof typeof BACKDROP;
  onClose: () => void;
  /** 패널의 크기·배치. 테두리·배경·그림자는 공통이다. */
  className: string;
  children: ReactNode;
} & { [k: `data-${string}`]: boolean }) {
  return (
    <div className={BACKDROP[variant]} onClick={onClose} {...data}>
      <div className={`rounded-xl border border-line bg-panel shadow-2xl ${className}`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
