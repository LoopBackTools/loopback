# @loopbacktools/protocol

The [Loopback](https://github.com/LoopBackTools/loopback) API contract. One TypeSpec definition
(`spec/main.tsp`) describes the REST operations an inbox uses, the operations an agent calls, which
are also its MCP tools, and the frames the event socket sends. This package carries the definition,
for each edge to compile its routes and tools from, and what is generated from it:

- `@loopbacktools/protocol`: framework-free TypeScript types for every shape, such as `Ask`, `Reply`
  and `ServerEvent`.
- `@loopbacktools/protocol/openapi.json`: the OpenAPI 3.1 document, for clients in any language.
- `@loopbacktools/protocol/document`: the same document as a module, which an edge serves.

An edge compiles the definition with `import "@loopbacktools/protocol";` in a `main.tsp` of its own,
emitting `typespec-hono` and `typespec-http-mcp`; install `@typespec/compiler`, `@typespec/http`,
`@typespec/openapi` and `@typespec/versioning` beside it.
[`apps/loopback`](https://github.com/LoopBackTools/loopback/tree/main/apps/loopback) is the example.

To build a frontend, use [`@loopbacktools/sdk`](https://www.npmjs.com/package/@loopbacktools/sdk), which
is typed with these.

## Stability

Until 1.0, a minor release may change this package's API. Pin the minor version you build on.

MIT licensed.
