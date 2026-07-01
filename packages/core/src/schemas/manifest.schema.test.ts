import { describe, expect, it } from "vitest";
import { ManifestSchema, unknownManifestKeys } from "./manifest.schema.js";

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

  it("preserves an unknown project key (loose) so a legacy repository_url survives read", () => {
    // The field was removed from the schema; ProjectSchema stays loose so a
    // legacy value is not rejected on read (writeManifest strips it on rewrite).
    const variant = {
      ...VALID_MANIFEST,
      project: { ...VALID_MANIFEST.project, repository_url: "https://example.com/old.git" },
    };
    const result = ManifestSchema.safeParse(variant);
    expect(result.success).toBe(true);
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

  it("accepts a same-major basou_version (forward-compatible) but gates a higher major", () => {
    expect(ManifestSchema.safeParse({ ...VALID_MANIFEST, basou_version: "0.2.0" }).success).toBe(
      true,
    );
    expect(ManifestSchema.safeParse({ ...VALID_MANIFEST, basou_version: "1.0.0" }).success).toBe(
      false,
    );
  });

  it("accepts import.source_roots with relative paths (host '.' plus a sibling)", () => {
    const variant = {
      ...VALID_MANIFEST,
      import: { source_roots: [".", "../basou-workspace"] },
    };
    expect(ManifestSchema.safeParse(variant).success).toBe(true);
  });

  it("accepts a manifest with no import block (backward compatible)", () => {
    expect("import" in VALID_MANIFEST).toBe(false);
    expect(ManifestSchema.safeParse(VALID_MANIFEST).success).toBe(true);
  });

  it("rejects an absolute path in import.source_roots", () => {
    const variant = {
      ...VALID_MANIFEST,
      import: { source_roots: ["/Users/example/projects/basou"] },
    };
    expect(ManifestSchema.safeParse(variant).success).toBe(false);
  });

  it("rejects a '~'-prefixed (home-expansion) path in import.source_roots", () => {
    const variant = {
      ...VALID_MANIFEST,
      import: { source_roots: ["~/projects/basou"] },
    };
    expect(ManifestSchema.safeParse(variant).success).toBe(false);
  });

  it("rejects an empty string entry in import.source_roots", () => {
    const variant = { ...VALID_MANIFEST, import: { source_roots: [""] } };
    expect(ManifestSchema.safeParse(variant).success).toBe(false);
  });

  it("rejects a backslash anywhere in an import.source_roots entry", () => {
    for (const bad of ["..\\basou", "foo\\bar", "\\\\unc\\share"]) {
      const variant = { ...VALID_MANIFEST, import: { source_roots: [bad] } };
      expect(ManifestSchema.safeParse(variant).success).toBe(false);
    }
  });

  it("rejects a Windows drive-letter path in import.source_roots", () => {
    const variant = { ...VALID_MANIFEST, import: { source_roots: ["C:/projects/basou"] } };
    expect(ManifestSchema.safeParse(variant).success).toBe(false);
  });

  it("rejects leading/trailing whitespace in a source root (a leading space must not shield a forbidden first char)", () => {
    // " ~/x" would pass without the guard (the body matched the space); it must not,
    // because `project sync` trims before persisting and a padded source root also
    // resolves to a missed repo while sync wrongly reports it covered.
    for (const bad of [
      " ~/secrets",
      " /etc",
      " C:foo",
      " ../bio",
      "../bio ",
      " ../bio ",
      "../bio\t",
    ]) {
      const variant = { ...VALID_MANIFEST, import: { source_roots: [bad] } };
      expect(ManifestSchema.safeParse(variant).success, bad).toBe(false);
    }
  });

  it("rejects leading/trailing whitespace in a repos entry path", () => {
    for (const bad of [" ../bio", "../bio ", " ~/x"]) {
      const variant = { ...VALID_MANIFEST, repos: [{ path: bad }] };
      expect(ManifestSchema.safeParse(variant).success, bad).toBe(false);
    }
  });

  it("still accepts interior whitespace in a path (a legitimate directory name)", () => {
    const variant = {
      ...VALID_MANIFEST,
      import: { source_roots: ["../my dir", "."] },
      repos: [{ path: "../my dir" }],
    };
    expect(ManifestSchema.safeParse(variant).success).toBe(true);
  });

  it("rejects an empty import.source_roots array", () => {
    const variant = { ...VALID_MANIFEST, import: { source_roots: [] } };
    expect(ManifestSchema.safeParse(variant).success).toBe(false);
  });

  it("accepts a repos roster with relative paths and optional visibility", () => {
    const variant = {
      ...VALID_MANIFEST,
      repos: [
        { path: ".", visibility: "private" },
        { path: "../takuhon", visibility: "public" },
        { path: "../takuhon-site" }, // visibility optional
      ],
    };
    expect(ManifestSchema.safeParse(variant).success).toBe(true);
  });

  it("accepts a manifest with no repos block (backward compatible)", () => {
    expect("repos" in VALID_MANIFEST).toBe(false);
    expect(ManifestSchema.safeParse(VALID_MANIFEST).success).toBe(true);
  });

  it("rejects an unknown repo visibility", () => {
    const variant = { ...VALID_MANIFEST, repos: [{ path: "../x", visibility: "secret" }] };
    expect(ManifestSchema.safeParse(variant).success).toBe(false);
  });

  it("accepts an explicit instructions: hub | self on a repo entry", () => {
    for (const instructions of ["hub", "self"]) {
      const variant = { ...VALID_MANIFEST, repos: [{ path: "../blog", instructions }] };
      expect(ManifestSchema.safeParse(variant).success, instructions).toBe(true);
    }
  });

  it("accepts a repo entry with instructions absent (defaults to hub elsewhere)", () => {
    const variant = { ...VALID_MANIFEST, repos: [{ path: "../blog" }] };
    expect(ManifestSchema.safeParse(variant).success).toBe(true);
  });

  it("rejects an unknown instructions mode", () => {
    const variant = { ...VALID_MANIFEST, repos: [{ path: "../x", instructions: "managed" }] };
    expect(ManifestSchema.safeParse(variant).success).toBe(false);
  });

  it("rejects an absolute or '~' path in a repos entry", () => {
    for (const bad of ["/abs/x", "~/x"]) {
      const variant = { ...VALID_MANIFEST, repos: [{ path: bad }] };
      expect(ManifestSchema.safeParse(variant).success).toBe(false);
    }
  });

  it("rejects an empty repos array", () => {
    const variant = { ...VALID_MANIFEST, repos: [] };
    expect(ManifestSchema.safeParse(variant).success).toBe(false);
  });

  it("accepts a repos roster with language and publishes", () => {
    const variant = {
      ...VALID_MANIFEST,
      repos: [
        {
          path: "../takuhon-site",
          visibility: "private",
          language: "en",
          publishes: [{ kind: "web", visibility: "public", language: "en+ja" }],
        },
        { path: "../takuhon", visibility: "public", language: "en" }, // publishes optional
        { path: "../takuhon-planning", visibility: "private", language: "ja" }, // no publishes
      ],
    };
    expect(ManifestSchema.safeParse(variant).success).toBe(true);
  });

  it("accepts a publish target with only kind (visibility/language optional)", () => {
    const variant = {
      ...VALID_MANIFEST,
      repos: [{ path: "../x", visibility: "private", publishes: [{ kind: "npm" }] }],
    };
    expect(ManifestSchema.safeParse(variant).success).toBe(true);
  });

  it("rejects an unknown repo language", () => {
    const variant = { ...VALID_MANIFEST, repos: [{ path: "../x", language: "fr" }] };
    expect(ManifestSchema.safeParse(variant).success).toBe(false);
  });

  it("rejects an unknown publish kind", () => {
    const variant = {
      ...VALID_MANIFEST,
      repos: [{ path: "../x", publishes: [{ kind: "mobile" }] }],
    };
    expect(ManifestSchema.safeParse(variant).success).toBe(false);
  });

  it("rejects a publish target missing kind", () => {
    const variant = {
      ...VALID_MANIFEST,
      repos: [{ path: "../x", publishes: [{ visibility: "public" }] }],
    };
    expect(ManifestSchema.safeParse(variant).success).toBe(false);
  });

  it("accepts a relative workspace.view path", () => {
    const variant = {
      ...VALID_MANIFEST,
      workspace: { ...VALID_MANIFEST.workspace, view: "../basou-workspace" },
    };
    expect(ManifestSchema.safeParse(variant).success).toBe(true);
  });

  it("rejects an absolute or '~' workspace.view path", () => {
    for (const bad of ["/abs/view", "~/view"]) {
      const variant = {
        ...VALID_MANIFEST,
        workspace: { ...VALID_MANIFEST.workspace, view: bad },
      };
      expect(ManifestSchema.safeParse(variant).success).toBe(false);
    }
  });

  it("preserves unknown fields at every level (loose, not strip) so they are not silently dropped", () => {
    const withUnknown = {
      ...VALID_MANIFEST,
      signing: { key_id: "abc" }, // unknown top-level section (e.g. a newer version's)
      workspace: { ...VALID_MANIFEST.workspace, future_meta: "keep-me" }, // unknown nested
      adapters: { ...VALID_MANIFEST.adapters, codex: { enabled: false } }, // a future adapter
    };
    const parsed = ManifestSchema.parse(withUnknown);
    expect((parsed as Record<string, unknown>).signing).toEqual({ key_id: "abc" });
    expect((parsed.workspace as Record<string, unknown>).future_meta).toBe("keep-me");
    expect((parsed.adapters as Record<string, unknown>).codex).toEqual({ enabled: false });
    expect(parsed.workspace.name).toBe(VALID_MANIFEST.workspace.name); // known fields still typed/validated
  });

  it("still rejects known fields that violate their schema (loose does not weaken known-field validation)", () => {
    // wrong literal value for a pinned field
    expect(ManifestSchema.safeParse({ ...VALID_MANIFEST, basou_version: "9.9.9" }).success).toBe(
      false,
    );
    // structurally wrong type: capabilities.enabled must be an array of strings, not a string
    expect(
      ManifestSchema.safeParse({ ...VALID_MANIFEST, capabilities: { enabled: "not-an-array" } })
        .success,
    ).toBe(false);
  });
});

describe("unknownManifestKeys", () => {
  it("lists the unrecognized top-level keys, sorted; empty when all are known", () => {
    expect(unknownManifestKeys(ManifestSchema.parse(VALID_MANIFEST))).toEqual([]);
    const withUnknown = ManifestSchema.parse({
      ...VALID_MANIFEST,
      zeta: 1,
      signing: { key_id: "abc" },
    });
    expect(unknownManifestKeys(withUnknown)).toEqual(["signing", "zeta"]);
  });

  it("does not report a preserved nested unknown as a top-level key", () => {
    const withNested = ManifestSchema.parse({
      ...VALID_MANIFEST,
      workspace: { ...VALID_MANIFEST.workspace, future_meta: "x" },
    });
    expect(unknownManifestKeys(withNested)).toEqual([]); // nested unknowns are preserved but not top-level
  });
});
