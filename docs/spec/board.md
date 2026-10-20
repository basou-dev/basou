# Progress board: `board.yaml`, the record's input, and records

> **Experimental.** `basou board` is an [experimental
> command](compatibility.md#what-is-not-guaranteed). Every shape on this page
> (the declaration `board.yaml`, the input `basou board record` reads, the
> records it writes, and the measurement `basou board measure --json` prints)
> is outside every guarantee, and may change at any release. If the command
> is promoted, the release that promotes it names the shapes it guarantees
> from then on; until then, and for any shape it does not name, none is
> guaranteed.
>
> This page describes the shapes of basou 0.71.0: `board_version` 3 and
> `record_version` 3, with what `basou board record` refuses of an
> observation's value as of basou 0.73.0. When a later release changes a
> shape, it raises the version and this page with it.

This page says what each key of these shapes holds, which keys are required,
what a `null` means, and what the digest of a measurement covers. It does not
say how to judge a board: `basou board guide` prints those steps, filled in
with the workspace's own board, and `basou board init` prints a `board.yaml`
to start from.

Conventions on this page:

- **A non-empty string** has at least one character that is not whitespace.
- **An id** starts with a lowercase letter and uses only `a-z`, `0-9`, `_`
  and `-` (`core`, `site-docs`, `v2_api`).
- **A dotted id** (from `board_version` 3) is one or more ids joined by `.`
  (`site.pages`). A measure's id and an observation's key may be dotted ids;
  a lane id and a ratio id may not. `:` and `/` are refused, because the
  guide names working files by an observation's key.
- **A date** is a day of the calendar written `YYYY-MM-DD`.
- **Since** names the first `board_version` that reads a key, a kind or a
  value. Using one in a board of an earlier version is refused (see
  [How it is read](#21-how-it-is-read)).

## 1. Files and versions

| File | Where | Written by |
|---|---|---|
| `board.yaml` | `board/board.yaml` in the workspace's own repo, or any path given as `--board <path>` | you (or an agent); `basou board init` prints one to start from |
| `records/<ULID>.json` | in a `records/` directory beside `board.yaml` | `basou board record`, one file a record |

- Without `--board`, the commands read `board/board.yaml` only when the
  manifest declares the workspace's own repo (`path: .`) with `visibility:
  private`: a record holds what the trail holds (open tracks, time worked,
  model names).
- Only a file named `board.yaml` has records, so that one `records/`
  directory holds one board's records. `basou board record` refuses to write
  under a `.basou/` directory, and, unless `--not-private` is given, refuses
  a `records/` unless the innermost of the manifest's repos that holds it is
  declared private: a repo nested in a private one decides by its own
  visibility.
- A record's file name is a ULID whose time is the record's `recorded_at`,
  with `.json`. Any other file in `records/` is passed over. The previous
  record is the last by name. A record written before basou 0.70.1 has a
  name of another time, a second or so apart; the board page's list of
  records and `basou board guide` give each record's own `recorded_at`.

Both shapes carry a version, and every version ever written is read:

| | Read | Written |
|---|---|---|
| `board_version` | 1, 2, 3 | `basou board init` prints 3; you write the one your board uses |
| `record_version` | 1, 2, 3 | always 3, whatever the version of the board |

- `board_version` 2 added `observe` and a stage's `look` and `notes`.
- `board_version` 3 added the observations `http` and `github_check`, an
  observation's `notes`, the measures `file_name`, `file_paths` and `total`,
  a measure's `lane` as a list, dotted ids for measures and observations,
  and a component's `marker`.
- `record_version` 2 holds the observations and the stages' `look` and
  `notes` of a board of version 2.
- `record_version` 3 may hold a declaration of `board_version` 3 and its
  values (a list of paths for a `file_paths` measure, the kind `marker` for
  a component), holds a measure's `lane` as a list, and holds a repo's
  `base`, `behind`, `ahead` and `fetched_at` (see [Records of version 1 and
  2](#6-records-of-version-1-and-2)).

A board of an unknown version is refused, naming it (`board_version: this
basou reads board_version 1, 2 or 3, not 4`). A record of an unknown version
cannot be read, and then what it alone would tell (the previous record, the
last axis review) is not known; it is never taken as no record.

## 2. `board.yaml`

### 2.1 How it is read

- **YAML 1.2 only.** A `%YAML` directive for another version is refused, and
  so is a duplicate key.
- **Every key is a string.** A key YAML reads as something else is refused
  (`the key 01 at line 4, column 3 is not a string; write it in quotes`), so
  the stage ids are written in quotes: `"01"`.
- **An unknown key is refused at every level**, so a typo is reported, not
  ignored. One in a measure or an observation itself (not in its
  `section`) that no version of its kind takes is refused with the keys the
  kind takes in the version the file is read by
  (`observe[0]: unknown keys 'count', 'capture' (kind 'http' takes: key, kind, url, words, count_pattern, capture_pattern, notes)`);
  one a later version takes is told which version reads it.
- **A problem in the YAML itself stops the reading**, and so does an unknown
  `board_version` (see [Files and versions](#1-files-and-versions)): a syntax
  error, a duplicate key, a `%YAML` directive or a key that is not a string
  is reported on its own, starting with `not valid YAML:`.
- **Once the file reads, every problem is reported at once.** Each starts
  with where it is:
  `measures[2].include[0]`, or `components["app/content"].marker` for a key
  with a character other than a letter, a digit, `_` and `-`. What one key says about another (a duplicate id, a lane
  or measure that does not exist, a repo the manifest does not declare) is
  reported beside the problems of shape.
- **A board of version 1 or 2 is told what a later version reads**, on a line
  of its own, for a key, a kind or a value:
  `observe[0].kind: 'http' is read from board_version 3 on; this file is
  board_version 2`.
- A board with no `board_version`, or one that is not a number, is held to
  the newest shape, and refused for that.
- Defaults are filled in as it is read. A record keeps the declaration as
  read, defaults and all (see [`declaration`](#42-declaration)); the comments
  and the layout of the file are not part of it.

A board of version 3 that declares one of each part:

```yaml
board_version: 3
title: "Example product: progress"

stages:
  "01": { meaning: "Designed: the shape of the feature is decided" }
  "02": { meaning: "Built: it works in a working tree" }
  "03": { meaning: "Tested: its tests pass" }
  "04": { meaning: "Merged: it is on main", look: ["the merged pull request"] }
  "05": { meaning: "Released: users can install it" }
  "06": { meaning: "Used: someone other than its author uses it" }

lanes:
  - id: cli
    name: "Command line"
    about: "What a user runs"
    notes: ["A release is 05 only once the package is published"]

measures:
  - { id: commands, kind: file_count, repo: ., include: ["src/commands/*.ts"], exclude: ["src/commands/*.test.ts"], unit: files, lane: cli }
  - { id: command_tests, kind: file_count, repo: ., include: ["src/commands/*.test.ts"], unit: files }
  - { id: latest_migration, kind: file_name, repo: ., include: ["db/migrations/*.sql"], pick: last, pattern: "^(\\d{8})_", unit: date }

ratios:
  - { id: tested, label: "Test files per command", numerator: command_tests, denominator: commands }

observe:
  - { key: npm, kind: npm_version, package: example-cli }
  - key: site.home
    kind: http
    url: "https://example.com/"
    words: ["Install"]
    notes: ["A 503 during a deploy is expected"]

components:
  "example/db": { lane: [cli], note: "The schema the commands read" }

axis:
  version: 1
  review_due_days: 60

effort:
  start: "2026-10-01"
  time_zone: "UTC"
  milestones: []
```

### 2.2 Top-level keys

| Key | Required | Default | Since | Holds |
|---|---|---|---|---|
| `board_version` | yes | | 1 | `1`, `2` or `3` |
| `title` | yes | | 1 | a non-empty string |
| `stages` | yes | | 1 | the six stages ([2.3](#23-stages)) |
| `lanes` | yes | | 1 | at least one lane ([2.4](#24-lanes)) |
| `measures` | no | `[]` | 1 | what basou measures ([2.5](#25-measures)) |
| `ratios` | no | `[]` | 1 | one measure over another ([2.6](#26-ratios)) |
| `components` | no | `{}` | 1 | the registry of components ([2.8](#28-components)) |
| `axis` | yes | | 1 | the axis and when to review it ([2.9](#29-axis)) |
| `effort` | yes | | 1 | the period the effort is counted over ([2.10](#210-effort)) |
| `observe` | no | `[]` | 2 | what the judge observes outside basou ([2.7](#27-observe)) |

### 2.3 `stages`

A mapping with exactly the keys `"01"` to `"06"`. Their order is fixed; a
board sets what each means.

| Key | Required | Since | Holds |
|---|---|---|---|
| `meaning` | yes | 1 | a non-empty string: what reaching the stage means on this board |
| `look` | no | 2 | a list of non-empty strings: what to look at when judging it |
| `notes` | no | 2 | a list of non-empty strings: what to mind when judging it |

### 2.4 `lanes`

A list of at least one lane, each id once. A lane is judged at every stage.

| Key | Required | Holds |
|---|---|---|
| `id` | yes | an id |
| `name` | yes | a non-empty string |
| `about` | no | a non-empty string |
| `notes` | no | a list of non-empty strings: what to mind when judging the lane |

### 2.5 `measures`

A list of measures, each id once. basou measures each of them every time the
board is measured, and never writes anything to do so.

Every measure has:

| Key | Required | Holds |
|---|---|---|
| `id` | yes | an id, or from version 3 a dotted id |
| `kind` | yes | one of the kinds below |
| `unit` | yes | a non-empty string, shown with a value that is a number, and with the count of a `file_paths`; a string (`file_name`, `regex_capture`) is shown without it |
| `lane` | no | the lanes whose section of the board page draws the measure: one lane id, or from version 3 a non-empty list of them, each a lane of the board and none twice |

A `lane` is read as a list whatever the version, so a record holds a list
(`lane: cli` is `["cli"]`). A measure with no lane is drawn in no lane's
section. Every measure, with a lane or without, is drawn in the board page's
table of measures (from basou 0.72.0), kept in the records, compared with the
previous record and usable by a ratio or a total.

| Kind | Since | Reads | Value |
|---|---|---|---|
| `file_count` | 1 | a repo | a number: the files matched |
| `dir_count` | 1 | a repo | a number: the directories that hold a file matched |
| `line_count` | 1 | a repo | a number: the lines of the files matched |
| `match_count` | 1 | a repo | a number: the lines of the files matched that a pattern matches |
| `regex_capture` | 1 | a repo | a string: a group of the first line of one file that a pattern matches |
| `json_length` | 1 | a repo | a number: the entries of an array or an object in one JSON file |
| `trail_count` | 1 | the workspace's trail | a number: decisions, open tracks or tasks |
| `file_name` | 3 | a repo | a string: the name of the first or last file matched, or a group of it |
| `file_paths` | 3 | a repo | a list of strings: the paths of the files matched |
| `total` | 3 | other measures | a number: integers and measures added up, some taken away |

#### What a measure of a repo reads

| Key | Required | Default | Holds |
|---|---|---|---|
| `repo` | yes | | a path exactly as the manifest's `repos:` writes it (`.`, `../app`) |
| `at` | no | `worktree` | `worktree`, or a git revision (a branch, a tag, a commit) with no leading `-`, no whitespace and no `:` |

- **At `worktree`**, the files are those git lists as tracked, and as
  untracked but not ignored (`git ls-files --cached --others
  --exclude-standard`), that are on disk: an untracked file is counted unless
  it is ignored. **At a revision**, they are the files of that commit's
  tree.
- A symlink is followed when it ends at a file inside the repository. One
  that ends nowhere or at a directory is not a file and is left out, as a
  submodule is; one that leaves the repository makes any measure that matches
  it not measured (a repo's built-in `files` leaves it out instead, see
  [`repos`](#52-repos)).
- basou measures with git and reads files, with no shell. It does not fetch,
  write a lock or start a file system monitor.

#### Paths and globs

`include`, `exclude`, `file`, `path` and a component's `marker` are relative
to the repository's root (a `marker`, to the component's directory). Each is
refused when it is empty, holds a control character, is absolute (starts
with `/` or `\`, or with a drive such as `c:`), has a `..` segment, or starts
with `:` (which git would read as pathspec magic).

`include` and `exclude` are each a list of at least one glob. A file is
matched when an `include` matches it and no `exclude` does. A glob means what
it means to git as a `:(glob)` pathspec:

- `.` segments and repeated slashes are dropped.
- A glob first matches literally, as a path or as a directory a path is
  under: `docs` and `docs/` match `docs/a.md`.
- Then, when it has a wildcard (`*`, `?`, `[` or `\`), the whole path must
  match it: `*` and `?` never match `/`; `**` matches across directories where
  it stands for whole segments (`src/**/*.ts`); `[...]` is a class of bytes
  (`!` or `^` negates it); `\` escapes the next character.
- Matching is by byte: paths and globs are compared as their UTF-8 bytes.

#### Regular expressions

`pattern`, and a `section`'s `start` and `end`, are ECMAScript regular
expressions with the flag `u`, matched against **each line** of a file. A file
is read as UTF-8 with a leading byte order mark dropped, split at `\n`, with a
`\r` at the end of a line dropped, and a last empty line not counted.
(A `file_name`'s `pattern` is matched against each file's name instead, see
[`file_name`](#file_name), and an `http` observation's patterns against the
whole body, see [`http`](#http).)

#### When a measure is not measured

A measure's value is `null` when it cannot be measured, and then the
measurement's `not_found` has an entry at `measures.<id>` (or
`measures["site.pages"]` for a dotted id) saying why, and `complete` is
false. **A null is never a zero.** For a measure of a repo, it is null when:

- the repo cannot be opened, or has no such revision;
- an `include` with no wildcard matches no file;
- an `include` with a wildcard has a fixed directory (the part before its
  first wildcard) that holds nothing: `docs/*.md` with no `docs/` (while
  `**/*.md` that matches nothing is 0);
- a file matched is a symlink that leaves the repository, or, for a kind
  that reads files (`line_count`, `match_count`, and the file of
  `regex_capture` or `json_length`), cannot be read;
- git could not list a directory the globs may reach;
- the kind's own rule below says so.

#### `file_count`

| Key | Required | Holds |
|---|---|---|
| `include` | yes | globs |
| `exclude` | no | globs |

The value is the number of files matched.

#### `dir_count`

| Key | Required | Holds |
|---|---|---|
| `path` | yes | a directory: a path with no `*`, `?`, `[` or `\` (`.` is the repo's root) |
| `depth` | yes | an integer of at least 1 |
| `include` | no | globs |
| `exclude` | no | globs |

The value is the number of directories `depth` levels below `path` that hold
a file matched, at any depth under them (with no `include`, any file).
A directory is known only by the files in it, so an empty one is not
counted, and a file right in `path` counts no directory. With nothing under
`path`, the value is null.

#### `line_count`

| Key | Required | Holds |
|---|---|---|
| `include` | yes | globs |
| `exclude` | no | globs |

The value is the number of lines of the files matched, counted as
[above](#regular-expressions).

#### `match_count`

| Key | Required | Holds |
|---|---|---|
| `include` | yes | globs |
| `exclude` | no | globs |
| `pattern` | yes | a regular expression |
| `section` | no | `{ start, end, on_missing }` |

The value is the number of lines of the files matched that `pattern`
matches, each line counted once.

With a `section`, only the lines of a section of each file are looked at:
those after the first line `start` matches, up to the next line `end`
matches (looked for from the line after the start; to the end of the file
when there is no `end` or it matches no line). The section's own first and
last lines are not in it.

| Key of `section` | Required | Holds |
|---|---|---|
| `start` | yes | a regular expression |
| `end` | no | a regular expression |
| `on_missing` | yes | `zero`: a file where `start` matches no line counts 0; or `null`: such a file makes the measure not measured |

#### `regex_capture`

| Key | Required | Default | Holds |
|---|---|---|---|
| `file` | yes | | a path to one file |
| `pattern` | yes | | a regular expression |
| `group` | no | `1` | an integer of at least 0 (0 is the whole match), no more than the groups `pattern` has |
| `section` | no | | as `match_count`'s, with `on_missing: null` (a string has no zero) |

The value is what `group` holds in the first line `pattern` matches, as a
string. It is null when the file is not there, no line matches, the group
took no part in the match, or the section's start matches no line.

#### `json_length`

| Key | Required | Holds |
|---|---|---|
| `file` | yes | a path to one JSON file |
| `pointer` | yes | a JSON pointer (RFC 6901): `""` for the whole document, or `/`-separated tokens with `~` only as `~0` or `~1` |

The value is the number of entries of the array, or of keys of the object,
the pointer points at. It is null when the file is not there or is not JSON,
or the pointer points at nothing or at something that is not an array or an
object.

#### `trail_count`

| Key | Required | Holds |
|---|---|---|
| `of` | yes | `decisions_all`, `decisions_live`, `tracks_open` or `tasks` |
| `status` | no | with `of: tasks` only: `planned`, `in_progress`, `done` or `cancelled` |

It reads the workspace's own trail on this host, takes no `repo` or `at`,
and counts: every decision recorded (`decisions_all`, an id counted once),
those not voided (`decisions_live`), the open tracks (`tracks_open`), or the
tasks that are not archived (`tasks`, those of `status` when it is given).
It is null when the trail cannot be read whole.

#### `file_name`

Since version 3.

| Key | Required | Holds |
|---|---|---|
| `include` | yes | globs |
| `exclude` | no | globs |
| `pick` | yes | `first` or `last` |
| `pattern` | no | a regular expression, matched against each file's name (the part after the last `/`) |
| `group` | no | with a `pattern` only: as `regex_capture`'s, `1` by default |

The files matched are put in the byte order of their paths in the
repository, as git orders them. With a `pattern`, only the files whose name
it matches are kept. Then `pick` takes the first or the last. The value is
that file's name, or, with a `pattern`, what `group` holds in the match of
it. The candidates are narrowed before one is picked, so a name the pattern
does not match at the end of the order (`schema.sql` after
`20261001_init.sql`) does not hide the one before it.

It is null when no file is left to pick (a string has no zero) or the group
took no part in the match. A `group` without a `pattern` is refused. The
oldest or newest date in the names of a directory is `pick: first` or `last`
with a `pattern` that captures the date.

#### `file_paths`

Since version 3.

| Key | Required | Holds |
|---|---|---|
| `include` | yes | globs |
| `exclude` | no | globs |

The value is the list of the paths of the files matched, from the
repository's root, in byte order. A path that is not valid UTF-8 is shown
with U+FFFD, and two paths that read the same are listed once. **It holds at
most 1000 paths**: more is null, with that as the reason. The limit is part
of the shape: changing it would turn one repository's value from a list to
null, or back, unseen.

#### `total`

Since version 3.

| Key | Required | Holds |
|---|---|---|
| `plus` | yes | a list of at least one term |
| `minus` | no | a list of at least one term |

A term is an integer written in the declaration (from -9007199254740991 to
9007199254740991, the integers a number holds exactly), or the id of a
measure whose value is a number. The value is what `plus` adds up to less
what `minus` adds up to, counted exactly; it may be below 0. A total of
measures of several repos adds them up.

It is null when a measure it takes was not measured (`'hand_count' is not
measured`), or when the result is out of the range above. A total takes no
total, itself included, and no measure whose value is not a number
(`regex_capture`, `file_name`, `file_paths`), so totals are never chained.

### 2.6 `ratios`

A list, each id once.

| Key | Required | Holds |
|---|---|---|
| `id` | yes | an id |
| `label` | yes | a non-empty string |
| `numerator` | yes | the id of a measure whose value is a number (a dotted id from version 3) |
| `denominator` | yes | the same |

A ratio takes a `total`, and takes no `regex_capture`, `file_name` or
`file_paths`. Its value is the numerator divided by the denominator (a
fraction, not a percentage). It is null when either is null, and when the
denominator is 0, which has an entry at `ratios.<id>`.

### 2.7 `observe`

Since version 2. A list of what the judge observes outside basou, each key
once. **basou never makes an observation, and sends nothing.** For each one
declared, `basou board guide` prints the command that makes it (or, for
`manual`, what to ask the operator) and how to write what it finds; the judge
makes it and gives it under its key in the record's input
([3.2](#32-observed)).

From basou 0.72.0, `basou board record` holds each value that is not null
against the shape its kind gives it below, and refuses one in another shape
(before, it kept any JSON value). The value of each kind is what the guide
asks for and the board page draws, and what the previous record's value is
compared with: a number given as a string, or a version copied with its line
break, would read as a change. Keep the keys: a key joins a value to the
previous record's.

Every observation has:

| Key | Required | Since | Holds |
|---|---|---|---|
| `key` | yes | 2 | an id, or from version 3 a dotted id |
| `kind` | yes | 2 | one of the kinds below |
| `notes` | no | 3 | a list of non-empty strings: what to mind when making it; the guide prints them under its commands, and the board page under the observation |

The values of an observation are put into commands, each as one
single-quoted word, so each is held to a shape that cannot end its quotation
or start an option. A `manual` observation's `how` is words for a person,
never part of a command.

| Kind | Since | Keys | Value recorded |
|---|---|---|---|
| `npm_version` | 2 | `package` | a string: the version npm's `latest` tag names (`"1.2.3"`) |
| `github_release` | 2 | `repo` | a string: the tag of the latest release; null with an error when there is none |
| `github_open_issues` | 2 | `repo` | a number: the open issues (the guide reads up to 1000) |
| `github_open_prs` | 2 | `repo` | a number: the open pull requests (the same) |
| `github_ci` | 2 | `repo`, `workflow`, `branch` | a string: how the latest run of the workflow on the branch ended (`success`, `failure`), or its status while it runs (`in_progress`); null with an error when there is no run |
| `github_check` | 3 | `repo`, `check`, `branch` | a string: how the newest check run of that name on the head commit of the branch ended, or its status while it runs; null with an error when the head commit has none |
| `page_version` | 2 | `url` | a string: the first `v<major>.<minor>.<patch>` the page shows (`"v1.2.3"`, with what follows a `-`) that is not right after a letter, a digit, `_` or `.`, once its generator meta tags are taken out; null with an error when there is none |
| `http` | 3 | `url`, `words`, `count_pattern`, `capture_pattern` | an object ([below](#http)) |
| `manual` | 2 | `how` | what the operator answers, as any JSON value |

- **What record refuses**, from basou 0.72.0: a string of a kind above that
  is empty, has white space at either end, or holds a control character
  (U+0000 to U+001F, U+007F to U+009F) or one a terminal hides (U+061C,
  U+200B to U+200F, U+2028 to U+202E, U+2060 to U+2069, U+FEFF); a number of
  a kind above that is not
  a whole number from 0 to 9007199254740991; and an `http` value out of its
  shape ([below](#http)), which from basou 0.73.0 includes a `final_url`
  with a user, a query, a fragment or a character a terminal hides. What a
  string says is not held to a
  grammar (a version's, or the words GitHub uses), so a new word is never
  refused. A `manual` value, and a null, are not checked. Only a board that
  declares observations has them checked ([3.2](#32-observed)).

The keys:

| Key | Of | Required | Default | Holds |
|---|---|---|---|---|
| `package` | `npm_version` | yes | | an npm package name in lowercase, scoped or not (`name`, `@scope/name`), up to 214 characters |
| `repo` | the `github_*` kinds | yes | | a GitHub repository written `owner/name` |
| `workflow` | `github_ci` | yes | | the file name of a workflow (`quality.yml`), up to 255 characters |
| `check` | `github_check` | yes | | the name of a check run, as a GitHub App or a workflow's job reports it (`Workers Builds: app`), up to 255 characters, with no control character, no `'` and no leading `-` |
| `branch` | `github_ci`, `github_check` | no | `main` | a branch name (see below) |
| `url` | `page_version`, `http` | yes | | an `https://` URL (see below) |
| `how` | `manual` | yes | | a non-empty string: how the operator makes it |

- **A branch name** uses only `A-Z`, `a-z`, `0-9`, `.`, `_`, `-` and `/`, and
  does not start with `-`, `.` or `/`, hold `..` or `//`, have a part that
  starts with `.`, or end with `.` or `/`. A part that starts with `.` is
  refused from basou 0.71.0 on, in a board of any version: git takes no such
  branch, and GitHub reads `a/./b` in a request as `a/b`.
- **A URL** is printable ASCII with no spaces, quotes, backquotes,
  backslashes, `<` or `>`; starts with `https://`; names a host; and carries
  no user name or password.
- A `github_ci` looks at the latest run of a workflow on the branch, while a
  `github_check` looks at the head commit of the branch: a commit that did
  not start the check (a path filter, `[skip ci]`, the app's own rules) gives
  a null, even when what the check looks after is fine. A job a workflow
  skipped with `if:` is a check run, concluded `skipped`.

#### `http`

Since version 3. The response to an HTTP GET (there is no method to declare),
following up to 10 redirects.

| Key | Required | Holds |
|---|---|---|
| `url` | yes | an `https://` URL |
| `words` | no | a list of at least one word to look for in the body, as written, none twice |
| `count_pattern` | no | a regular expression whose matches in the body are counted |
| `capture_pattern` | no | a regular expression whose first group, in its first match in the body, is captured |

A word, and each pattern, has at least one character (whitespace counts),
with no control character, no `'` (a pattern matches one as `\x27`) and no
leading `-`. Both patterns
are ECMAScript regular expressions matched against **the whole body**, not
line by line, so `^` and `$` are the start and end of the body:
`count_pattern` with the flags `gu`, `capture_pattern` with `u`. A
`count_pattern` that matches the empty string is refused (each match is
counted), and a `capture_pattern` needs at least one capturing group.

The value recorded:

```json
{ "status": 200, "redirects": 1, "final_url": "https://example.com/", "words": [true], "count": 42, "capture": "2.3" }
```

| Key | Present | Holds |
|---|---|---|
| `status` | always | a whole number from 100 to 599: the status of the last response |
| `redirects` | always | a whole number from 0 to 10: how many redirects led to it |
| `final_url` | always | an absolute `http://` or `https://` URL with no user, query, fragment or hidden character: the URL it ended at, as its scheme, its host (with a port that is not the scheme's own) and its path, as `new URL` reads them |
| `words` | with `words` | a list of `true` or `false`, one for each word, in the order declared: whether the body holds it |
| `count` | with `count_pattern` | a whole number from 0 to 9007199254740991: how many times it matches the body (0 when it does not) |
| `capture` | with `capture_pattern` | a string: what the first group holds in the first match, as it is, spaces and all; null when nothing matches or the group takes no part |

From basou 0.72.0, record refuses an `http` value with a key the
observation does not declare a read of, or one it declares left out, and a
read that is not null when the status is not 2xx. From basou 0.73.0, it
refuses a `final_url` that holds a `?` or a `#`, a user name or a password,
or a character a terminal hides (as for a string of the other kinds), and
the guide's command leaves them out of the URL curl ended at: behind a
sign-in (a redirect to a login page) they can carry a token made anew each
time, which would show the observation as moved at every record and put the
token in a record kept in git. A record written before keeps the value it
holds, and the board page draws it as its parts.

- **The command reads the URL as `new URL` does**: a scheme and a host in
  lower case, a host outside ASCII in its ASCII form (`xn--`), a port that is
  the scheme's own left out, and the path with its dot segments resolved and
  what a URL may not hold as it is escaped (`%2e%2e` or a backslash in the
  path curl ended at reads as a step up or a `/`). The value is the same for
  the same URL.
- **A token in the path itself is kept**: a session id a server writes into
  the path for a client that keeps no cookie (`/login;jsessionid=...`) is
  part of the path, so the observation shows as moved at each record and the
  token is in the record. Make such an observation `manual` instead.

- **A 4xx or a 5xx is a value**, not an observation not made: the status is
  what was observed.
- When the status is not 2xx, the body is not read, and each of `words`,
  `count` and `capture` that is declared is `null` (`words` is one null, not a
  list of them): an error page's text is not the page's.
- The body is read whole as UTF-8, with a leading byte order mark taken off
  and nothing else decoded: a word is looked for character for character,
  and HTML entities are not decoded.
- The observation is not made (a null value with an error) when the request
  fails (the name does not resolve, TLS fails, 20 seconds pass, or it takes
  more than 10 redirects), when its status is not one of an HTTP response
  (100 to 599, such as a server answering 600, which curl prints as it is),
  when the URL it ended at is not an `http://` or `https://` URL (from
  basou 0.73.0), or when what curl left cannot be read. From basou 0.72.0
  the guide's command prints the whole entry for the record's input on one
  line, with what a terminal would act on or hide escaped: the value, or the
  null and the error. It gives the null, rather than count, at an empty
  match the declaration could not refuse: a `count_pattern` that matches the
  empty string only next to some text, as `\b` or a lookaround can.

The keys of the value are basou's words, so the check of the record's input
for the names of other workspaces ([3.1](#31-how-it-is-checked)) looks at
what they hold, not at them.

### 2.8 `components`

A mapping from a component's key to its entry. A component is a directory of
a repo that the built-in markers find (or its own `marker` finds), and the
registry says which lanes each counts in. A component found and not
registered is `unacknowledged`, and one registered and not found is `gone`;
either fires the axis review's trigger (a).

- **The key** is the name of the directory the repo is in (after symlinks),
  then `/` and the component's directory inside it (`app/db/migrations`), or
  the name alone for the repo's root (`app`): as the measurement's
  `components.found` names it. Two repos in directories of the same name
  cannot be told apart, and then the components are not measured.

| Key | Required | Since | Holds |
|---|---|---|---|
| `lane` | yes | 1 | a non-empty list of lane ids of the board, none twice; or `"-"`, for a component that counts in no lane |
| `note` | with `lane: "-"` | 1 | a non-empty string: why |
| `marker` | no | 3 | a glob, from the component's directory, of the files that mark it |

A `lane` here is never a single id, unlike a measure's.

**`marker`.** A directory no built-in marker finds (one of content or of
scripts) would be gone at every measure. With a `marker`, it is found, with
the kind `marker`, while a file the working tree lists under it matches the
glob from there: `**` for any file under it, `*.py` for a Python file right
in it. The glob is written and checked as an `include` is, and the
directories the built-in markers skip are not skipped for it. A key that is a
repo itself takes no `marker`, and a key that names a file finds nothing. A
component the built-in markers already find has `marker` added to its kinds
when it is given one, which the next measure reports as a change of kinds.

The built-in markers, in the working tree of each repo. A file under a
directory named `node_modules`, `vendor`, `dist`, `build`, `.svelte-kit`,
`target`, `__pycache__` or `.git` marks nothing.

| Kind | Found as | Component |
|---|---|---|
| `manifest` | `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pnpm-workspace.yaml`, `Gemfile`, `composer.json`, `deno.json` | the file's directory |
| `build` | `Makefile`, `justfile`, `Taskfile.yml` | the file's directory |
| `container` | a name that starts with `Dockerfile`; `compose*.yml` or `.yaml`, with or without `docker-` before it | the file's directory |
| `edge` | `wrangler.toml`, `wrangler.json`, `wrangler.jsonc`, `fly.toml`, `vercel.json`, `netlify.toml`, `render.yaml`, `Procfile` | the file's directory |
| `env` | `.env.example`, `.env.sample`, `.env.template` | the file's directory |
| `iac` | a name that ends with `.tf` | the file's directory |
| `iac` or `db` | a directory named `terraform` or `cloudflared` (`iac`), or `migrations` or `migration` (`db`), on a file's path | the first directory of any of these four names on the path, from the repo's root |
| `ci` | a `.yml` or `.yaml` file under `.github/workflows/` | `.github/workflows` |
| `db` | `config.toml` in a directory named `supabase`; `schema.prisma`; a name that starts with `drizzle.config.` | the file's directory |
| `sql` | a name that ends with `.sql`, not under a `migrations` or `migration` directory | the file's directory |

These are the rules of the `components` method 2 (see
[`methods`](#51-top-level-keys)).

### 2.9 `axis`

| Key | Required | Holds |
|---|---|---|
| `version` | yes | an integer of at least 1: the version of how the board is cut (its lanes and what its stages mean) |
| `review_due_days` | yes | an integer of at least 1: how many days after the last review the trigger (b) fires |
| `seed_review` | no | `{ date, model }`, a date and a non-empty string: the last review before the first record, for a board moved from elsewhere. It counts only while no record has an `axis_review` |

### 2.10 `effort`

| Key | Required | Holds |
|---|---|---|
| `start` | yes | a date: the first day the effort is counted from |
| `time_zone` | no | a name from the time zone database (`Asia/Tokyo`, `UTC`), not an offset such as `+09:00`. Without it, the days are in this host's time zone when it has a name |
| `milestones` | no | a list of `{ date, label, ref }`, a date and two non-empty strings: days to mark on the period and effort chart, each with a `ref` saying where it can be checked |

## 3. The record's input

`basou board record` reads one JSON object from `--file <path>`, or from
standard input (`--file -`, or no `--file`). A key given twice keeps its
last, as `JSON.parse` reads it.

```json
{
  "measure_digest": "sha256:<64 hex digits>",
  "observed": {
    "npm": { "value": "1.2.3", "observed_at": "2026-10-19T09:00:00Z", "source": "npm view example-cli version" },
    "site.home": { "value": null, "observed_at": "2026-10-19T09:01:00Z", "source": "https://example.com/", "error": "curl exit 28: the time ran out" }
  },
  "cells": [
    { "lane": "cli", "stage": "01", "state": "done" },
    { "lane": "cli", "stage": "02", "state": "done" },
    { "lane": "cli", "stage": "03", "state": "part" },
    { "lane": "cli", "stage": "04", "state": "none" },
    { "lane": "cli", "stage": "05", "state": "blocked", "reason": "The package name is not registered yet" },
    { "lane": "cli", "stage": "06", "state": "none" }
  ],
  "prose": {
    "summary": "What matters this time, and what moved",
    "lanes": { "cli": "What would move it" },
    "operator_turns": [{ "text": "Register the package name", "source": "task_<26 characters>" }],
    "footnotes": []
  },
  "judged_by": { "model": "<the model's name>", "self_reported": true },
  "axis_review": null
}
```

| Key | Required | Default | Holds |
|---|---|---|---|
| `measure_digest` | yes | | `sha256:` and 64 lowercase hex digits: the `digest` of the measurement the judgement saw |
| `observed` | no | `{}` | the observations, by key ([3.2](#32-observed)) |
| `cells` | yes | | every lane at every stage ([3.3](#33-cells)) |
| `prose` | yes | | the words of the record ([3.4](#34-prose)) |
| `judged_by` | yes | | `{ model, self_reported }` ([3.5](#35-judged_by-and-axis_review)) |
| `axis_review` | no | `null` | `null`, or the axis review this record holds ([3.5](#35-judged_by-and-axis_review)) |

### 3.1 How it is checked

In this order, and nothing is written when any step refuses:

1. **The board, and where the record goes** (before the input is read,
   with `--dry-run` too): `board.yaml` and the manifest read, the board is a
   file named `board.yaml`, and `records/` is not under `.basou/` and, unless
   `--not-private` is given, the innermost of the manifest's repos that holds
   it is declared private.
2. **The input is JSON.**
3. **It names no other workspace.** Every string and number of the input,
   and every key that is not a word of its shape (a key of `observed` or of
   `prose.lanes`, or one the input should not have), is held against the
   names of the other workspaces `~/.basou/portfolio.yaml` registers, and an
   input that names one is refused, saying where and never which. The values
   at `measure_digest`, each `observed_at`, each cell's `state` and the axis
   review's `triggers`, held to shapes of their own, are not looked at. (With no portfolio there is nothing
   to check against; one that cannot be read is said to be so on stderr, and
   the input goes on unchecked.)
4. **Its shape, and the declaration.** An unknown key is refused at every
   level but the keys of `observed` and of `prose.lanes`, each observation's
   value is held against its kind's shape ([2.7](#27-observe), from basou
   0.72.0), and every problem found is listed at once.
5. **The digest.** The board is measured again, as the model of
   `judged_by.model`, and the record is refused unless the digest is
   `measure_digest`: something measured, or `board.yaml`, changed since the
   judgement, or another basou measured it (see [The
   digest](#513-the-digest)).

`--dry-run` runs every step and writes nothing. The exit code is `0` when
the record was written (with `--dry-run`, when everything checked out) and
`1` when it was refused, with the reasons on stderr.

### 3.2 `observed`

A mapping from an observation's key to what was found:

| Key | Required | Holds |
|---|---|---|
| `value` | yes | a JSON value in the shape of its kind ([2.7](#27-observe)), or `null` when the observation was not made |
| `observed_at` | yes | when it was made, or tried: a date, or a date and a time of day with its offset (`2026-10-19T09:00Z`, `2026-10-19T18:00:00.5+09:00`); a time with no offset is refused |
| `source` | yes | a non-empty string: what was asked (the command, the URL, `the operator`) |
| `error` | with a `null` value | a non-empty string: why it was not made |

- **When the board declares observations, `observed` holds exactly those
  keys:** a declared one left out, and a key the board does not declare, are
  each refused. One not made is given as `"value": null` with its `error`,
  so a closed exit is never dropped from the board unsaid. With none
  declared, `observed` may be empty.
- The value is kept as `JSON.parse` read it, and basou does not interpret it.
  It is refused where it is not a JSON value: it nests more than 100 deep,
  holds a number too large to be held, or has a key named `__proto__`. From
  basou 0.72.0, when the board declares observations, it is refused too where
  it is not in the shape of its kind ([2.7](#27-observe)), and from basou
  0.73.0 where an `http` value's `final_url` has a user, a query or a
  fragment ([`http`](#http)); a `manual` value and a null are not checked.
  With none declared, the keys of `observed` are free and their values are
  not checked. A refusal says where in the value
  (`observed["site.top"].value.status`); one of what a key holds shows what
  it received, as up to 60 characters of its JSON (an escape counted as one)
  with what a terminal would act on or hide escaped. A value that is not a
  JSON value, or nests too deep, is refused for that alone.

### 3.3 `cells`

A list with one cell for every lane of the board at each of the six stages,
each lane and stage once.

| Key | Required | Holds |
|---|---|---|
| `lane` | yes | a lane id of the board |
| `stage` | yes | `"01"` to `"06"` |
| `state` | yes | `done`, `part`, `blocked`, `shelved`, `none` or `unverified` |
| `reason` | for `blocked`, `shelved` and `unverified` | a non-empty string |

What the states mean, and how to judge them, is in `basou board guide`. The
guide's template of the input gives each cell the previous record's state as
`previous`: delete it, since a cell takes no other key.

A stage left behind (`none`, `blocked` or `shelved` before a later stage of
the lane that is `done` or `part`; `unverified` counts neither way) is
recorded as an order anomaly, not refused (see
[`order_anomalies`](#45-order_anomalies)).

### 3.4 `prose`

| Key | Required | Default | Holds |
|---|---|---|---|
| `summary` | yes | | a string |
| `lanes` | no | `{}` | a mapping from a lane id of the board to a string |
| `operator_turns` | no | `[]` | a list of `{ text, source }`, two strings: what waits for the operator's ruling, and where it comes from |
| `footnotes` | no | `[]` | a list of strings |

All are plain strings: the board page shows HTML as text, and draws only
`` `code` `` as code.

### 3.5 `judged_by` and `axis_review`

| Key of `judged_by` | Required | Holds |
|---|---|---|
| `model` | yes | a non-empty string: the model that judged, as it reports itself |
| `self_reported` | yes | `true`, always: basou cannot tell which model judged |

`axis_review` is `null`, or:

| Key | Required | Holds |
|---|---|---|
| `triggers` | yes | a non-empty list of the triggers that led to the review, each once: `a` (the components changed), `b` (`review_due_days` passed), `c` (another model judges), `d` (the operator asked), `e` (a built-in section measures another way) |
| `summary` | yes | a non-empty string: what was reviewed and decided |

A record with an `axis_review` is the last review that the triggers (b) and
(c) count from.

### 3.6 What `basou board record --json` prints

| Key | Holds |
|---|---|
| `record` | where the record was written (beside `--board` as given, or else from the current directory); null with `--dry-run` |
| `dry_run` | whether it was a dry run |
| `complete` | whether the measurement recorded was complete |
| `not_found` | what it could not measure, and why ([5.1](#51-top-level-keys)) |
| `order_anomalies` | as the record holds them |
| `diff` | what moved since the previous record: `{ against, measure, cells, observed }`, or null when there is none or it cannot be read (`not_found` then has an entry at `diff`) |

In `diff`, `against` is the previous record's ULID; `measure` is the
measurement's [`diff`](#512-diff) without `against`; `cells` lists each cell
whose state moved, as `{ lane, stage, before, after }` (null where there was
no such cell); and `observed` lists each observation whose value or error
moved, as `{ name, before, after }`, each `{ value, error }` (no `error` when
there is none), or null where there was no such observation.

Without `--json`, the text says where the record is, then what moved since the
previous record: the cells, the observations, the measurement's `diff`, and,
from basou 0.72.0, where the declaration changed ([5.12](#512-diff)), which
the JSON does not hold.

## 4. A record

`records/<ULID>.json`, written whole (to a file of another name, then linked
into place) and never changed after. A record cannot be taken back; only a
later one is added.

| Key | Holds |
|---|---|
| `record_version` | `3` |
| `recorded_at` | when it was recorded: UTC, ISO 8601 with milliseconds. After the measurement it holds; a record written by basou 0.71.1 or earlier took it just before measuring again |
| `recorded_with` | `{ basou, build }`: the version of the basou that recorded it, and the commit it was built from (null for a build from source) |
| `declaration` | the declaration the board was measured and judged by ([4.2](#42-declaration)) |
| `measure` | the measurement, as `basou board measure --json` prints it, without `diff` ([5](#5-the-measurement)) |
| `observed` | as the input, with its default |
| `cells` | as the input |
| `prose` | as the input, with its defaults |
| `judged_by` | as the input |
| `axis_review` | as the input, with its default |
| `order_anomalies` | the stages left behind ([4.5](#45-order_anomalies)) |

### 4.1 What the record holds as it was judged, and what it does not

The measurement is taken again when the record is written, and the record
is written only when its digest is the one the judgement saw. So what the
digest covers (the declaration included) is as the judgement saw it. What
the digest leaves out ([5.13](#513-the-digest): `measured_at`, `freshness`,
`axis`, `effort.elapsed_days` and today's row of `effort.daily`, each repo's
`fetched_at`) is as measured again, not necessarily as the judge saw it.

### 4.2 `declaration`

The declaration as read: every key of [2.2](#22-top-level-keys) but
`board_version`, which the measurement holds. Defaults are filled in
(`measures`, `ratios` and `observe` as `[]`, `components` as `{}`, `at` as
`worktree`, a `regex_capture`'s `group` as `1`, a `file_name`'s `group` as
`1` when it has a `pattern`, a `branch` as `main`), and a measure's `lane` is
a list. A board of version 1 is held with `observe: []`.

### 4.3 `measure`

The measurement ([5](#5-the-measurement)) without `diff`, which the previous
record derives. Its digest is `boardDigest(record.measure,
record.declaration)` (exported from `@basou/core`, which is not a guaranteed
surface either), for a record written by basou 0.68.2 or later; an earlier
basou's digest did not cover the declaration.

### 4.4 `observed`, `cells`, `prose`, `judged_by` and `axis_review`

As the input gave them ([3](#3-the-records-input)), with their defaults
filled in.

### 4.5 `order_anomalies`

A list of `{ lane, stage, state, before }`, in the order of the lanes and
their stages: a stage that is `none`, `blocked` or `shelved` (`state`)
before a later stage of the lane that is `done` or `part`, the first of
which is `before`.

## 5. The measurement

`basou board measure --json` prints it; a record holds it without `diff`.
It reads and never writes, and sends nothing. Its exit code is `0` when
everything was measured, and `1` when something was not (the measurement is
still printed) or the declaration or the manifest cannot be read (nothing is
printed on stdout).

**What a null means.** A value is `null` when it could not be measured, and
then `not_found` has an entry saying why and `complete` is false: a missing
repository, revision or file is never counted as zero. The exceptions are
the nulls that mean something of their own, which have no entry and leave
`complete` as it is. Each section below names its own.

### 5.1 Top-level keys

| Key | Holds |
|---|---|
| `board_version` | the declaration's `board_version` |
| `title` | the declaration's `title` |
| `measured_at` | when it was measured: UTC, ISO 8601 with milliseconds |
| `measured_with` | `{ basou, build }`, as a record's `recorded_with` |
| `complete` | `true` when `not_found` is empty |
| `not_found` | a list of `{ at, reason }`: what was not measured, where, and why |
| `digest` | `sha256:` and 64 hex digits ([5.13](#513-the-digest)) |
| `methods` | the version of how each built-in section measures (below) |
| `repos` | each repo the manifest declares, in its order ([5.2](#52-repos)) |
| `measures` | each measure, by id ([5.3](#53-measures-and-ratios)) |
| `ratios` | each ratio, by id ([5.3](#53-measures-and-ratios)) |
| `trail` | the workspace's decisions and open tracks ([5.4](#54-trail)) |
| `integrity` | what `basou verify` finds ([5.5](#55-integrity)) |
| `review_gaps` | what `basou review-gaps` finds ([5.6](#56-review_gaps)) |
| `portfolio` | how many workspaces the portfolio registers ([5.7](#57-portfolio)) |
| `freshness` | how current the trail is ([5.8](#58-freshness)) |
| `effort` | the work since the board's start ([5.9](#59-effort)) |
| `components` | the components found, held against the registry ([5.10](#510-components)) |
| `axis` | whether the axis is due a review ([5.11](#511-axis)) |
| `diff` | what moved since the previous record ([5.12](#512-diff)); only in `basou board measure --json` |

**`not_found`.** Its `at` names the place: `repos[../app].behind` (a repo by
its path as the manifest writes it), `repos[../app]` when nothing of a repo
could be measured, `measures.commands` or `measures["site.pages"]`,
`ratios.tested`, `trail`, `integrity`, `review_gaps`, `portfolio`,
`freshness.newest_session_at`, `freshness.unimported`, `effort`,
`effort.active_ms`, `effort.output_tokens`, `effort.commits[../app]`,
`components`, `components.gone`, `components.kind_changed`,
`axis.last_review`, `axis.review_needed` and `diff`.

**`methods`.** `{ repos, trail, integrity, review_gaps, portfolio,
freshness, effort, components, axis }`, each an integer. A section's method
is raised only when the same input would give a value of it another way,
never for an added field or a new key of the declaration. A method that
differs from the previous record's fires the axis review's trigger (e), and
the values of that section in `diff` are marked `method_changed`. In 0.71.0
they are `portfolio` 1 and every other section 2. From basou 0.73.0 `repos`
is 3: its `files` leaves out a symlink that leaves the repository
([5.2](#52-repos)).

### 5.2 `repos`

A list, in the manifest's order:

| Key | Holds |
|---|---|
| `path` | the path as the manifest writes it |
| `name` | the name of the directory the repo is in, after symlinks |
| `head` | the full id of HEAD's commit |
| `branch` | the branch HEAD is on |
| `last_commit` | HEAD's committer time as git recorded it: ISO 8601 with its offset |
| `commits` | the commits reachable from HEAD, merges and all |
| `files` | the files a measure sees in the working tree (tracked, and untracked but not ignored, on disk), as a `file_count` of `**` counts them, less each symlink that leaves the repository (below) |
| `uncommitted` | the paths `git status` names: each untracked file on its own, not its directory, and a rename as the two paths it touches |
| `base` | the branch of origin HEAD is compared with, as `origin/<branch>`: the one `refs/remotes/origin/HEAD` names, or `origin/main` when it names none |
| `behind` | the commits on `base` that HEAD does not have, as of the last fetch |
| `ahead` | the commits HEAD has that `base` does not, as of the last fetch |
| `fetched_at` | when this worktree's `FETCH_HEAD` was last written, in UTC (below) |

- **`files` leaves out a symlink that leaves the repository**, such as an
  agent's instruction file linked in from another repo (tracked, or
  untracked and not ignored): what it ends at cannot be told to be a file
  without looking outside the repository, and a built-in value takes no
  `exclude`. When what it ends at cannot be reached (a directory on the way
  that may not be entered), it is still left out when its text, or that of
  a link in the repository it leads to, leaves the repository. A
  `file_count` of `**` is not measured for one. A path that cannot be read,
  or a directory git could not list in full, still makes `files` null, with
  the reason at `repos[<path>].files`. Up to `repos` method 2 (before basou
  0.73.0), such a symlink made `files` null too, with the reason `'<path>' is
  a symlink to outside the repository`.
- **An untracked directory counts every file in it**, in `files` and in
  `uncommitted` alike, and so does any measure whose globs reach it: what a
  repo holds but does not own (a build's output, a tool's cache) is counted
  until it is ignored, in `.gitignore` or in `.git/info/exclude`.
- `ahead` above 0 is not only commits not pushed: a branch pushed and not
  merged into `base` has them, and so has one whose commits came into `base`
  as other commits (a squash or a rebase). Read it with `branch`.
- `fetched_at` is the time of `FETCH_HEAD` only when it holds the line of
  `base`'s branch fetched from origin's URL at the commit `base` is at now:
  as a rule, when this checkout last fetched it. It is null otherwise: no
  fetch since the clone, a fetch that failed (it empties `FETCH_HEAD` and
  still moves its time), a fetch since from another URL or of other branches
  only, or `base` moved since without a fetch here (a push, or a fetch in
  another worktree). A later fetch with `--append` moves the time and leaves
  the line. **It is neither in the digest nor compared with the previous
  record**: a fetch that brings nothing moves it too. When it is null or old,
  `behind` and `ahead` may be old too. basou does not fetch.

Nulls that mean something, with no entry: `branch` when HEAD is detached;
`head` and `last_commit` when the repo has no commit yet (`commits` is then
0); `base`, `behind` and `ahead` when `origin/HEAD` names no branch and there
is no `origin/main`; `fetched_at` as above. Any other null has an entry at
`repos[<path>].<key>`, or at `repos[<path>]` when nothing of the repo could
be measured.

### 5.3 `measures` and `ratios`

`measures` maps each measure's id to `{ value, unit, lane }`: the value
([2.5](#25-measures)), the declared `unit`, and the declared lanes as a list
(no `lane` when it has none). `ratios` maps each ratio's id to `{ value,
numerator, denominator }`: the value ([2.6](#26-ratios)) and the ids of the
two measures.

### 5.4 `trail`

The workspace's own decisions, read from its events (not from
`decisions.md`), on this host only:

| Key | Holds |
|---|---|
| `decisions_all` | the decisions recorded, a decision recorded twice under one id counted once |
| `decisions_live` | those not voided |
| `tracks_open` | the open tracks (decisions recorded as a track and not voided), each `{ id, title }`, newest first, as `basou orient` lists them |

All three are null, with one entry at `trail`, when the events cannot be read
whole: an event line could not be read (a torn last line, a write in
progress, does not count), an entry named as a session is not a directory, a
session's events cannot be read, or the sessions cannot be listed.

### 5.5 `integrity`

What `basou verify` finds in the workspace's own sessions, on this host only:

| Key | Holds |
|---|---|
| `by_status` | how many sessions have each status, every status included at 0: `verified`, `unchained`, `empty`, `incomplete`, `in_progress`, `unsupported`, `tampered` |
| `not_verified` | the sessions whose status is not `verified` |

Both are null, with one entry at `integrity`, when the sessions cannot be
listed or a session cannot be read: a count that left one out would be wrong.

### 5.6 `review_gaps`

What `basou review-gaps` finds in the workspace's own trail, on this host
only, over every repository and with its default window:

| Key | Holds |
|---|---|
| `by_verdict` | how many units of work have each verdict, every verdict included at 0: `omission`, `near_unbound`, `candidate`, `unknown` |
| `gaps` | the units it lists as gaps: those with no bound review trail |

Both are null, with one entry at `review_gaps`, when the sessions cannot be
read whole: `basou review-gaps` passes over a session it cannot read, and a
commit in it would be a gap the count leaves out.

### 5.7 `portfolio`

| Key | Holds |
|---|---|
| `workspaces` | the workspaces `~/.basou/portfolio.yaml` registers on this host, each path once |
| `initialized` | of them, those whose path is there and holds a `.basou/` directory |

Counts only, never a name, a path or a label. Both are null **with no entry**
when there is no portfolio config at all (a board of someone who uses none is
complete), and null with an entry at `portfolio` when the config is there and
`basou portfolio` refuses it.

### 5.8 `freshness`

How current the workspace's trail is on this host, as `basou orient` judges
it. **Not in the digest**: it moves as work goes on, the measuring session's
own included.

| Key | Holds |
|---|---|
| `newest_session_at` | when the newest session that is not archived started |
| `unimported` | `{ new, updated, unverifiable }`: the sessions a `basou refresh` would newly import, import again, or could not import again safely |

`newest_session_at` is null with no entry when there is no such session, and
null with an entry when the sessions cannot be read whole. `unimported` is
null with an entry when the dry run of an import could not run.

### 5.9 `effort`

The work since the board's start, counted by day in its time zone. Time and
tokens are every session's, as `basou stats` counts them; an interval that
crosses a midnight is split between the days, and nothing before the start
counts.

| Key | Holds |
|---|---|
| `start` | the declared `start` |
| `time_zone` | the declared time zone or this host's, as `Intl` names it (a declared `utc` is held as `UTC`; the record's `declaration` keeps it as written) |
| `elapsed_days` | the days from the start to today: today less the start, 0 on the first day. **Not in the digest** |
| `active_ms` | `{ union, claude, codex }`: active time in milliseconds, every session's intervals merged, Claude Code's among themselves, and Codex's among themselves |
| `output_tokens` | the output tokens of the sessions that recorded them (reasoning not included) |
| `sessions_without_tokens` | the Claude Code and Codex imports that recorded no tokens, so that `output_tokens` is a floor while this is above 0 |
| `commits` | by the manifest's path: the commits reachable from HEAD authored from the start to today |
| `daily` | one row a day from the start to today, each `{ date, active_ms, output_tokens, commits }` as above, for that day (the tokens of the sessions that started that day). **Today's row is not in the digest** |

- With no time zone declared and none `Intl` can name, there are no days to
  count by: every value but `start` is null, with one entry at `effort`.
- `active_ms` and `output_tokens` are null (with `sessions_without_tokens`),
  with entries at `effort.active_ms` and `effort.output_tokens`, when the
  sessions cannot be read whole.
- `active_ms.codex` is null **with no entry** when there is no Codex session
  at all, where 0 is a Codex that did nothing.
- **Per day**, on the board page, is `active_ms.union` divided by the rows of
  `daily`: the days from the start to today, both included, which is one more
  than `elapsed_days` (on the first day, the time so far is the day's). The
  page says what it divided by.
- A repo's `commits` is null, with an entry at `effort.commits[<path>]`, when
  its history is not known.

### 5.10 `components`

The components the built-in markers ([2.8](#28-components)) find in the
working tree of each repo, held against the registry:

| Key | Holds |
|---|---|
| `found` | by key: `{ kinds, status }`, the kinds of marker found for it (sorted) and `known` (registered) or `unacknowledged` |
| `unacknowledged` | the keys found that the registry does not hold, by code point |
| `gone` | the keys the registry holds, or the previous record found, that were not found now, by code point |
| `kind_changed` | the keys found now and in the previous record with other kinds, each `{ key, before, after }`, by code point |

- Every value is null, with one entry at `components`, when a repo cannot be
  opened, git could not list all of a working tree, two repos are in
  directories of the same name, or a component's directory is not a valid
  UTF-8 name.
- `kind_changed` is null **with no entry** when there is no previous record,
  or it did not measure the components.
- When the previous record cannot be read, `gone` and `kind_changed` are null,
  each with an entry.
- The order of the keys of `found` is not part of it.

### 5.11 `axis`

Whether the axis is due a review, by the triggers basou can judge: (a) the
components changed (unacknowledged, gone or of other kinds), (b)
`review_due_days` or more days passed since the last review, (c) the model
that judges (`--model`) is not the one that reviewed last, and (e) a
built-in section's method changed since the previous record. (d), the
operator's word, is not judged. **Not in the digest**, nor its entries in
`not_found`: it rests on the day, the model and the records rather than on
what was measured.

| Key | Holds |
|---|---|
| `version` | the declaration's `axis.version` |
| `review_needed` | `true` when a trigger fired; `false` when none did; null, with an entry at `axis.review_needed`, when none fired but one could not be judged for want of what it rests on (the components, a time zone, a record that cannot be read) |
| `reasons` | the triggers that fired, each `{ trigger, detail }`, in the order a, b, c, e |
| `unjudged` | the triggers not judged, each `{ trigger, why }`, in the same order. (c) with no `--model`, and (e) with no previous record, are listed here and do not keep `review_needed` from being false |
| `last_review` | `{ date, model, from: "record", record }` for the last record with an `axis_review` (its date in the effort's time zone), or `{ date, model, from: "seed" }` for the declaration's `seed_review` when no record has one; null when there is none, which fires (b), and (c) when a model is given |

`last_review` is null with an entry at `axis.last_review` when a record that
may hold it cannot be read; (b) and (c) are then not judged. Two model names
are the same model when they match lower-cased, with each run of anything
but an ASCII letter or digit read as one `-` and none at either end (when
either has no ASCII letter or digit, the names themselves are compared,
lower-cased and trimmed).

### 5.12 `diff`

What moved since the previous record, value by value; only in `basou board
measure --json` (a record does not hold it). Null with no entry when there is
no previous record, and null with an entry at `diff` when it cannot be read.

| Key | Holds |
|---|---|
| `against` | the previous record's ULID |
| `values` | each value that moved: `{ at, before, after, delta, method_changed }`, `delta` (after less before) only when both are numbers |
| `methods` | each section whose method moved: `{ section, before, after }`, null where a record had none |
| `added` | each value there only now: `{ at, value, method_changed }` |
| `removed` | each value there only in the previous record, the same |

- `at` names the value as `repos["../app"].commits`, `measures.commands.value`
  or `trail.tracks_open["decision_<id>"].title`, and a path that came in or
  went out of a `file_paths` measure as `measures.migrations.value["db/a.sql"]`
  (with the value `true`). `method_changed: true` is there only when its
  section's method moved.
- **Compared** are the values the digest covers, except `measured_with`,
  `methods` (compared on their own), `effort.daily` (its rows only grow) and
  `components.kind_changed` (already a change since the previous record).
  The declaration, which the digest also covers, is not compared in `diff`:
  the JSON holds no change of it. The text `basou board measure` and `basou
  board record` print without `--json` lists it (see below).
- Values are equal when their JSON is, keys sorted. A list whose entries name
  themselves is compared entry by entry: `repos` by `path`,
  `trail.tracks_open` by `id`, `not_found` by `at`. `components.unacknowledged`
  and `components.gone` are compared as sets, and so are the paths of a
  `file_paths` measure when both records hold a list (a path that came in is
  `added`, one that went out is `removed`); any other list is compared whole.
- A measure's lane held as one id, as a record of version 1 or 2 holds it, is
  equal to the list of that one.

**Where the declaration changed, in the text only.** From basou 0.72.0, the
text `basou board measure` and `basou board record` print without `--json`
lists, under `Since the previous record <ULID>:` and after what moved in the
measurement, each place where the declaration the board is measured by now
differs from the one the previous record holds, one line each:
`declaration <where>: added`, `removed` or `changed`, and
`declaration lanes: the order changed`. No key of the JSON holds these.

- `<where>` names the place as `at` does: `stages.03.look`,
  `lanes["web"].notes`, `observe["site.top"]` (an observation added or
  removed), `measures["readme.latest"].include`, `components["app/db"].lane`.
- Both declarations are compared as a record holds them
  ([4.2](#42-declaration)): with their defaults filled in, and a record of
  version 1 with `observe` as `[]`. A measure's lane is not listed (see
  below), so the first record after a board moves to version 3 lists nothing
  for its lanes held as one id.
- The lanes, the measures and the ratios are compared by id, and the
  observations by key, each key of an entry on its own; the lanes' order is
  one line of its own. Any other list (`notes`, `look`, `words`, `include`,
  `effort.milestones`) is compared whole.
- Not listed again is what `values`, `added` and `removed` show already: the
  title, a measure's `unit` and `lane`, a ratio's `numerator` and
  `denominator`, `effort.start`, `effort.time_zone` when both declare one,
  and a measure or a ratio added or removed (its values are added or
  removed).
- When the previous record holds no declaration that is an object, or one
  nested too deep to compare (only a record written by hand can), one line
  says it is not compared: `declaration: not compared (...)`. The record is
  still written.

### 5.13 The digest

`digest` is `sha256:` and the hex SHA-256 of a JSON text: the measurement
with the keys below left out, and the declaration (as a record's
`declaration` holds it, [4.2](#42-declaration)) added under the key
`declaration`, written with every object's keys sorted and no whitespace.

Left out:

- `measured_at`, `digest`, `freshness`, `axis` and `diff`;
- the entries of `not_found` at `axis` or under `axis.`;
- `effort.elapsed_days` and the last row of `effort.daily` (today's);
- each repo's `fetched_at`.

Everything else is in it, `measured_with` included. So the digest moves with
any change to what the board measures (the repos' commits, their counts of
files and of uncommitted paths, the trail, the portfolio's counts), with any
change to what `board.yaml` declares (not its comments or layout, though
editing the file can move a repo's counts as editing any file can), and with
a basou of another version or build. Two measurements of the same values by
the same declaration and the same basou have the same digest whenever they
were taken.

## 6. Records of version 1 and 2

Every version is read, compared with and drawn. A record of version 1 or 2
differs from version 3 in what it holds:

- A measure's `lane`, in `measure.measures` and in `declaration.measures`, is
  one lane id, where version 3 holds a list. It is read as a list of that one,
  so a lane written either way is not a change.
- Its repos have no `base`, `ahead` or `fetched_at`, and hold the commits
  behind as `behind_main`. The first difference from such a record shows
  `behind_main` removed and `base`, `behind` and `ahead` added.
- Its declaration is of `board_version` 1 or 2. The declaration a record of
  version 1 holds has no `observe` (its `observed` may still hold entries,
  under any names) and no stage's `look` or `notes`.
