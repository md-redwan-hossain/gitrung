import * as p from "@clack/prompts";
import { z, ZodError } from "zod";
import {
  WorkflowDocSchema,
  type WorkflowInputValues,
  type YamlInput,
} from "./schema.ts";

export function parseWorkflowDispatchInputs(
  yamlText: string,
): Record<string, YamlInput> {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(yamlText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse workflow YAML: ${message}`);
  }

  let doc;
  try {
    doc = WorkflowDocSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`Invalid workflow YAML:\n${z.prettifyError(err)}`);
    }
    throw err;
  }

  const on = doc.on;
  if (!on || typeof on === "string" || Array.isArray(on)) {
    return {};
  }
  const dispatch = on.workflow_dispatch;
  if (!dispatch || typeof dispatch !== "object") {
    return {};
  }
  return dispatch.inputs ?? {};
}

export async function promptWorkflowInputs(
  inputDefs: Record<string, YamlInput>,
  defaults?: WorkflowInputValues,
): Promise<WorkflowInputValues> {
  const values: WorkflowInputValues = {};

  for (const [name, def] of Object.entries(inputDefs)) {
    values[name] = await promptSingleWorkflowInput(name, def, {
      initial: defaults?.[name],
    });
  }

  return values;
}

/** Prompt one workflow_dispatch input; optionally exclude already-used choice values. */
export async function promptSingleWorkflowInput(
  name: string,
  def: YamlInput,
  opts?: {
    initial?: string | boolean | number;
    exclude?: ReadonlySet<string>;
  },
): Promise<string | boolean | number> {
  const message = def.description?.trim() || name;
  const initial = opts?.initial !== undefined ? opts.initial : def.default;

  if (def.type === "boolean") {
    const answer = await p.confirm({
      message,
      initialValue: toBoolean(initial, Boolean(def.default)),
    });
    exitIfCancel(answer);
    return answer;
  }

  if (def.type === "choice") {
    const exclude = opts?.exclude;
    const options = (def.options ?? []).filter((opt) => !exclude?.has(opt));
    if (options.length === 0) {
      throw new Error(
        `Workflow input "${name}" has no remaining choice options`,
      );
    }
    const initialOption =
      typeof initial === "string" && options.includes(initial)
        ? initial
        : options[0]!;
    const answer = await p.select({
      message,
      options: options.map((opt) => ({ value: opt, label: opt })),
      initialValue: initialOption,
    });
    exitIfCancel(answer);
    return answer;
  }

  const answer = await p.text({
    message,
    initialValue:
      initial === undefined || initial === null ? "" : String(initial),
    validate: (v) => {
      if (def.required && !v?.trim()) return "Required";
    },
  });
  exitIfCancel(answer);
  return answer;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function exitIfCancel(value: unknown): asserts value is string | boolean {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(1);
  }
}
