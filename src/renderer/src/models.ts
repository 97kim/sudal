// provider 별 모델 목록. main 이 CLI 에 물어 온 목록을 쓰고, 오기 전엔 정적 폴백을 보여 준다.
import { useEffect, useState } from "react";
import type { ModelOptionDto, Provider } from "@shared/ipc";
import { STATIC_MODELS } from "@shared/models";

export { modelOptions } from "@shared/models";

const memo = new Map<Provider, ModelOptionDto[]>();

/** provider 의 모델 목록(CLI 조회). 처음엔 정적 목록, 조회가 끝나면 교체. source 는 표시용. */
export function useModels(provider: Provider): { models: ModelOptionDto[]; source: "cli" | "static" | "loading" } {
  const [state, setState] = useState<{ provider: Provider; models: ModelOptionDto[]; source: "cli" | "static" | "loading" }>(() => ({ provider, models: memo.get(provider) ?? STATIC_MODELS[provider], source: memo.has(provider) ? "cli" : "loading" }));
  useEffect(() => {
    let alive = true;
    const cached = memo.get(provider);
    setState({ provider, models: cached ?? STATIC_MODELS[provider], source: cached ? "cli" : "loading" });
    window.sudal.app
      .models(provider)
      .then((r) => {
        if (!alive) return;
        if (r.source === "cli") memo.set(provider, r.models);
        setState({ provider, models: r.models, source: r.source });
      })
      .catch(() => alive && setState({ provider, models: STATIC_MODELS[provider], source: "static" }));
    return () => {
      alive = false;
    };
  }, [provider]);
  return state.provider === provider ? state : { models: memo.get(provider) ?? STATIC_MODELS[provider], source: "loading" };
}
