// 분할 화면에서 "이 칸이 포커스된 칸인가". 창 전체에 거는 키 리스너(승인 창 Enter/Esc, 모달 Esc, 브라우저 명령)가
// 두 칸에서 같이 반응하지 않게 한다. App 이 칸마다 PaneFocusContext 로 알려 준다 — DOM 위치가 아니라 React 트리를 따르므로
// document.body 로 portal 한 모달(변경 리뷰·팬아웃 비교·오케스트레이션)도 자기 칸을 안다. 분할이 아니면 늘 true.
import { createContext, useContext, useRef, type MutableRefObject } from "react";

export const PaneFocusContext = createContext(true);

/** 리스너 안에서 읽을 최신 값. 리스너를 다시 걸지 않아도 포커스가 바뀌면 따라온다. */
export function usePaneFocusRef(): MutableRefObject<boolean> {
  const focused = useContext(PaneFocusContext);
  const ref = useRef(focused);
  ref.current = focused;
  return ref;
}

/** 분할 중인가(칸 안이면서 포커스가 아닐 수 있는 상황). RightPanel 이 분할 중엔 기본으로 접는 데 쓴다. */
export const PaneSplitContext = createContext(false);

