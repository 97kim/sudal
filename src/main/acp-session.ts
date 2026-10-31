// ACP 메타데이터를 기존 선택지로 변환한다. 제공사별 모델 ID·권한 정책은 추측하지 않는다.
import type { AvailableCommand, InitializeResponse, SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import type { SlashCommandDto } from "@shared/slash-commands";
import type { AcpConfigValueDto } from "@shared/ipc";

export function acpSlashCommands(commands: AvailableCommand[]): SlashCommandDto[] {
  const result = new Map<string, SlashCommandDto>();
  for (const command of commands) {
    const name = command.name.replace(/^\//, "");
    if (!name || /\s/.test(name)) continue;
    result.set(name, { name, description: command.description, argumentHint: command.input?.hint ?? "", source: "acp" });
  }
  return [...result.values()];
}

/** 모델·추론 강도 등 계층형 select 옵션도 ID를 바꾸지 않고 펼친다. */
export function acpSelectOptions(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type !== "select") return [];
  return option.options.flatMap(value => "group" in value ? value.options : [value]);
}

export function acpConfigValues(options: SessionConfigOption[]): AcpConfigValueDto[] {
  return options.map(option => ({
    id: option.id, name: option.name, value: String(option.currentValue),
    label: acpSelectOptions(option).find(value => value.value === option.currentValue)?.name ?? String(option.currentValue),
  }));
}

export function acpCapabilities(info: InitializeResponse) {
  const caps = info.agentCapabilities;
  return {
    loadSession: caps?.loadSession === true,
    resumeSession: caps?.sessionCapabilities?.resume != null,
    listSessions: caps?.sessionCapabilities?.list != null,
    images: caps?.promptCapabilities?.image === true,
    audio: caps?.promptCapabilities?.audio === true,
    embeddedContext: caps?.promptCapabilities?.embeddedContext === true,
  };
}
