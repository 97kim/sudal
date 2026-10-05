/**
 * 누른 채 끄는 동안 onMove 를 부르고, 놓으면 리스너를 뗀다. 창 전체에 다는 것은 핸들 밖으로 벗어나도 따라가게 하려고.
 * cursor 를 주면 끄는 동안 문서 전체의 커서를 그 모양으로 둔다.
 */
export function startDrag(onMove: (e: MouseEvent) => void, cursor?: string): void {
  const up = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", up);
    if (cursor) document.body.style.cursor = "";
  };
  if (cursor) document.body.style.cursor = cursor;
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", up);
}
