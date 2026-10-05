import type { common as ko } from "../ko/common";
import type { DeepPartial } from "../types";

export const common: DeepPartial<typeof ko> = {
  save: "Save",
  cancel: "Cancel",
  close: "Close",
  delete: "Delete",
  apply: "Apply",
  edit: "Edit",
  rename: "Rename",
  refresh: "Refresh",
  open: "Open",
  loading: "Loading…",
  none: "None",
  on: "On",
  off: "Off",
  elapsedMinSec: "{{min}}m {{sec}}s",
  elapsedSec: "{{sec}}s",
};
