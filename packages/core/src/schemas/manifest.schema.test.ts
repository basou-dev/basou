import { describe, expect, it } from "vitest";
import { ManifestSchema } from "./manifest.schema.js";

const VALID_MANIFEST = {
  schema_version: "0.1.0",
  basou_version: "0.1.0",
  workspace: {
    id: "ws_01HXABCDEF1234567890ABCDEF",
    name: "client-foo-lp",
    created_at: "2026-05-04T09:00:00+09:00",
    updated_at: "2026-05-04T15:30:00+09:00",
  },
  project: {
    name: "Client Foo Landing Page",
    description: "受託案件のLP改修",
    repository_url: null,
  },
  capabilities: {
    enabled: ["git", "terminal", "approval"],
  },
  approval: {
    required_for: [],
    default_risk_level: "medium",
  },
  adapters: {
    "claude-code": {
      enabled: true,
    },
  },
  git: {
    events_log: "ignore",
  },
};

describe("ManifestSchema", () => {
  it("accepts the minimal manifest example", () => {
    expect(ManifestSchema.safeParse(VALID_MANIFEST).success).toBe(true);
  });

  it("accepts repository_url: null", () => {
    const variant = {
      ...VALID_MANIFEST,
      project: { ...VALID_MANIFEST.project, repository_url: null },
    };
    expect(ManifestSchema.safeParse(variant).success).toBe(true);
  });

  it("rejects an unknown default_risk_level", () => {
    const variant = {
      ...VALID_MANIFEST,
      approval: { ...VALID_MANIFEST.approval, default_risk_level: "wild" },
    };
    expect(ManifestSchema.safeParse(variant).success).toBe(false);
  });

  it("defaults git.events_log to 'ignore' when omitted", () => {
    const variant = { ...VALID_MANIFEST, git: {} };
    const parsed = ManifestSchema.parse(variant);
    expect(parsed.git.events_log).toBe("ignore");
  });

  it("rejects when basou_version is not '0.1.0'", () => {
    const variant = { ...VALID_MANIFEST, basou_version: "0.2.0" };
    expect(ManifestSchema.safeParse(variant).success).toBe(false);
  });
});
