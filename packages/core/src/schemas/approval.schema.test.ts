import { describe, expect, it } from "vitest";
import { ApprovalSchema } from "./approval.schema.js";

const VALID_PENDING = {
  schema_version: "0.1.0",
  id: "appr_01HXABCDEF1234567890ABCDEF",
  session_id: "ses_01HXSEABCDEF1234567890ABCD",
  created_at: "2026-05-04T10:00:00+09:00",
  status: "pending",
  risk_level: "medium",
  action: { kind: "shell_command", command: "rm -rf dist" },
  reason: "Destructive command requires approval",
  expires_at: "2026-05-04T10:30:00+09:00",
  resolver: null,
  resolved_at: null,
  note: null,
  rejection_reason: null,
};

describe("ApprovalSchema", () => {
  it("accepts a valid pending approval with every field set", () => {
    const result = ApprovalSchema.safeParse(VALID_PENDING);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("pending");
      expect(result.data.resolver).toBeNull();
      // passthrough preserves adapter-defined action fields.
      expect((result.data.action as { command?: string }).command).toBe("rm -rf dist");
    }
  });

  it("accepts an approved approval with resolver and resolved_at set", () => {
    const variant = {
      ...VALID_PENDING,
      status: "approved",
      resolver: "local-cli",
      resolved_at: "2026-05-04T10:01:23+09:00",
      note: "Reviewed by team lead",
    };
    const result = ApprovalSchema.safeParse(variant);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("approved");
      expect(result.data.note).toBe("Reviewed by team lead");
    }
  });

  it("accepts a rejected approval with rejection_reason set", () => {
    const variant = {
      ...VALID_PENDING,
      status: "rejected",
      resolver: "local-cli",
      resolved_at: "2026-05-04T10:01:23+09:00",
      rejection_reason: "Destructive without backup",
    };
    const result = ApprovalSchema.safeParse(variant);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("rejected");
      expect(result.data.rejection_reason).toBe("Destructive without backup");
    }
  });

  it("rejects an id without the appr_ prefix", () => {
    const variant = { ...VALID_PENDING, id: "app_01HXABCDEF1234567890ABCDEF" };
    expect(ApprovalSchema.safeParse(variant).success).toBe(false);
  });

  it("rejects an unknown status value", () => {
    const variant = { ...VALID_PENDING, status: "unknown" };
    expect(ApprovalSchema.safeParse(variant).success).toBe(false);
  });
});
