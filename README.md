# dsh-provider-extra

Extra provider routes for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

- **OpenCode Go:** sends the live conversation ID in `x-opencode-session` for routing and prompt caching.
- **OpenAI Codex:** uses a ChatGPT subscription through pi-ai's OAuth flow and the harness credential store.

This repository is installed from source. It is not published to npm. `private: true` prevents accidental publication. The code is [MIT licensed](LICENSE).

## Requirements

- Node.js 24 LTS (verified with 24.20.0).
- pnpm 11.21.0 for this repository.
- A built DeepSeek Harness checkout. The tested revision is `aa8262ec091698bae9a6b04773a6b5b06ad4aef2`.

The npm harness packages still resolve to `0.0.1-rc.1` as of September 18, 2026. This plugin uses the source checkout rather than assuming those releases provide the required APIs. Keep the plugin and the running harness on the same checkout to avoid mixing framework instances.

## Install from source

Clone this repository, then prepare the pinned harness inside its ignored `.harness` directory:

```sh
git clone https://github.com/assagman/dsh-provider-extra.git
cd dsh-provider-extra
git clone https://github.com/deepseek-ai/deepseek-harness.git .harness
git -C .harness checkout aa8262ec091698bae9a6b04773a6b5b06ad4aef2
pnpm --dir .harness install --frozen-lockfile
pnpm --dir .harness run build
pnpm install --frozen-lockfile
pnpm run check
```

The harness build includes its native and web components. Follow the [upstream development prerequisites](https://github.com/deepseek-ai/deepseek-harness/blob/aa8262ec091698bae9a6b04773a6b5b06ad4aef2/docs/development.md) for your platform.

If you already run a built harness checkout, link it instead of cloning a second copy. On macOS or Linux, from this repository:

```sh
ln -s /absolute/path/to/deepseek-harness .harness
pnpm install --frozen-lockfile
pnpm run check
```

If `.harness` does not exist, you can use this alternative. Do not overwrite an existing checkout. No tracked file needs your machine's absolute path. The lockfile links through `.harness` on every machine.

## Register each profile

Web and TUI are separate compositions. From this built plugin checkout, add the bundle to each profile you use:

```sh
dsh plugin --profile web add "link:$PWD"
dsh plugin --profile tui add "link:$PWD"
```

If you have no `dsh` launcher, replace `dsh` with `pnpm --dir .harness dsh`. Use the same harness installation that runs your profiles.

The package declares `dsh.bundle.patch`. The CLI adds it to the profile's bundle list, and its patch loads the compiled plugin automatically. `add link:` records a dependency that DSH can manage. A bare `pnpm link` is not the registration procedure.

To remove it from a profile:

```sh
dsh plugin --profile web remove dsh-provider-extra
dsh plugin --profile tui remove dsh-provider-extra
```

These commands remove the profile dependency and bundle activation, not your source checkout or stored credentials. Restart the affected profiles after adding or removing the bundle.

### Optional profile overrides

Defaults use the `opencode-go` and `openai-codex` routes, `OPENCODE_API_KEY`, and the fallback session ID `dsh-provider-extra`.

To customize them, add an ID-targeted override to `$DSH_HOME/profiles/web/cordis.patch.yml`, `$DSH_HOME/profiles/tui/cordis.patch.yml`, or both. `DSH_HOME` defaults to `~/.dsh`.

```yaml
- id: dsh-provider-extra
  config:
    apiKeyEnv: OPENCODE_GO_API_KEY
    routeId: opencode-go-session
    displayName: OpenCode Go (session)
    # codexEnabled: false
```

Preserve unrelated profile entries. Do not add a manual `insert` or `name`: the bundle owns plugin activation. Overrides can remain after removal without keeping the plugin active.

If you used the earlier manual registration, replace its `insert` block with an ID-targeted override before running `add`. Keep your existing `config` values. A leftover manual insert can cause duplicate loading or keep the plugin active after `remove`.

Rebuild with `pnpm run build` after source changes, then restart the affected profiles. The bundle uses compiled JavaScript without a TypeScript loader. Keep the linked checkout at its registered path.

Keep `opencode-go` and `openai-codex` out of the built-in `llm-pi-ai` provider configuration. A route can have only one adapter. A duplicate produces `DUPLICATE_ADAPTER`. The plugin logs the conflict and leaves that route with its existing owner. You can choose a different `routeId`, such as `opencode-go-session`, when you need both Go routes.

Start the profile from the same harness checkout:

```sh
pnpm --dir .harness dsh web
# Or:
pnpm --dir .harness dsh --profile tui
```

An existing `dsh` launcher is also suitable if it uses that checkout. Select a model from the registered route in the model picker.

## OpenCode Go credentials and models

Store the API key through the harness credential service, using the reference named by `apiKeyEnv`. Alternatively, supply that environment variable to the harness. Do not put keys in the patch file. `baseURL` and `headers` can override the gateway endpoint and add static headers. For the standard gateway, leave them unset.

The plugin reuses `PiAiAdapter` and pi-ai's `opencode-go` catalog. It injects the routing header on both `prepareCall()` and direct stream dispatch. The request's session ID takes precedence over `fallbackSessionId` and static headers. Without a request ID or configured fallback, the plugin sends no session header.

The pinned catalog is extended with `deepseek-flash` (DeepSeek V4.1 Flash), cloned from `deepseek-v4-flash`. Add other models in `$DSH_HOME/settings.yaml` without rebuilding or restarting:

```yaml
dsh-provider-extra:
  extraModels:
    - id: deepseek-flash
      name: DeepSeek V4.1 Flash
      template: deepseek-v4-flash
```

Each entry clones wire behavior from its template. Later entries win by ID. A catalog-owned ID is not replaced. An unknown template becomes a model diagnostic without disabling the route.

## Codex sign-in

Run the attended login from this repository, with the same `DSH_HOME` as your harness:

```sh
pnpm codex:login
# If the server uses a non-default credentials file:
pnpm codex:login --credentials-path /absolute/path/to/.credentials.yaml
```

Choose device-code login for a headless host or browser login for a desktop. Follow the URL and prompts printed by pi-ai. The browser callback uses `localhost:1455`. The prompt also accepts a pasted redirect URL.

The grant is stored in `$DSH_HOME/.credentials.yaml` by default. Writes use the harness document lock, and the running adapter reads the grant on the next request. Never commit the grant or include it in a bug report. Renaming `codexRouteId` changes the credential address, so keep the default unless a separate grant is intentional. Set `codexEnabled: false` to disable this route.

## Development and verification

```sh
pnpm run check
pnpm audit --audit-level high
```

`check` runs type checking, 30 source tests, the build, and three integration tests. The plain-Node smoke test mounts both compiled routes in the real Cordis/LLM runtime. Two CLI tests exercise add, repeated add, profile overrides, and remove in disposable web/TUI profiles. The CLI tests use offline package linking through the built harness CLI in `.harness`.

Tests use a local mock gateway or seeded grants. They require no API key, OAuth login, or paid provider requests.

CI builds the pinned harness host packages, then performs the same plugin checks. CI uses read-only permissions and no account credentials. New dependency releases must be at least seven days old. `pnpm-workspace.yaml` limits lifecycle scripts.

A fresh source build of the full harness has additional upstream requirements. The plugin smoke test does not prove a real account can authenticate or a remote provider is available. To verify those, sign in locally and send one message through each configured route.

Before sending a pull request, run the checks and describe the behavior changed. Report security problems privately to the repository maintainer, not in public issues. Remove keys, grants, conversation content, and machine-specific paths from shared logs.
