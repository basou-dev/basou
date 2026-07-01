/**
 * Turn a git remote URL into a browsable `https://` URL, or `null` when it
 * cannot be safely normalized. Host-agnostic (GitHub / GitLab / Bitbucket /
 * self-hosted), so the portfolio view can render a clickable link for whatever
 * forge a repo lives on.
 *
 * Recognized inputs (with or without a trailing `.git` / slash):
 *   - scp-like SSH:  `git@host:org/repo`            -> `https://host/org/repo`
 *   - ssh://:        `ssh://git@host:22/org/repo`    -> `https://host/org/repo`
 *   - git://:        `git://host/org/repo`           -> `https://host/org/repo`
 *   - http(s)://:    `https://host/org/repo`         -> `https://host/org/repo`
 *
 * Anything else (a bare local path, an unparseable string, a URL missing a host
 * or path) returns `null` so the caller renders plain text — never an unsafe
 * href. The output is ALWAYS an `https://` URL (userinfo and any port are
 * dropped), so a hostile remote can never smuggle a `javascript:` href into the
 * DOM. Pure and synchronous; no I/O.
 */
export function toBrowserUrl(remote: string): string | null {
  const raw = remote.trim();
  if (raw.length === 0) return null;

  let host: string;
  let path: string;

  if (raw.includes("://")) {
    // Scheme-qualified (ssh/git/http/https). URL parses userinfo, host, port,
    // and path for us; we keep only host + path and force the https scheme.
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  } else {
    // scp-like `user@host:org/repo` — no scheme, a single `:` separating host
    // from path. Reject if there is no `@host:` shape (e.g. a bare local path).
    const match = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(raw);
    if (match === null || match[1] === undefined || match[2] === undefined) return null;
    host = match[1];
    path = match[2];
  }

  const cleanPath = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");

  if (host.length === 0 || cleanPath.length === 0) return null;
  // Defensive: whitespace/control chars have no place in a host or path segment.
  if (/[\s]/.test(host) || /[\s]/.test(cleanPath)) return null;

  return `https://${host}/${cleanPath}`;
}
