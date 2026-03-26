import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Difficulty = "beginner" | "intermediate" | "advanced";
type ScenarioStatus = "draft" | "testing" | "published" | "deprecated";
type ScenarioCommonality = "very_common" | "common" | "occasional" | "rare";

const VALID_DIFFICULTIES = new Set<string>(["beginner", "intermediate", "advanced"]);
const VALID_STATUSES = new Set<string>(["draft", "testing", "published", "deprecated"]);
const VALID_COMMONALITIES = new Set<string>(["very_common", "common", "occasional", "rare"]);
const ASSERTION_LINE_PATTERN = /^(PASS|FAIL):([^:]+):(.+)$/;
const SCORE_LINE_PATTERN = /^SCORE:\d+\/\d+$/;

interface ValidationError {
  scenarioId: string;
  file: string;
  message: string;
}

interface ValidationResult {
  scenarioId: string;
  errors: ValidationError[];
  warnings: ValidationError[];
}

function err(scenarioId: string, file: string, message: string): ValidationError {
  return { scenarioId, file, message };
}

async function validateMetadata(
  scenarioId: string,
  metadataPath: string
): Promise<{ errors: ValidationError[]; warnings: ValidationError[] }> {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  let raw: string;
  try {
    raw = await readFile(metadataPath, "utf8");
  } catch {
    errors.push(err(scenarioId, "metadata.json", "File not found or unreadable"));
    return { errors, warnings };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push(err(scenarioId, "metadata.json", "Invalid JSON"));
    return { errors, warnings };
  }

  // Required string fields
  for (const field of ["id", "title", "description", "objective"] as const) {
    const val = parsed[field];
    if (typeof val !== "string" || val.trim().length === 0) {
      errors.push(err(scenarioId, "metadata.json", `Missing or empty field: ${field}`));
    }
  }

  if (typeof parsed.id === "string" && parsed.id !== scenarioId) {
    errors.push(err(scenarioId, "metadata.json", `id "${parsed.id}" does not match directory name "${scenarioId}"`));
  }

  // Enums
  if (!VALID_DIFFICULTIES.has(parsed.difficulty as string)) {
    errors.push(err(scenarioId, "metadata.json", `Invalid difficulty: ${String(parsed.difficulty)}`));
  }
  if (!VALID_STATUSES.has(parsed.status as string)) {
    errors.push(err(scenarioId, "metadata.json", `Invalid status: ${String(parsed.status)}`));
  }
  if (!VALID_COMMONALITIES.has(parsed.commonality as string)) {
    errors.push(err(scenarioId, "metadata.json", `Invalid commonality: ${String(parsed.commonality)}`));
  }

  // Numbers
  const etm = Number(parsed.estimatedTimeMinutes);
  if (!Number.isFinite(etm) || etm <= 0) {
    errors.push(err(scenarioId, "metadata.json", `Invalid estimatedTimeMinutes: ${String(parsed.estimatedTimeMinutes)}`));
  }
  const tls = Number(parsed.timeLimitSeconds);
  if (!Number.isFinite(tls) || tls < 60) {
    errors.push(err(scenarioId, "metadata.json", `Invalid timeLimitSeconds (min 60): ${String(parsed.timeLimitSeconds)}`));
  }

  // Arrays
  if (parsed.tags !== undefined && !Array.isArray(parsed.tags)) {
    errors.push(err(scenarioId, "metadata.json", "tags must be an array"));
  }
  if (parsed.hints !== undefined && !Array.isArray(parsed.hints)) {
    errors.push(err(scenarioId, "metadata.json", "hints must be an array"));
  }

  // workspace_type
  if (parsed.workspaceType !== undefined && typeof parsed.workspaceType !== "string") {
    errors.push(err(scenarioId, "metadata.json", "workspaceType must be a string"));
  }
  if (typeof parsed.workspaceType === "string" && parsed.workspaceType.trim().length === 0) {
    errors.push(err(scenarioId, "metadata.json", "workspaceType cannot be empty"));
  }

  return { errors, warnings };
}

async function validateBashSyntax(
  scenarioId: string,
  filePath: string,
  fileName: string
): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];

  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    errors.push(err(scenarioId, fileName, "File not found or unreadable"));
    return errors;
  }

  if (content.trim().length === 0) {
    errors.push(err(scenarioId, fileName, "File is empty"));
    return errors;
  }

  // Check shebang
  if (!content.startsWith("#!/")) {
    errors.push(err(scenarioId, fileName, "Missing shebang (expected #!/usr/bin/env bash or similar)"));
  }

  // Bash syntax check
  try {
    await execFileAsync("bash", ["-n", filePath], { timeout: 5000 });
  } catch (e: any) {
    const stderr = e.stderr?.trim() || e.message;
    errors.push(err(scenarioId, fileName, `Bash syntax error: ${stderr}`));
  }

  return errors;
}

function validateEvalScriptContent(
  scenarioId: string,
  content: string
): { errors: ValidationError[]; warnings: ValidationError[] } {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const lines = content.split(/\r?\n/);

  // Check for PASS/FAIL output pattern
  const hasAssertionOutput = lines.some(
    (line) =>
      line.includes('echo "PASS:') ||
      line.includes("echo 'PASS:") ||
      line.includes('echo "FAIL:') ||
      line.includes("echo 'FAIL:") ||
      line.includes("assert_pass") ||
      ASSERTION_LINE_PATTERN.test(line.trim())
  );

  if (!hasAssertionOutput) {
    errors.push(err(scenarioId, "eval.sh", "No PASS:/FAIL: assertion output detected. Evaluator must emit PASS:<check_id>:<explanation> or FAIL:<check_id>:<explanation> lines."));
  }

  // Check for SCORE line
  const hasScoreOutput = lines.some(
    (line) =>
      line.includes('echo "SCORE:') ||
      line.includes("echo 'SCORE:") ||
      line.includes("score()") ||
      SCORE_LINE_PATTERN.test(line.trim())
  );

  if (!hasScoreOutput) {
    warnings.push(err(scenarioId, "eval.sh", "No SCORE: output detected. Evaluator should emit SCORE:<passed>/<total>."));
  }

  // Check it operates on /workspace
  if (!content.includes("/workspace")) {
    warnings.push(err(scenarioId, "eval.sh", "Does not reference /workspace — evaluator should operate on /workspace."));
  }

  return { errors, warnings };
}

function validateSeedScriptContent(
  scenarioId: string,
  content: string
): { errors: ValidationError[]; warnings: ValidationError[] } {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  if (!content.includes("/workspace")) {
    warnings.push(err(scenarioId, "seed.sh", "Does not reference /workspace — seed script should set up /workspace."));
  }

  if (!content.includes("git init") && !content.includes("git clone")) {
    warnings.push(err(scenarioId, "seed.sh", "No git init or git clone found — seed script typically initializes a repo."));
  }

  return { errors, warnings };
}

async function validateScenario(scenarioId: string, scenarioDir: string): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  const metadataPath = resolve(scenarioDir, "metadata.json");
  const seedPath = resolve(scenarioDir, "seed.sh");
  const evalPath = resolve(scenarioDir, "eval.sh");

  // Validate metadata
  const meta = await validateMetadata(scenarioId, metadataPath);
  errors.push(...meta.errors);
  warnings.push(...meta.warnings);

  // Validate seed.sh
  const seedSyntax = await validateBashSyntax(scenarioId, seedPath, "seed.sh");
  errors.push(...seedSyntax);
  if (seedSyntax.length === 0) {
    const seedContent = await readFile(seedPath, "utf8");
    const seedCheck = validateSeedScriptContent(scenarioId, seedContent);
    errors.push(...seedCheck.errors);
    warnings.push(...seedCheck.warnings);
  }

  // Validate eval.sh
  const evalSyntax = await validateBashSyntax(scenarioId, evalPath, "eval.sh");
  errors.push(...evalSyntax);
  if (evalSyntax.length === 0) {
    const evalContent = await readFile(evalPath, "utf8");
    const evalCheck = validateEvalScriptContent(scenarioId, evalContent);
    errors.push(...evalCheck.errors);
    warnings.push(...evalCheck.warnings);
  }

  return { scenarioId, errors, warnings };
}

async function main(): Promise<void> {
  const scenariosRoot = resolve(process.cwd(), "scenarios");
  if (!existsSync(scenariosRoot)) {
    console.error(`Missing scenarios directory: ${scenariosRoot}`);
    process.exit(1);
  }

  const dirEntries = await readdir(scenariosRoot, { withFileTypes: true });
  const scenarioIds = dirEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (scenarioIds.length === 0) {
    console.error("No scenarios found.");
    process.exit(1);
  }

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const scenarioId of scenarioIds) {
    const result = await validateScenario(scenarioId, resolve(scenariosRoot, scenarioId));
    totalErrors += result.errors.length;
    totalWarnings += result.warnings.length;

    if (result.errors.length === 0 && result.warnings.length === 0) {
      console.log(`  ✓ ${scenarioId}`);
      continue;
    }

    if (result.errors.length > 0) {
      console.log(`  ✗ ${scenarioId}`);
    } else {
      console.log(`  ~ ${scenarioId}`);
    }

    for (const e of result.errors) {
      console.log(`    ERROR [${e.file}] ${e.message}`);
    }
    for (const w of result.warnings) {
      console.log(`    WARN  [${w.file}] ${w.message}`);
    }
  }

  console.log(`\n${scenarioIds.length} scenarios, ${totalErrors} errors, ${totalWarnings} warnings`);

  if (totalErrors > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${message}`);
  process.exit(1);
});
