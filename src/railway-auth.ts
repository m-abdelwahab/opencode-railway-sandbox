export interface RailwayAuth {
  readonly token: string
  readonly authType: "bearer" | "project-token"
  /** Required for bearer tokens; project tokens carry their environment. */
  readonly environmentId?: string
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

async function graphql<T>(token: string, query: string): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
  const response = await fetch(GRAPHQL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
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
export async function resolveEnvironment(token: string, placement: Placement): Promise<{ environmentId: string; describe: string }> {
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
  return { environmentId: environment.id, describe: `${project.name}/${environment.name}` }
}
