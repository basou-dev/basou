import { describe, expect, it } from "vitest";
import { StatusSchema } from "./status.schema.js";

const VALID_STATUS = {
  schema_version: "0.1.0",
  generated_at: "2026-05-04T09:00:00+09:00",
  workspace: {
    id: "ws_01HXABCDEF1234567890ABCDEF",
    name: "client-foo-lp",
    basou_version: "0.1.0",
  },
  directories_present: {
    sessions: true,
    tasks: true,
    approvals_pending: true,
    approvals_resolved: true,
    logs: true,
    raw: true,
    tmp: true,
  },
};

describe("StatusSchema", () => {
  it("accepts a minimal valid snapshot", () => {
    expect(StatusSchema.safeParse(VALID_STATUS).success).toBe(true);
  });

  it("pins schema_version to the exact cache literal (status.json is a rebuildable cache)", () => {
    // A cache is regenerated on any mismatch, so its own version is exact-match,
    // NOT the durable forward-compatible gate.
    expect(StatusSchema.safeParse({ ...VALID_STATUS, schema_version: "0.2.0" }).success).toBe(
      false,
    );
    expect(StatusSchema.safeParse({ ...VALID_STATUS, schema_version: "1.0.0" }).success).toBe(
      false,
    );
  });

  it("gates workspace.basou_version with the durable format gate (mirrors the manifest)", () => {
    const withBasou = (v: string) => ({
      ...VALID_STATUS,
      workspace: { ...VALID_STATUS.workspace, basou_version: v },
    });
    expect(StatusSchema.safeParse(withBasou("0.2.0")).success).toBe(true); // same major -> ok
    expect(StatusSchema.safeParse(withBasou("1.0.0")).success).toBe(false); // higher major -> gated
  });

  it("rejects a workspace.id that lacks the 'ws_' prefix", () => {
    const variant = {
      ...VALID_STATUS,
      workspace: { ...VALID_STATUS.workspace, id: "task_01HXABCDEF1234567890ABCDEF" },
    };
    expect(StatusSchema.safeParse(variant).success).toBe(false);
  });

  it("rejects when a directories_present key is missing", () => {
    const { sessions: _omitted, ...rest } = VALID_STATUS.directories_present;
    const variant = { ...VALID_STATUS, directories_present: rest };
    expect(StatusSchema.safeParse(variant).success).toBe(false);
  });

  it("rejects extra keys at every level (.strict() everywhere)", () => {
    const extraInDirs = {
      ...VALID_STATUS,
      directories_present: { ...VALID_STATUS.directories_present, future_field: false },
    };
    expect(StatusSchema.safeParse(extraInDirs).success).toBe(false);

    const extraInWorkspace = {
      ...VALID_STATUS,
      workspace: { ...VALID_STATUS.workspace, future_field: "x" },
    };
    expect(StatusSchema.safeParse(extraInWorkspace).success).toBe(false);

    const extraAtRoot = { ...VALID_STATUS, future_field: "x" };
    expect(StatusSchema.safeParse(extraAtRoot).success).toBe(false);
  });
});
