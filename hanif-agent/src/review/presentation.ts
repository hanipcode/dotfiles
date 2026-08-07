import type { CanonicalFinding, ReviewResult } from "./domain.ts"

/** Remove terminal control sequences while preserving ordinary review prose. */
export function reviewText(value: string, singleLine = false): string {
  const stripped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "").replace(/\r/g, "")
  return singleLine ? stripped.replace(/[\n\t]+/g, " ") : stripped
}

const location = (finding: CanonicalFinding): string => {
  if (finding.location === null) return ""
  const line = finding.location.line === null ? "" : `:${finding.location.line}`
  return `\n\nLocation: \`${reviewText(finding.location.path, true).replace(/`/g, "'")}${line}\``
}

/** Format active findings as a paste-ready Markdown review. */
export function reviewMarkdown(result: ReviewResult): string {
  const active = result.findings.filter((finding) => finding.status === "new" || finding.status === "open")
  const findings = active.map((finding) => `## ${finding.severity.toUpperCase()}: ${reviewText(finding.title, true)}${location(finding)}

${reviewText(finding.impact)}

**Evidence:** ${reviewText(finding.evidence)}${finding.rule === null ? "" : `\n\n**Rule:** ${reviewText(finding.rule)}`}`).join("\n\n")
  return `# Adversarial Review

**Status:** ${result.complete ? "Complete" : "Incomplete"}  
**Branch:** \`${reviewText(result.branch, true).replace(/`/g, "'")}\`  
**Base:** \`${reviewText(result.baseRef, true).replace(/`/g, "'")}\`  
**Mode:** ${result.mode}

${reviewText(result.summary)}

${findings || "No active findings."}
`
}
