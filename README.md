# gitrung

**gitrung** is an interactive release helper for GitHub and Gitea. Describe a repository’s pull-request and workflow actions in YAML, then run them in a guided order.

A release often means doing the same tedious sequence by hand:

1. Create a PR from a feature branch to `develop`, then wait for it to merge.
2. Wait for the Docker image build.
3. Deploy the image to the test environment.
4. Create a PR from `develop` to `main`, then wait for it to merge.
5. Wait for the Docker image build again.
6. Deploy the image to production.

Doing that manually is boring. gitrung makes the release flow declarative, repeatable, and guided.

| Tool | What it does |
| --- | --- |
| `list-pr` | Lists pull requests, optionally limited to one author. |
| `create-pr` | Creates a pull request and can merge it after checks pass. |
| `merge-pr` | Merges an existing pull request after its checks pass. |
| `run-workflow` | Dispatches a repository workflow on a selected branch. |
| `one-of` | Lets the user pick exactly one of several leaf steps. |

Every step uses a `type` plus an `options` object. Choice groups use `type: one-of` with `items`.

## Full example

```yaml
url: https://github.com/acme/storefront
gitPlatform: github
steps:
  - type: create-pr
    options:
      sourceBranch: feature/catalog
      destinationBranch: develop
      merge: true
      afterMerge:
        waitFor:
          - docker-develop.yaml

  - type: run-workflow
    options:
      workflow: deploy-test.yaml
      useWorkflowFromBranch: develop

  - type: create-pr
    options:
      sourceBranch: develop
      destinationBranch: main
      merge: true
      afterMerge:
        waitFor:
          - docker-main.yaml

  - type: run-workflow
    options:
      workflow: deploy-production.yaml
      useWorkflowFromBranch: main
```

## Start here

1. Download the `.zip` for your platform from the [releases page](https://github.com/md-redwan-hossain/gitrung/releases) (for example `gitrung-windows-x64.zip` or `gitrung-linux-x64.zip`) and extract the binary.
2. Create a folder and place the extracted binary inside it. Create `configs` and `.env` alongside the binary:

```text
gitrung/
├── gitrung                 # macOS/Linux binary (from the zip)
├── gitrung.exe             # Windows binary (from the zip; rename if needed)
├── .env
└── configs/
    └── storefront.yaml
```

3. Copy `configs/my-repo.yaml.example` to `configs/storefront.yaml`, then replace the dummy values.
4. Add the matching token to `.env`:

```sh
# GitHub: repository and workflow access
GITHUB_TOKEN=your_token

# Gitea
GITEA_TOKEN=your_token
```

5. Open a terminal in `gitrung`, then check and run it:

```sh
./gitrung doctor
./gitrung --repo storefront
```

> On Windows, use `.\gitrung.exe` instead of `./gitrung`.

### Run from anywhere

Rename the macOS/Linux binary to `gitrung` (keep the `.exe` extension on Windows), then add the `gitrung` folder to your system `PATH`. You can now run:

```sh
gitrung doctor
gitrung --repo storefront
```

When running outside the `gitrung` folder, either keep a `configs` folder and `.env` in your current directory or explicitly choose the config directory:

```sh
gitrung doctor --config /path/to/gitrung/configs
gitrung --repo storefront --config /path/to/gitrung/configs
```

> A config’s **label is its filename**. `configs/storefront.yaml` is selected with `--repo storefront`; do not add a `label` property.

## Commands

| Command | Why use it | Example |
| --- | --- | --- |
| `gitrung` | Run a repository’s configured release flow. Prompts for a repo when there is more than one. | `gitrung --repo storefront` |
| `gitrung doctor` | Same health checks as a normal run: IO access (configs/`.env` read, metadata/upgrade write) plus parse and validate every config. | `gitrung doctor --config ./configs` |
| `gitrung upgrade` | Check for and install the latest compiled executable. | `gitrung upgrade` |

## Repository properties

| Property | Required | Meaning | Example |
| --- | --- | --- | --- |
| `url` | Yes | Repository URL. | `https://git.example.test/acme/storefront` |
| `gitPlatform` | Yes | API provider: `github` or `gitea`. | `gitea` |
| `steps` | Yes | Ordered actions to run; at least one is required. | An array of step objects. |

## Step tools

Each leaf step looks like:

```yaml
type: <tool-name>
options:
  # tool-specific fields
```

### `list-pr`

Use it to review pull requests before continuing. It can run before all ask-upfront questions, which makes it useful as the first step.

```yaml
type: list-pr
options:
  status: open
  user: alex
  runBeforeAskUpfront: true
```

```mermaid
flowchart TD
    A[Start pipeline] --> B[Fetch PRs by status]
    B --> C{User filter set?}
    C -->|Yes| D[Keep matching author]
    C -->|No| E[Show all fetched PRs]
    D --> F[Show matching PRs]
```

| Property | Required | Meaning |
| --- | --- | --- |
| `type` | Yes | Must be `list-pr`. |
| `options.status` | Yes | PR state: `open`, `closed`, or `all`. |
| `options.user` | No | Show only PRs authored by this login. |
| `options.runBeforeAskUpfront` | No | Run this top-level step before ask-upfront prompts. Defaults to `false`. |

### `create-pr`

Use it to create a PR. With `merge: true`, gitrung schedules the merge after checks pass, waits for it, then can wait for named workflows on the destination branch.

```yaml
type: create-pr
options:
  sourceBranch: staging
  destinationBranch: production
  title: Promote staging to production
  body: Release storefront changes to production.
  merge: true
  afterMerge:
    waitFor:
      - build-production.yaml
```

```mermaid
flowchart TD
    A[Validate source and destination] --> B{Commits ahead?}
    B -->|No| C[Skip: nothing to merge]
    B -->|Yes| D[Create PR]
    D --> E{merge is true?}
    E -->|No| F[Leave PR open]
    E -->|Yes| G[Schedule merge after checks]
    G --> H[Wait for merge and workflows]
```

| Property | Required | Meaning |
| --- | --- | --- |
| `type` | Yes | Must be `create-pr`. |
| `options.sourceBranch` | No | Branch to promote. When omitted, gitrung asks for it. |
| `options.destinationBranch` | Yes | Branch that receives the PR. |
| `options.title` | No | PR title. A descriptive default is generated when omitted. |
| `options.body` | No | PR body. A default is generated when omitted. |
| `options.merge` | Yes | `true` schedules merge after checks; `false` leaves the new PR open. |
| `options.afterMerge` | When `merge` is `true` | Post-merge wait settings; not allowed when `merge` is `false`. |
| `options.afterMerge.waitFor` | Yes with `afterMerge` | Workflow filenames to wait for successfully on the destination branch. An empty list is allowed. |
| `options.askUpfront` | No | Collect this step’s early confirmation/input up front. Defaults to `true`. |
| `options.confirmBeforeRun` | No | Let the user run or skip this action. Defaults to `true`. |

### `merge-pr`

Use it when someone already opened the PR. gitrung asks for the PR number, verifies it is open and mergeable, waits for checks, merges it, and optionally waits for follow-up workflows.

```yaml
type: merge-pr
options:
  when:
    - destinationBranch: staging
      waitFor:
        - build-staging.yaml
```

```mermaid
flowchart TD
    A[Enter PR number] --> B[Validate open and mergeable]
    B --> C[Wait for PR checks]
    C --> D[Merge PR]
    D --> E{Matching when rule?}
    E -->|Yes| F[Wait for named workflows]
    E -->|No| G[Finish]
    F --> G
```

| Property | Required | Meaning |
| --- | --- | --- |
| `type` | Yes | Must be `merge-pr`. |
| `options.when` | No | Rules for post-merge workflow waits. Defaults to `[]`. |
| `options.when[].destinationBranch` | Yes per rule | Apply this rule when the PR targets this branch. |
| `options.when[].waitFor` | Yes per rule | One or more workflow filenames that must succeed after the merge. |

### `run-workflow`

Use it to manually dispatch a workflow file on a branch. If its `workflow_dispatch` definition has inputs, gitrung prompts for them and remembers the most recent values per repository and workflow.

With `when` + `repeat: true`, gitrung collects every input set first (prompt once, then ask whether to add another value for `actionInputId`), then dispatches each set. The full batch is saved to history and can be reused together on the next run. Waiting (`waitUntilFinish`) runs only in that dispatch phase—never between “add another?” prompts.

```yaml
type: run-workflow
options:
  workflow: production-deploy.yaml
  useWorkflowFromBranch: main
  when:
    - actionInputId: client
      repeat: true
```

```mermaid
flowchart TD
    A[Validate branch and workflow file] --> B[Read workflow inputs]
    B --> C[Reuse or enter values]
    C --> D{Add another actionInputId?}
    D -->|Yes| E[Re-prompt that field only]
    E --> D
    D -->|No| F[Dispatch each collected set]
    F --> G{waitUntilFinish?}
    G -->|Yes| H[Wait then next set]
    G -->|No| I[Next set or finish]
    H --> I
```

| Property | Required | Meaning |
| --- | --- | --- |
| `type` | Yes | Must be `run-workflow`. |
| `options.workflow` | Yes | Workflow filename in the platform workflow directory. |
| `options.useWorkflowFromBranch` | Yes | Branch to use the workflow from (and dispatch on), matching the host UI picker. |
| `options.askUpfront` | No | Collect workflow inputs up front instead of at this point in the flow. Defaults to `true`. |
| `options.confirmBeforeRun` | No | Let the user run or skip it. Defaults to `true`. |
| `options.waitUntilFinish` | No | Wait for each dispatched workflow to succeed. Defaults to `true`. |
| `options.exitOnError` | No | Stop the pipeline when dispatch or waiting fails. Defaults to `true`. |
| `options.when[].actionInputId` | With `repeat` | `workflow_dispatch` input id to vary across runs (for example `client`). |
| `options.when[].repeat` | No | When `true`, collect multiple values for that input first, then dispatch once per set. |

### `one-of`

A `one-of` step is not an action itself. It presents its `items` and runs exactly one choice. Use it to offer “create a PR” **or** “merge an existing PR” without executing both.

```yaml
type: one-of
options:
  askUpfront: true
items:
  - type: create-pr
    options:
      sourceBranch: feature/catalog
      destinationBranch: staging
      title: Promote catalog changes to staging
      body: Prepare the catalog release for staging.
      merge: false
  - type: merge-pr
    options:
      when:
        - destinationBranch: staging
          waitFor:
            - build-staging.yaml
```

```mermaid
flowchart TD
    A[Show one-of choices] --> B{User selects one}
    B --> C[Run selected item]
    C --> D[Continue next top-level step]
```

| Property | Required | Meaning |
| --- | --- | --- |
| `type` | Yes | Must be `one-of`. |
| `options.askUpfront` | No | Ask the user to choose the path up front. Defaults to `true`. |
| `items` | Yes | Two or more non-group (`type` + `options`) steps. Nested `one-of` is not supported. |

## Practical rules

- Config files must be `.yaml` or `.yml`.
- Workflow filenames are validated remotely before gitrung uses them.
- `metadata.jsonc` keeps the history from previous runs, including recently used workflow inputs (and full repeat batches), plus source branches.
- A normal run and `doctor` share the same health checks (IO permissions plus config validation); run `doctor` after editing a config to catch problems early.
