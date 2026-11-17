# github-core-clone-4

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/abduljunior425/github-core-clone-4/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/abduljunior425/github-core-clone-4/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone GitHub-compatible git forge, built for the
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty:
one process, no UI, no git binary, no outside service.

- **Git smart HTTP** — upload-pack protocol v2 (`ls-refs`, `fetch` with shallow
  and deepen) and receive-pack v0 with report-status, fast-forward enforcement
  and per-ref `ok`/`ng` lines.
- **REST API v3** — repositories, branches, git refs, commits, contents
  (real commits in the shared object store), labels, issues, comments, pull
  requests and squash merges.
- **GraphQL** — `repository`, `viewer`, `node`, `__type` introspection, issue
  and pull-request connections with cursor pagination, and the create/close/
  merge/comment mutations.
- **MCP** — JSON-RPC 2.0 over Streamable HTTP: `server/discover`, `initialize`,
  `tools/list` and six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`).

## Architecture

Node.js/TypeScript, standard library only. A single content-addressed object
store (SHA-1, git object format) is shared by git, REST, GraphQL and MCP, so
every surface reads and writes the same objects. Fetch responses are built
once per (repository, wants, haves, depth, shallow boundaries) and cached on
the repository, so fifty concurrent shallow clones of one tip share a single
built pack. Packs are delta-free and byte-stable; timestamps come from the
trial clock (`MAKEFUN_TRIAL_NOW` plus a monotonic counter), never the wall
clock, so a replay of the same request sequence answers byte-for-byte the
same values.

## Run

```sh
node main.ts
```

The server listens on an ephemeral port, registers it with
`$MAKEFUN_ENV_URL/register`, and exits 0 when `GET $MAKEFUN_ENV_URL/done`
answers `{"done": true}`.

## License

MIT — see [LICENSE](LICENSE).
