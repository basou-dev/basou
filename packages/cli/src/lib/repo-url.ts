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
 *   - http(s)://:    `https://host:8443/org/repo`    -> `https://host:8443/org/repo`
 *
 * Only those four transports are recognized: the web port is preserved for
 * `http(s)` (a self-hosted forge may run on a non-default port) but dropped for
 * `ssh`/`git` (that is the transport port, not the web port). Anything else — a
 * bare local path, a non-git scheme (`file:`, `javascript:`, ...), a URL with no
 * host or path, a userinfo-confused host (`a@b@c`), or a path with `..`/`.`
 * segments — returns `null` so the caller renders plain text, never an unsafe or
 * misdirecting href. The output is ALWAYS an `https://` URL, so a hostile remote
 * can never smuggle a `javascript:` href into the DOM. Pure and synchronous; no
 * I/O.
 */
export function toBrowserUrl(remote: string): string | null {
  const raw = remote.trim();
  if (raw.length === 0) return null;

  let host: string;
  let path: string;

  if (raw.includes("://")) {
    // Scheme-qualified. URL parses userinfo, host, port, and path for us.
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    // Only recognized git transports become a browsable link; file:, ftp:,
    // javascript:, and other schemes are not repos we can open, so `null`.
    const scheme = parsed.protocol;
    if (scheme !== "ssh:" && scheme !== "git:" && scheme !== "http:" && scheme !== "https:") {
      return null;
    }
    // Keep the port for web transports — a self-hosted forge may run on :8443,
    // so dropping it would point at the wrong origin — but drop it for ssh/git,
    // whose port is the transport port, not the web port. `URL.host` carries the
    // port, `URL.hostname` does not; either way the userinfo is already stripped
    // (so `git@github.com@evil.example/x` resolves to host `evil.example`).
    host = scheme === "http:" || scheme === "https:" ? parsed.host : parsed.hostname;
    path = parsed.pathname;
  } else {
    // scp-like `user@host:org/repo` — no scheme, a single `:` separating host
    // from path. The host run excludes `@` so a second `@` cannot fold a real
    // host into userinfo (`git@github.com@evil.example:org/repo` must NOT read
    // as host `github.com@evil.example`; it fails the shape and returns null).
    // Reject anything without an `@host:` shape (e.g. a bare local path).
    const match = /^[^@/\s]+@([^:/\s@]+):(.+)$/.exec(raw);
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
  if (/\s/.test(host) || /\s/.test(cleanPath)) return null;
  // Reject dot-segments so the rendered link cannot resolve somewhere other than
  // the path shown (`org/repo/../../evil` would resolve to `host/evil`).
  if (cleanPath.split("/").some((seg) => seg === "." || seg === "..")) return null;

  return `https://${host}/${cleanPath}`;
}
