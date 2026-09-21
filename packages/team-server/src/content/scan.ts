import { scanForSecrets } from "@promptbranch/share";
import { teamError } from "../errors.js";

/**
 * Server-side secret scanning for all new team content (contract §C8):
 * the SAME rule set as the anonymous snapshot service and the desktop warn
 * layer (packages/share), enforced here because client scans can be
 * bypassed. High findings block with SECRET_BLOCKED; medium findings ride
 * along for client preview without blocking the write. Findings are redacted
 * to field + rule + line — the matched text never leaves the scanner.
 */

export interface RedactedFinding {
  field: string;
  rule: string;
  line: number;
  severity: "high" | "medium";
}

export interface ScanOutcome {
  high: RedactedFinding[];
  medium: RedactedFinding[];
}

/** Scans named fields; throws SECRET_BLOCKED on any high finding. */
export function scanTeamContent(fields: Record<string, string>): ScanOutcome {
  const high: RedactedFinding[] = [];
  const medium: RedactedFinding[] = [];
  for (const [field, text] of Object.entries(fields)) {
    if (!text) continue;
    for (const finding of scanForSecrets(text)) {
      const redacted: RedactedFinding = { field, rule: finding.rule, line: finding.line, severity: finding.severity };
      if (finding.severity === "high") high.push(redacted);
      else medium.push(redacted);
    }
  }
  if (high.length > 0) {
    throw teamError("SECRET_BLOCKED", "Content contains potential secrets; remove them and retry", {
      details: { findings: high },
    });
  }
  return { high, medium };
}

/** UTF-8 byte ceiling for prompt content (contract §C2: 64 KiB). */
export const MAX_CONTENT_BYTES = 65_536;

export function assertContentWithinBytes(content: string, maxBytes = MAX_CONTENT_BYTES): void {
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw teamError("VALIDATION_FAILED", `Content exceeds ${maxBytes} UTF-8 bytes`);
  }
}
