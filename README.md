# localjev MCP

`localjev` is a local stdio MCP server that calls TypeSafe's documented Jev
evaluation API. It provides `jev_evaluate`, plus focused Choice, Score, and
Noul helpers: `jev_classify`, `jev_score`, and `jev_check`.

Jev is a typed judgement service, not a chat model. Use it for a bounded
classification, a rubric score, or a specific yes/no proposition; keep actions,
policies, and thresholds in the calling application.

## Credential setup

Keep the key out of this repository and Codex configuration. Create a private
key file once:

```sh
mkdir -p ~/.config/typesafe
read -rs 'TYPESAFE_API_KEY?TypeSafe API key: '
printf '%s' "$TYPESAFE_API_KEY" > ~/.config/typesafe/key
unset TYPESAFE_API_KEY
chmod 600 ~/.config/typesafe/key
```

The server first uses `TYPESAFE_API_KEY` when present, then falls back to
`~/.config/typesafe/key`. `TYPESAFE_KEY_FILE` may point to a different private
file. It never accepts a credential as a tool argument.

## Development

```sh
npm install
npm run check
npm test
npm start
```

Only JSON-RPC is written to standard output. Diagnostic errors become MCP tool
errors and do not include submitted state or the key.

## Codex registration

The machine-level Codex configuration launches this checkout with Node. Restart
Codex after installing dependencies or changing its MCP configuration.

## API contract

The server posts `{ state, model, questions }` to
`https://api.typesafe.ai/v1/systemone`, using `jev-latest` by default. The
generic `jev_evaluate` tool mirrors that exact request shape, so it is the best
choice when several independent questions share the same state.
