import { fromBytes } from "./glob.js";
import type { RepoScopeResult } from "./scope.js";

/**
 * The version of how the `components` section measures. Raised whenever a
 * value of the section would change for the same repositories and
 * declaration, as when a rule for a marker changes.
 */
export const BOARD_COMPONENTS_METHOD = 1;

// A file under one of these directories is not a marker.
const SKIP = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".svelte-kit",
  "target",
  "__pycache__",
  ".git",
]);
const MANIFEST = new Set([
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pnpm-workspace.yaml",
  "Gemfile",
  "composer.json",
  "deno.json",
]);
const BUILD = new Set(["Makefile", "justfile", "Taskfile.yml"]);
const EDGE = new Set([
  "wrangler.toml",
  "wrangler.json",
  "wrangler.jsonc",
  "fly.toml",
  "vercel.json",
  "netlify.toml",
  "render.yaml",
  "Procfile",
]);
const ENV = new Set([".env.example", ".env.sample", ".env.template"]);
const COMPOSE = /^(docker-)?compose[^/]*\.ya?ml$/;
const MIGRATIONS = new Set(["migrations", "migration"]);
const INFRASTRUCTURE = new Set(["terraform", "cloudflared"]);

/** A component the markers found, and whether the declaration registers it. */
export type BoardComponent = {
  /** The kinds of marker found for it, sorted. */
  kinds: string[];
  status: "known" | "unacknowledged";
};

/** A component whose kinds of marker changed since the previous record. */
export type BoardComponentChange = { key: string; before: string[]; after: string[] };

/**
 * The components the built-in markers find in the working tree of each
 * repository the manifest declares, held against the declaration's
 * `components`. A key is the name of the directory the repository is in,
 * then the directory of the component inside it.
 *
 * Every value is null, with one entry at `components`, when a repository
 * cannot be opened, git could not list all of its working tree, two
 * repositories are in directories of the same name, or a component's
 * directory is not a valid UTF-8 name (in either case keys could not be told
 * apart). `kind_changed` is also null, with no entry, when there is no
 * previous record to hold the kinds against: a null that means so.
 */
export type BoardComponents = {
  /**
   * By key. The order of the keys is not part of it: an object puts keys
   * that read as array indexes first, whatever order they were added in.
   */
  found: Record<string, BoardComponent> | null;
  /** The keys found that the declaration does not register, by code point. */
  unacknowledged: string[] | null;
  /** The keys the declaration registers that were not found, by code point. */
  gone: string[] | null;
  kind_changed: BoardComponentChange[] | null;
};

export type ComponentsInput = {
  /** The manifest's paths, in its order. */
  repos: readonly string[];
  /** The name of the directory each repository is in, by its path. */
  names: ReadonlyMap<string, string | null>;
  /** The working tree of a repository, by its path. */
  worktreeOf: (repo: string) => Promise<RepoScopeResult>;
  /** The declaration's components, by key. */
  registered: Readonly<Record<string, unknown>>;
};

/** The `components` section of a measurement, and why it is missing when it is. */
export async function measureComponents(input: ComponentsInput): Promise<{
  components: BoardComponents;
  notFound: { at: string; reason: string }[];
}> {
  const unmeasured = (reason: string) => ({
    components: { found: null, unacknowledged: null, gone: null, kind_changed: null },
    notFound: [{ at: "components", reason }],
  });
  const byName = new Map<string, string>();
  for (const path of input.repos) {
    const name = input.names.get(path) ?? null;
    if (name === null) {
      const opened = await input.worktreeOf(path);
      return unmeasured(`the repo '${path}' ${opened.ok ? "could not be named" : opened.reason}`);
    }
    const other = byName.get(name);
    if (other !== undefined) {
      return unmeasured(
        `the repos '${other}' and '${path}' are both in a directory named '${name}', so their components cannot be told apart`,
      );
    }
    byName.set(name, path);
  }

  const kinds = new Map<string, Set<string>>();
  let undecodable: string | undefined;
  for (const [name, path] of byName) {
    const opened = await input.worktreeOf(path);
    if (!opened.ok) return unmeasured(`the repo '${path}' ${opened.reason}`);
    const [unread] = opened.scope.unread.values();
    if (unread !== undefined) return unmeasured(`in the repo '${path}', ${unread}`);
    const add = (dir: string, kind: string) => {
      const text = utf8(dir);
      if (text === undefined) {
        undecodable ??= `in the repo '${path}', the directory '${fromBytes(dir)}' is not a valid UTF-8 name, so its component cannot be told apart from others`;
        return;
      }
      const key = text === "" ? name : `${name}/${text}`;
      const found = kinds.get(key) ?? new Set<string>();
      found.add(kind);
      kinds.set(key, found);
    };
    for (const file of opened.scope.entries.keys()) classify(file, add);
  }
  if (undecodable !== undefined) return unmeasured(undecodable);

  const registered = new Set(Object.keys(input.registered));
  const keys = [...kinds.keys()].sort(byCodePoint);
  // From entries, so that a key such as __proto__ is a key of its own.
  const found: Record<string, BoardComponent> = Object.fromEntries(
    keys.map((key) => [
      key,
      {
        kinds: [...(kinds.get(key) ?? [])].sort(byCodePoint),
        status: registered.has(key) ? "known" : "unacknowledged",
      },
    ]),
  );
  return {
    components: {
      found,
      unacknowledged: keys.filter((key) => !registered.has(key)),
      gone: [...registered].filter((key) => !kinds.has(key)).sort(byCodePoint),
      kind_changed: null,
    },
    notFound: [],
  };
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

// The text of a byte string, or undefined when it is not valid UTF-8 (a name
// that would otherwise read the same as another one).
function utf8(bytes: string): string | undefined {
  try {
    return UTF8.decode(Buffer.from(bytes, "latin1"));
  } catch {
    return undefined;
  }
}

/** Orders strings by code point, as components.sh sorts them (not by UTF-16 unit). */
export function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = (x[i] as string).codePointAt(0) ?? 0;
    const q = (y[i] as string).codePointAt(0) ?? 0;
    if (p !== q) return p - q;
  }
  return x.length - y.length;
}

// The markers a file of the working tree is, each added to the component in
// its directory. `path` is a byte string; the names it is held against are
// ASCII.
function classify(path: string, add: (dir: string, kind: string) => void): void {
  const parts = path.split("/");
  const dirs = parts.slice(0, -1);
  if (dirs.some((part) => SKIP.has(part))) return;
  const name = parts[parts.length - 1] ?? "";
  const dir = dirs.join("/");
  if (MANIFEST.has(name)) add(dir, "manifest");
  if (BUILD.has(name)) add(dir, "build");
  if (name.startsWith("Dockerfile") || COMPOSE.test(name)) add(dir, "container");
  if (EDGE.has(name)) add(dir, "edge");
  if (ENV.has(name)) add(dir, "env");
  if (name.endsWith(".tf")) add(dir, "iac");
  if (parts.length >= 3 && parts[0] === ".github" && parts[1] === "workflows") {
    if (/\.ya?ml$/.test(name)) add(".github/workflows", "ci");
  }
  if (name === "config.toml" && dirs[dirs.length - 1] === "supabase") add(dir, "db");
  if (name === "schema.prisma") add(dir, "db");
  if (name.startsWith("drizzle.config.")) add(dir, "db");
  // The first directory of either sort on the way down is the component.
  for (let i = 0; i < dirs.length; i++) {
    const part = dirs[i] as string;
    if (MIGRATIONS.has(part)) {
      add(dirs.slice(0, i + 1).join("/"), "db");
      break;
    }
    if (INFRASTRUCTURE.has(part)) {
      add(dirs.slice(0, i + 1).join("/"), "iac");
      break;
    }
  }
  if (name.endsWith(".sql") && !dirs.some((part) => MIGRATIONS.has(part))) {
    add(dir, "sql");
  }
}
