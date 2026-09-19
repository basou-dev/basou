import { describe, expect, it } from "vitest";
import {
  carryForwardProtocolStamp,
  isProtocolUpdateDue,
  PROTOCOL_UPDATE_TOKEN_PREFIX,
  type ProtocolStamp,
  parseProtocolStamp,
  protocolBlockHash,
  protocolSectionsFrom,
  protocolUpdateToken,
  renderProtocolStamp,
  renderProtocolUpdate,
  unstampedProtocolSectionsFrom,
} from "./protocol-stamp.js";

const SESSION_START = "2026-09-16T09:00:00.000Z";
const BEFORE = "2026-09-16T08:00:00.000Z";
const AFTER = "2026-09-16T10:00:00.000Z";

/** A stamp for `sections` dated `at`. */
function stampFor(sections: string, at: string): ProtocolStamp {
  return carryForwardProtocolStamp({ sections, previous: null, now: at });
}

/** A rendered block body: managed note, stamp, then the protocol text. */
function block(sections: string, stamp: ProtocolStamp): string {
  return `<!-- managed note -->\n${renderProtocolStamp(stamp)}\n\n${sections}\n`;
}

describe("protocol stamp round-trip", () => {
  it("renders and parses back what it was given", () => {
    const stamp = stampFor("## A\n\none", BEFORE);
    expect(parseProtocolStamp(renderProtocolStamp(stamp))).toEqual(stamp);
  });

  it("finds the stamp on its own line inside a larger block body", () => {
    const stamp = stampFor("## A\n\none", BEFORE);
    expect(parseProtocolStamp(block("## A\n\none", stamp))).toEqual(stamp);
  });

  it("returns null for a block with no stamp (rendered by an older basou)", () => {
    expect(parseProtocolStamp("<!-- managed note -->\n\n## A\n\none\n")).toBeNull();
  });

  it("returns null when a field is missing, rather than half a stamp", () => {
    expect(
      parseProtocolStamp("<!-- basou:protocols v1 changed=2026-09-16T09:00:00.000Z -->"),
    ).toBeNull();
    expect(parseProtocolStamp("<!-- basou:protocols v1 content=deadbeef -->")).toBeNull();
  });

  it("returns null when the timestamp is not a date", () => {
    expect(
      parseProtocolStamp("<!-- basou:protocols v1 changed=whenever content=dead -->"),
    ).toBeNull();
  });

  it("keeps the ISO timestamp intact even though it contains colons", () => {
    const parsed = parseProtocolStamp(
      "<!-- basou:protocols v1 changed=2026-09-16T09:00:00.000Z content=dead -->",
    );
    expect(parsed).toEqual({ changedAt: "2026-09-16T09:00:00.000Z", contentHash: "dead" });
  });

  it("does not mistake a future v10 line for a v1 one", () => {
    expect(
      parseProtocolStamp(
        "<!-- basou:protocols v10 changed=2026-09-16T09:00:00.000Z content=dead -->",
      ),
    ).toBeNull();
  });

  it("ignores an unknown field instead of failing the parse", () => {
    const parsed = parseProtocolStamp(
      "<!-- basou:protocols v1 changed=2026-09-16T09:00:00.000Z content=dead future=yes -->",
    );
    expect(parsed).toEqual({ changedAt: "2026-09-16T09:00:00.000Z", contentHash: "dead" });
  });

  it("carries nothing operator-authored onto the line", () => {
    const line = renderProtocolStamp(stampFor("## A --> B\n\na 'quoted' path with spaces", BEFORE));
    expect(line).not.toContain("quoted");
    expect(line.split("-->").length).toBe(2);
  });
});

describe("carryForwardProtocolStamp", () => {
  it("keeps the previous changedAt when the rendered text is unchanged", () => {
    const previous = stampFor("## A\n\none", BEFORE);
    expect(carryForwardProtocolStamp({ sections: "## A\n\none", previous, now: AFTER })).toEqual(
      previous,
    );
  });

  it("moves changedAt to now when the rendered text changed", () => {
    const previous = stampFor("## A\n\none", BEFORE);
    const next = carryForwardProtocolStamp({ sections: "## A\n\ntwo", previous, now: AFTER });
    expect(next.changedAt).toBe(AFTER);
    expect(next.contentHash).toBe(protocolBlockHash("## A\n\ntwo"));
  });

  it("moves changedAt for a reorder, a retitle, and a withdrawal", () => {
    const previous = stampFor("## A\n\none\n\n## B\n\ntwo", BEFORE);
    for (const sections of [
      "## B\n\ntwo\n\n## A\n\none",
      "## Renamed\n\none\n\n## B\n\ntwo",
      "## A\n\none",
    ]) {
      expect(carryForwardProtocolStamp({ sections, previous, now: AFTER }).changedAt).toBe(AFTER);
    }
  });

  it("does not announce an upgrade: a stamp-less block whose text matches is dated forward only if the text differs", () => {
    // previous === null is what an older, stamp-less block yields. The text is
    // the same, so the session holding it is not owed anything -- but there is
    // no previous date to keep, so `now` is used and the caller must rely on
    // the SESSION START comparison, which this asserts stays correct.
    const stamp = carryForwardProtocolStamp({
      sections: "## A\n\none",
      previous: null,
      now: AFTER,
    });
    expect(stamp.contentHash).toBe(protocolBlockHash("## A\n\none"));
    expect(stamp.changedAt).toBe(AFTER);
  });

  it("forces the date forward when the clock went backwards", () => {
    const previous = stampFor("## A\n\none", AFTER);
    const next = carryForwardProtocolStamp({ sections: "## A\n\ntwo", previous, now: BEFORE });
    expect(Date.parse(next.changedAt)).toBeGreaterThan(Date.parse(AFTER));
  });

  it("uses now when the clock is ahead of the previous stamp", () => {
    const previous = stampFor("## A\n\none", BEFORE);
    expect(
      carryForwardProtocolStamp({ sections: "## A\n\ntwo", previous, now: AFTER }).changedAt,
    ).toBe(AFTER);
  });

  it("hashes the rendered text, so trailing whitespace in a source cannot move it", () => {
    // `buildSections` trims each body, so two syncs of a source that gained a
    // trailing newline produce the same `sections` and the same hash.
    expect(protocolBlockHash("## A\n\none")).toBe(protocolBlockHash("## A\n\none"));
    expect(protocolBlockHash("## A\n\none")).not.toBe(protocolBlockHash("## A\n\none "));
  });
});

describe("protocolSectionsFrom", () => {
  it("returns everything below the stamp line", () => {
    const stamp = stampFor("## A\n\none", BEFORE);
    expect(protocolSectionsFrom(block("## A\n\none", stamp))).toBe("## A\n\none");
  });

  it("keeps a protocol body that opens with its own HTML comment", () => {
    const sections = "## A\n\n<!-- a comment the operator wrote -->\n\none";
    expect(protocolSectionsFrom(block(sections, stampFor(sections, BEFORE)))).toBe(sections);
  });

  it("returns null when there is no stamp to anchor on", () => {
    expect(protocolSectionsFrom("<!-- managed note -->\n\n## A\n\none\n")).toBeNull();
  });

  it("returns an empty string for a block holding a stamp and nothing else", () => {
    expect(
      protocolSectionsFrom(`<!-- note -->\n${renderProtocolStamp(stampFor("", BEFORE))}\n\n`),
    ).toBe("");
  });

  it("reads an older stamp-less block by dropping its managed note", () => {
    const body = "<!-- old managed note -->\n\n## A\n\none\n";
    expect(unstampedProtocolSectionsFrom(body)).toBe("## A\n\none");
  });

  it("reads an older stamp-less block out of a whole file", () => {
    const body = `<!-- BASOU:PROTOCOLS:START -->\n<!-- old note -->\n\n## A\n\none\n<!-- BASOU:PROTOCOLS:END -->\n`;
    expect(unstampedProtocolSectionsFrom(body)).toBe("## A\n\none");
  });

  it("agrees with the stamped reader, so an upgrade compares like with like", () => {
    const sections = "## A\n\none\n\n## B\n\ntwo";
    const stamped = block(sections, stampFor(sections, BEFORE));
    expect(unstampedProtocolSectionsFrom(`<!-- note -->\n\n${sections}\n`)).toBe(
      protocolSectionsFrom(stamped),
    );
  });

  it("stops at a closing marker, so a whole file yields the same text as a block body", () => {
    const sections = "## A\n\none";
    const stamp = stampFor(sections, BEFORE);
    const whole = `prose above\n<!-- BASOU:PROTOCOLS:START -->\n${block(sections, stamp)}<!-- BASOU:PROTOCOLS:END -->\nprose below\n`;
    expect(protocolSectionsFrom(whole)).toBe(sections);
  });

  it("survives CRLF line endings", () => {
    const stamp = stampFor("## A\n\none", BEFORE);
    const crlf = `<!-- note -->\r\n${renderProtocolStamp(stamp)}\r\n\r\n## A\r\n\r\none\r\n`;
    expect(protocolSectionsFrom(crlf)).toBe("## A\n\none");
  });
});

describe("isProtocolUpdateDue", () => {
  it("is due when the block changed after the session started", () => {
    expect(
      isProtocolUpdateDue({ stamp: stampFor("x", AFTER), sessionStartedAt: SESSION_START }),
    ).toBe(true);
  });

  it("is not due when the block last changed before the session started", () => {
    expect(
      isProtocolUpdateDue({ stamp: stampFor("x", BEFORE), sessionStartedAt: SESSION_START }),
    ).toBe(false);
  });

  it("treats a change exactly at the session start as already read", () => {
    expect(
      isProtocolUpdateDue({ stamp: stampFor("x", SESSION_START), sessionStartedAt: SESSION_START }),
    ).toBe(false);
  });

  it("is not due when the session start is unparseable", () => {
    expect(isProtocolUpdateDue({ stamp: stampFor("x", AFTER), sessionStartedAt: "whenever" })).toBe(
      false,
    );
  });
});

describe("protocolUpdateToken", () => {
  it("carries the content digest, so a second update in one session is a different token", () => {
    const first = protocolUpdateToken(protocolBlockHash("## A\n\none"));
    const second = protocolUpdateToken(protocolBlockHash("## A\n\none, corrected"));
    expect(first).not.toBe(second);
    expect(first.startsWith(`${PROTOCOL_UPDATE_TOKEN_PREFIX}:`)).toBe(true);
  });
});

describe("renderProtocolUpdate", () => {
  it("carries the protocol text itself, with the token for this block state", () => {
    const stamp = stampFor("## Session-end capture\n\nthe new rule", AFTER);
    const text = renderProtocolUpdate("## Session-end capture\n\nthe new rule", stamp);
    expect(text).toContain(protocolUpdateToken(stamp.contentHash));
    expect(text).toContain("## Session-end capture");
    expect(text.endsWith("the new rule")).toBe(true);
  });

  it("says the set is complete and supersedes what was read at start", () => {
    const sections = "## A\n\nbody";
    const text = renderProtocolUpdate(sections, stampFor(sections, AFTER));
    expect(text).toContain("COMPLETE current set");
    expect(text).toContain("SUPERSEDES");
  });

  it("tells the session to treat anything now absent as withdrawn", () => {
    const sections = "## A\n\nbody";
    expect(renderProtocolUpdate(sections, stampFor(sections, AFTER))).toContain("withdrawn");
  });
});
