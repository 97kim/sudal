import { useEffect, useState } from "react";
import type { WorkspaceStateDto } from "@shared/ipc";
import { emptyModel } from "@shared/workspace-model";

const EMPTY: WorkspaceStateDto = { model: emptyModel(), statuses: {}, attention: {} };

/** main 이 소유하는 워크스페이스/탭 모델을 구독한다. 변경은 window.sudal.workspaces.* 로 요청. */
export function useWorkspaces(): WorkspaceStateDto {
  const [state, setState] = useState<WorkspaceStateDto>(EMPTY);
  useEffect(() => {
    let alive = true;
    const off = window.sudal.workspaces.onChanged((s) => alive && setState(s));
    window.sudal.workspaces.state().then((s) => alive && setState(s)).catch(console.error);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}
