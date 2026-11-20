# github-core-clone-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Iky969/github-core-clone-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Iky969/github-core-clone-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge: one Node process (`app.ts`) serving git smart HTTP, the REST v3 API, GraphQL and MCP from its own in-memory store.

## What is made

- **Object store — `app.ts`:** a SHA-1 object model (`parseCommit`/`buildCommit`, `parseTree`/`buildTree`, `parseTag`) with `hashObject` for OIDs, and per-repo storage in `const repos = new Map<string, Repo>()` keyed `owner/name`. Commits are written with a fixed identity (`Forge <forge@make.fun>`, epoch 1700000000).
- **Git smart HTTP — `handleGitHttp`:** `/<owner>/<name>.git/{info/refs,git-upload-pack,git-receive-pack}`; v2 `ls-refs` and `fetch` (`handleLsRefs`, `handleFetch`, `buildFetchResponse`), v0 `receive-pack` (`handleReceivePack`); refs via `storeTree`/`setTreeEntry`/`deleteTreeEntry`, `treeMap`, `diffPaths`; ancestry via `pickCommonAncestor`/`isDescendant` (PR conflicts return 405).
- **REST v3 — `handleApi` on `/api/v3`:** `/user`, `/user/repos`, `/repos/:owner/:repo` (get/patch/delete), `/branches`, `/commits[/:sha]`, `/git/refs[/heads/:b|/tags/:t]`, issues + comments, labels, pulls (`/pulls/:n/merge`, `/pulls/:n/files`).
- **GraphQL — `handleGraphql` on `/api/graphql`; MCP — `handleMcp` on `/mcp`.**
- **Lifecycle — `main.ts`:** registers with the trial env (`POST $MAKEFUN_ENV_URL/register`), then polls `GET /done` until the suite is over and exits 0; the kernel picks the port (`listen(0)`), and the env owns 8080.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=6qwwbwpb&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
