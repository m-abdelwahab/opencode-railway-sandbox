export interface RailwayAuth {
  readonly token: string
  readonly authType: "bearer" | "project-token"
  /** Required for bearer tokens; project tokens carry their environment. */
  readonly environmentId?: string
  /** Known for project tokens and discovered placements; needed to list services for variable references. */
  readonly projectId?: string
  readonly describe: string
}

export interface Placement {
  /** Project name or ID. */
  readonly project?: string
  /** Environment name or ID. Defaults to "production". */
  readonly environment?: string
  readonly environmentId?: string
}

export class SetupError extends Error {}

interface ProjectNode {
  readonly id: string
  readonly name: string
  readonly deletedAt: string | null
  readonly environments: { readonly edges: ReadonlyArray<{ readonly node: { readonly id: string; readonly name: string } }> }
}

const GRAPHQL = "https://backboard.railway.com/graphql/v2"

const PROJECT_FIELDS = "id name deletedAt environments { edges { node { id name } } }"

async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
  authType: RailwayAuth["authType"] = "bearer",
): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
  const response = await fetch(GRAPHQL, {
    method: "POST",
    headers: {
      ...(authType === "project-token" ? { "project-access-token": token } : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  })
  return (await response.json()) as { data?: T; errors?: Array<{ message: string }> }
}

/**
 * Lists projects the token can use. OAuth tokens with project scopes only see the projects the user shared on the
 * consent screen, through `externalWorkspaces`; account and workspace tokens use `me.workspaces`.
 */
async function projects(token: string): Promise<ProjectNode[]> {
  const external = await graphql<{ externalWorkspaces: Array<{ projects: ProjectNode[] }> }>(
    token,
    `query { externalWorkspaces { projects { ${PROJECT_FIELDS} } } }`,
  )
  const shared = external.data?.externalWorkspaces.flatMap((workspace) => workspace.projects) ?? []
  if (shared.length > 0) return shared.filter((project) => !project.deletedAt)
  const owned = await graphql<{ me: { workspaces: Array<{ projects: { edges: Array<{ node: ProjectNode }> } }> } }>(
    token,
    `query { me { workspaces { projects { edges { node { ${PROJECT_FIELDS} } } } } } }`,
  )
  if (owned.data)
    return owned.data.me.workspaces.flatMap((workspace) => workspace.projects.edges.map((edge) => edge.node)).filter((p) => !p.deletedAt)
  if (external.data) return []
  throw new SetupError(
    `Railway is connected, but the credential cannot list projects (${[...(external.errors ?? []), ...(owned.errors ?? [])].map((error) => error.message).join("; ")}). ` +
      `Set the plugin's "environmentId" option, or reconnect Railway and share a project on the consent screen.`,
  )
}

/** Picks the environment for a bearer (OAuth or account) token from plugin options or what the token can access. */
export async function resolveEnvironment(
  token: string,
  placement: Placement,
): Promise<{ environmentId: string; projectId?: string; describe: string }> {
  if (placement.environmentId) return { environmentId: placement.environmentId, describe: `environment ${placement.environmentId}` }
  const available = await projects(token)
  const candidates = placement.project
    ? available.filter((project) => project.id === placement.project || project.name === placement.project)
    : available
  if (candidates.length === 0)
    throw new SetupError(
      placement.project
        ? `Railway project "${placement.project}" is not accessible with the connected Railway account.`
        : "Railway is connected, but no projects were shared with OpenCode. Reconnect Railway (`/connect` → Railway) and pick at least one project on the consent screen.",
    )
  if (candidates.length > 1)
    throw new SetupError(
      `The connected Railway account can access several projects (${candidates.map((p) => p.name).join(", ")}). ` +
        `Set the "project" option for the opencode-railway-computer plugin in opencode.json to choose one.`,
    )
  const project = candidates[0]!
  const wanted = placement.environment ?? "production"
  const environment = project.environments.edges
    .map((edge) => edge.node)
    .find((env) => env.id === wanted || env.name === wanted)
  if (!environment) throw new SetupError(`Railway project "${project.name}" has no environment "${wanted}".`)
  return { environmentId: environment.id, projectId: project.id, describe: `${project.name}/${environment.name}` }
}

/** Fills in the project (and environment) a project token is scoped to. */
export async function projectTokenScope(token: string): Promise<{ projectId: string; environmentId: string } | undefined> {
  const result = await graphql<{ projectToken: { projectId: string; environmentId: string } }>(
    token,
    "query { projectToken { projectId environmentId } }",
    {},
    "project-token",
  )
  return result.data?.projectToken
}

export interface ServiceVariables {
  readonly service: string
  /** Variable names only; values are never read back to the agent. */
  readonly names: readonly string[]
}

/**
 * Lists the environment's services and shared variables with their variable names, so an agent can write Railway
 * references such as `${{Postgres.DATABASE_URL}}` without ever seeing a secret value.
 */
export async function listVariables(auth: RailwayAuth): Promise<{ services: ServiceVariables[]; shared: readonly string[] }> {
  if (!auth.projectId || !auth.environmentId)
    throw new SetupError("Listing services needs a Railway project and environment; set the plugin's \"project\" option.")
  const services = await graphql<{ project: { services: { edges: Array<{ node: { id: string; name: string } }> } } }>(
    auth.token,
    "query($id: String!) { project(id: $id) { services { edges { node { id name } } } } }",
    { id: auth.projectId },
    auth.authType,
  )
  if (!services.data) throw new Error(`Railway API error: ${services.errors?.map((error) => error.message).join("; ")}`)
  const names = async (serviceId?: string) => {
    const result = await graphql<{ variables: Record<string, string> }>(
      auth.token,
      "query($projectId: String!, $environmentId: String!, $serviceId: String) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }",
      { projectId: auth.projectId, environmentId: auth.environmentId, serviceId },
      auth.authType,
    )
    return Object.keys(result.data?.variables ?? {})
      .filter((name) => !name.startsWith("RAILWAY_") || /PRIVATE_DOMAIN|PUBLIC_DOMAIN|TCP_PROXY/.test(name))
      .sort()
  }
  return {
    services: await Promise.all(
      services.data.project.services.edges.map(async ({ node }) => ({ service: node.name, names: await names(node.id) })),
    ),
    shared: await names(),
  }
}
