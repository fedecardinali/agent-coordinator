import path from "node:path";
import { z } from "zod";

const identifier = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "use lowercase kebab-case");

const singleLine = z.string().min(1).refine(
  (value) => !/[\r\n]/.test(value),
  "must be a single line",
);

const relativePath = z.string().min(1).refine(
  (value) =>
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..") &&
    value !== ".",
  "must be a safe relative path",
);

const mirrorFallbackSchema = z.object({ mode: z.literal("mirror") });
const fixedFallbackSchema = z.object({
  mode: z.literal("fixed"),
  name: singleLine,
});

export const branchPolicySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("mirror"),
    readOnly: z.boolean().default(false),
  }),
  z.object({
    mode: z.literal("fixed"),
    name: singleLine,
    readOnly: z.boolean().default(true),
  }),
  z.object({
    mode: z.literal("map"),
    branches: z
      .record(singleLine, singleLine)
      .refine(
        (branches) => Object.keys(branches).length > 0,
        "must contain at least one branch mapping",
      ),
    fallback: z
      .union([mirrorFallbackSchema, fixedFallbackSchema])
      .optional(),
    readOnly: z.boolean().default(false),
  }),
]);

const skillExportSchema = z.object({
  source: relativePath,
  name: identifier.optional(),
});

const repositoryAgentSchema = z.object({
  name: identifier.optional(),
  description: z.string().min(1).optional(),
  instructions: z.array(z.string().min(1)).default([]),
  verify: z.array(z.string().min(1)).default([]),
  skills: z.array(skillExportSchema).default([]),
});

export const repositorySchema = z.object({
  id: identifier,
  path: relativePath,
  url: singleLine,
  branch: branchPolicySchema.default({ mode: "mirror", readOnly: false }),
  agent: repositoryAgentSchema.default({
    instructions: [],
    verify: [],
    skills: [],
  }),
});

const agentTools = z.enum(["codex", "claude", "cursor", "opencode"]);

const agentsSchema = z.object({
  manage: z.boolean().optional(),
  tools: z.array(agentTools).min(1).default(["codex"]),
  maxParallel: z.number().int().positive().max(16).default(4),
  skillCollision: z.enum(["namespace", "error"]).default("namespace"),
});

const workflowRunStateSchema = z.object({
  provider: z.literal("workflow-runs"),
});

const githubDeploymentStateSchema = z.object({
  provider: z.literal("github-deployment"),
  environment: singleLine,
});

const deploymentComponentSchema = z
  .object({
    repository: identifier,
    workflow: singleLine,
    state: z.discriminatedUnion("provider", [
      workflowRunStateSchema,
      githubDeploymentStateSchema,
    ]),
    dispatchInputs: z.record(z.string(), z.string()).default({}),
  })
  .strict();

const deploymentEnvironmentSchema = z.object({
  githubEnvironment: singleLine,
  allowedBranches: z.array(singleLine).default([]),
  components: z
    .record(identifier, deploymentComponentSchema)
    .refine(
      (components) => Object.keys(components).length > 0,
      "must contain at least one deployment component",
    ),
});

const deploymentsSchema = z.object({
  tokenSecret: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/, "must be an uppercase GitHub secret name")
    .default("SUBREPO_ACTIONS_TOKEN"),
  environments: z
    .record(identifier, deploymentEnvironmentSchema)
    .refine(
      (environments) => Object.keys(environments).length > 0,
      "must contain at least one deployment environment",
    ),
});

const workspaceManifestSchema = z.object({
  path: relativePath,
  coordinatorToken: z.string().min(1).default("$coordinator"),
  mirrorActiveInLinkedWorktrees: z.boolean().default(false),
});

export const coordinatorManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: identifier,
    remote: z.string().min(1).default("origin"),
    repositories: z.array(repositorySchema).min(1),
    workspaceManifest: workspaceManifestSchema.optional(),
    agents: agentsSchema.default({
      tools: ["codex"],
      maxParallel: 4,
      skillCollision: "namespace",
    }),
    deployments: deploymentsSchema.optional(),
  })
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    const paths = new Set<string>();
    const agentNames = new Set<string>();
    for (const [index, repository] of manifest.repositories.entries()) {
      if (ids.has(repository.id)) {
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "id"],
          message: `duplicate repository id '${repository.id}'`,
        });
      }
      if (paths.has(repository.path)) {
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "path"],
          message: `duplicate repository path '${repository.path}'`,
        });
      }
      const agentName = repository.agent.name ?? repository.id;
      if (agentNames.has(agentName)) {
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "agent", "name"],
          message: `duplicate resolved agent name '${agentName}'`,
        });
      }
      ids.add(repository.id);
      paths.add(repository.path);
      agentNames.add(agentName);
    }

    for (const [environmentName, environment] of Object.entries(
      manifest.deployments?.environments ?? {},
    )) {
      for (const [componentName, component] of Object.entries(
        environment.components,
      )) {
        if (!ids.has(component.repository)) {
          context.addIssue({
            code: "custom",
            path: [
              "deployments",
              "environments",
              environmentName,
              "components",
              componentName,
              "repository",
            ],
            message: `unknown repository '${component.repository}'`,
          });
        }
      }
    }
  });

export type BranchPolicy = z.infer<typeof branchPolicySchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type CoordinatorManifest = z.infer<typeof coordinatorManifestSchema>;
export type AgentTool = CoordinatorManifest["agents"]["tools"][number];
