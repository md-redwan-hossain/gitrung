import { z } from "zod";

export const PrStatusSchema = z.enum(["open", "closed", "all"]);
export const GitPlatformSchema = z.enum(["gitea", "github"]);

export const CreatePrAfterMergeSchema = z.object({
  // empty array allowed = no post-merge workflow waits
  waitFor: z.array(z.string().min(1)),
});

const CreatePrOptionsShared = {
  sourceBranch: z.string().min(1).optional(),
  destinationBranch: z.string().min(1),
  title: z.string().optional(),
  body: z.string().optional(),
  askUpfront: z.boolean().default(true),
  confirmBeforeRun: z.boolean().default(true),
};

/** merge:true requires afterMerge; merge:false forbids it. */
export const CreatePrOptionsSchema = z.discriminatedUnion("merge", [
  z.object({
    ...CreatePrOptionsShared,
    merge: z.literal(true),
    afterMerge: CreatePrAfterMergeSchema,
  }),
  z.object({
    ...CreatePrOptionsShared,
    merge: z.literal(false),
  }),
]);

export const CreatePrStepSchema = z
  .object({
    type: z.literal("create-pr"),
    options: CreatePrOptionsSchema,
  })
  .transform(({ type, options }) => ({ type, ...options }));

export const RunWorkflowWhenSchema = z.object({
  actionInputId: z.string().min(1),
  repeat: z.boolean(),
});

export const RunWorkflowOptionsSchema = z.object({
  workflow: z.string().min(1),
  useWorkflowFromBranch: z.string().min(1),
  askUpfront: z.boolean().default(true),
  confirmBeforeRun: z.boolean().default(true),
  waitUntilFinish: z.boolean().default(true),
  exitOnError: z.boolean().default(true),
  when: z.array(RunWorkflowWhenSchema).default([]),
});

export const RunWorkflowStepSchema = z
  .object({
    type: z.literal("run-workflow"),
    options: RunWorkflowOptionsSchema,
  })
  .transform(({ type, options }) => ({ type, ...options }));

export const ListPrOptionsSchema = z.object({
  status: PrStatusSchema,
  user: z.string().optional(),
  /** Run before ask-upfront prompts; skipped in the main step loop. */
  runBeforeAskUpfront: z.boolean().default(false),
});

export const ListPrStepSchema = z
  .object({
    type: z.literal("list-pr"),
    options: ListPrOptionsSchema,
  })
  .transform(({ type, options }) => ({ type, ...options }));

export const MergePrWhenSchema = z.object({
  destinationBranch: z.string().min(1),
  waitFor: z.array(z.string().min(1)).min(1),
});

export const MergePrOptionsSchema = z.object({
  when: z.array(MergePrWhenSchema).default([]),
});

export const MergePrStepSchema = z
  .object({
    type: z.literal("merge-pr"),
    options: MergePrOptionsSchema,
  })
  .transform(({ type, options }) => ({ type, ...options }));

/** Flat executable steps after envelope transform (no nesting). */
export const LeafStepSchema = z.union([
  CreatePrStepSchema,
  RunWorkflowStepSchema,
  ListPrStepSchema,
  MergePrStepSchema,
]);

export const OneOfOptionsSchema = z.object({
  askUpfront: z.boolean().default(true),
});

/** One-level exclusive choice: steps → items only. */
export const StepGroupSchema = z
  .object({
    type: z.literal("one-of"),
    options: OneOfOptionsSchema.default({ askUpfront: true }),
    items: z.array(LeafStepSchema).min(2),
  })
  .transform(({ type, options, items }) => ({
    type,
    askUpfront: options.askUpfront,
    items,
  }));

export const PipelineStepSchema = z.union([LeafStepSchema, StepGroupSchema]);

/** On-disk repo file shape (label comes from the filename). */
export const RepoFileSchema = z.object({
  url: z.url(),
  gitPlatform: GitPlatformSchema,
  steps: z.array(PipelineStepSchema).min(1),
});

export type RepoFile = z.infer<typeof RepoFileSchema>;

/** In-memory repo config after label is injected from the filename stem. */
export type RepoConfig = RepoFile & { label: string };

export type AppConfig = RepoConfig[];

export const WorkflowInputValuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.boolean(), z.number()]),
);

export const WorkflowHistoryEntrySchema = z.object({
  name: z.string(),
  lastUsed: z.array(WorkflowInputValuesSchema),
  /** Last multi-set collect for a repeat run-workflow (full batch to reuse). */
  lastBatch: z.array(WorkflowInputValuesSchema).optional(),
});

export const HistoryFileSchema = z.object({
  workflowLogs: z
    .record(z.string(), z.array(WorkflowHistoryEntrySchema))
    .default({}),
  sourceBranches: z.record(z.string(), z.string().min(1)).default({}),
});

export const YamlInputSchema = z.looseObject({
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.boolean(), z.number()]).optional(),
  type: z.string().optional(),
  options: z.array(z.string()).optional(),
});

export const WorkflowDocSchema = z.looseObject({
  on: z
    .union([
      z.string(),
      z.array(z.string()),
      z.looseObject({
        workflow_dispatch: z
          .looseObject({
            inputs: z.record(z.string(), YamlInputSchema).optional(),
          })
          .nullable()
          .optional(),
      }),
    ])
    .optional(),
});

export const PullRequestSchema = z.looseObject({
  number: z.number(),
  html_url: z.string(),
  mergeable: z.boolean().nullable().optional().default(null),
  merged: z.boolean().optional().default(false),
  merged_at: z.string().nullable().optional(),
  title: z.string(),
  state: z.string(),
  user: z
    .looseObject({
      login: z.string(),
      full_name: z.string().optional(),
    })
    .optional(),
  base: z.looseObject({ ref: z.string() }).optional(),
  head: z
    .looseObject({
      ref: z.string().optional(),
      sha: z.string().optional(),
    })
    .optional(),
  node_id: z.string().optional(),
});

export const PullRequestListSchema = z.array(PullRequestSchema);

export const ContentFileSchema = z.looseObject({
  content: z.string(),
  encoding: z.string(),
  name: z.string(),
  path: z.string(),
});

export const CompareResultSchema = z.looseObject({
  total_commits: z.number().optional(),
  ahead_by: z.number().optional(),
  commits: z.array(z.unknown()).optional(),
});

export const CommitStatusSchema = z.looseObject({
  state: z.string(),
  total_count: z.number().optional().default(0),
});

export const LooseObjectSchema = z.record(z.string(), z.unknown());

export const WorkflowRunsResponseSchema = z.union([
  z.array(z.unknown()),
  z.looseObject({
    workflow_runs: z.array(z.unknown()).optional(),
    runs: z.array(z.unknown()).optional(),
    data: z.array(z.unknown()).optional(),
  }),
]);

export const WorkflowRunSchema = z.object({
  id: z.number(),
  /** UI-facing run number when the host provides it (GitHub run_number / Gitea number). */
  run_number: z.number().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  event: z.string().optional(),
  html_url: z.string().optional(),
  created_at: z.string().optional(),
  run_started_at: z.string().optional(),
  updated_at: z.string().optional(),
  head_branch: z.string().optional(),
  display_title: z.string().optional(),
});

export const GraphqlEnvelopeSchema = z.looseObject({
  data: z.unknown().optional(),
  errors: z.array(z.looseObject({ message: z.string() })).optional(),
});

export const EnableAutoMergeDataSchema = z.looseObject({
  enablePullRequestAutoMerge: z
    .looseObject({
      pullRequest: z
        .looseObject({
          autoMergeRequest: z
            .looseObject({
              enabledAt: z.string().optional(),
            })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});

export type PrStatus = z.infer<typeof PrStatusSchema>;
export type GitPlatform = z.infer<typeof GitPlatformSchema>;
export type CreatePrAfterMerge = z.infer<typeof CreatePrAfterMergeSchema>;
export type CreatePrStep = z.infer<typeof CreatePrStepSchema>;
export type RunWorkflowWhen = z.infer<typeof RunWorkflowWhenSchema>;
export type RunWorkflowStep = z.infer<typeof RunWorkflowStepSchema>;
export type ListPrStep = z.infer<typeof ListPrStepSchema>;
export type MergePrWhen = z.infer<typeof MergePrWhenSchema>;
export type MergePrStep = z.infer<typeof MergePrStepSchema>;
export type LeafStep = z.infer<typeof LeafStepSchema>;
export type StepGroup = z.infer<typeof StepGroupSchema>;
export type PipelineStep = z.infer<typeof PipelineStepSchema>;
export type WorkflowInputValues = z.infer<typeof WorkflowInputValuesSchema>;
export type WorkflowHistoryEntry = z.infer<typeof WorkflowHistoryEntrySchema>;
export type HistoryFile = z.infer<typeof HistoryFileSchema>;
export type YamlInput = z.infer<typeof YamlInputSchema>;
export type PullRequest = z.infer<typeof PullRequestSchema>;
export type ContentFile = z.infer<typeof ContentFileSchema>;
export type CompareResult = z.infer<typeof CompareResultSchema>;
export type CommitStatus = z.infer<typeof CommitStatusSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export type ParsedRepo = {
  apiBase: string;
  owner: string;
  repo: string;
  url: string;
  gitPlatform: GitPlatform;
};

/** Composite step key → ask-upfront workflow input set(s) (length > 1 when when[].repeat) */
export type AskUpfrontInputMap = Map<string, WorkflowInputValues[]>;

/** First when entry with repeat:true, else undefined. */
export function repeatActionInputId(step: RunWorkflowStep): string | undefined {
  return step.when.find((w) => w.repeat)?.actionInputId;
}

/** Composite step key → resolved create-pr source branch for this run */
export type SourceBranchMap = Map<string, string>;

/** Top-level step indices skipped by confirmBeforeRun (ask-upfront phase) */
export type SkippedStepSet = Set<number>;

/** Top-level group index → chosen item index */
export type SelectedSubStepMap = Map<number, number>;

/** Composite step key → precollected merge-pr number */
export type MergePrNumberMap = Map<string, number>;

export function isStepGroup(step: PipelineStep): step is StepGroup {
  return step.type === "one-of";
}

export function stepKey(stepIndex: number, subIndex?: number): string {
  return subIndex === undefined
    ? String(stepIndex)
    : `${stepIndex}:${subIndex}`;
}
