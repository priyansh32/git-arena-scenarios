# GitArena Scenarios

Challenge scenarios for [GitArena](https://github.com/priyansh32/git-arena) — a terminal-first platform for practicing Git through hands-on challenges.

Each scenario drops you into a broken or incomplete Git repository and asks you to fix it using real Git commands in a sandboxed terminal.

## Scenario Structure

```
scenarios/
└── <scenario-id>/
    ├── metadata.json    # Title, description, difficulty, hints, etc.
    ├── seed.sh          # Sets up the initial repo state in /workspace
    └── eval.sh          # Validates the solution, emits PASS/FAIL assertions
```

### metadata.json

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Must match the directory name |
| `title` | string | Short display title |
| `description` | string | What the user sees before starting |
| `objective` | string | What the user needs to accomplish |
| `difficulty` | `beginner` \| `intermediate` \| `advanced` | |
| `commonality` | `very_common` \| `common` \| `occasional` \| `rare` | How often this comes up in real work |
| `estimatedTimeMinutes` | number | Expected solve time |
| `timeLimitSeconds` | number | Hard time limit (min 60) |
| `tags` | string[] | Categorization tags |
| `hints` | string[] | Progressive hints revealed on request |
| `status` | `draft` \| `testing` \| `published` \| `deprecated` | |
| `workspaceType` | string | Workspace type (default: `git`) |

### seed.sh

Runs inside the workspace container to set up the challenge. Should:
- Work in `/workspace`
- Initialize a Git repo with the problem state
- Be idempotent

### eval.sh

Runs after the user submits. Must output lines in this format:
```
PASS:<check_id>:<explanation>
FAIL:<check_id>:<explanation>
SCORE:<passed>/<total>
```

## Scripts

```bash
# Validate all scenarios (metadata, bash syntax, eval output format)
npm run validate

# Seed scenarios directly into a database
DATABASE_URL="postgres://..." npm run seed

# Generate idempotent SQL for pasting into a DB console
npm run generate-sql -- --out output.sql
```

## Contributing

1. Create a new directory under `scenarios/` with your scenario ID
2. Add `metadata.json`, `seed.sh`, and `eval.sh`
3. Run `npm run validate` to check for errors
4. Open a PR
