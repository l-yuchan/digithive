import type { CapabilityGroup } from "../core/executor";

/**
 * A capability is a promise about *what* a script run may reach, not about which
 * tool happens to exist today. The map is the single place the pair is written
 * down, so adding a tool without granting it cannot widen the surface.
 */
export const CAPABILITY_TOOLS: Readonly<Record<CapabilityGroup, readonly string[]>> = {
  "workflow.read": ["workflow_list", "workflow_detail", "schedule_list", "schedule_detail"],
  "workflow.write": ["workflow_create", "workflow_edit", "workflow_delete"],
  "workflow.run": ["workflow_run"],
  "schedule.write": ["schedule_create", "schedule_edit", "schedule_delete"],
  "memory.read": ["memory_recall"],
  "memory.write": ["memory_note", "memory_correct"],
  "mail.send": ["push_send", "briefing_compose"],
  "account.read": ["account_list", "source_collect"],
  "files.read": ["stored_file_list", "stored_file_read"],
};

export function allowedTools(capabilities: readonly CapabilityGroup[]): Set<string> {
  const allowed = new Set<string>();
  for (const capability of capabilities) {
    for (const tool of CAPABILITY_TOOLS[capability]) allowed.add(tool);
  }
  return allowed;
}

export function describeCapabilities(capabilities: readonly CapabilityGroup[]): string {
  return capabilities.length === 0
    ? "이 스크립트는 내부 도구에 접근할 수 없습니다(허용된 기능 없음)."
    : capabilities
        .map((capability) => `${capability}: ${CAPABILITY_TOOLS[capability].join(", ")}`)
        .join("\n");
}
