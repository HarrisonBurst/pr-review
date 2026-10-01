import type {
  ApiError,
  AppState,
  AutomationOverrides,
  AutoSubmissionUpdate,
  AutoSubmissionReenable,
  HumanReviewAcknowledgment,
  DraftEditIntent,
  DockerCapabilityDisclosure,
  DockerExclusion,
  DockerInspectRequest,
  DockerLibraryLeaf,
  DockerLibraryLeafRequest,
  DockerSetupRequest,
  DraftUpdate,
  ExecutionStatus,
  HarnessModelDiscovery,
  HarnessModelDiscoveryRequest,
  HarnessSelectionUpdate,
  HarnessStatus,
  IntegrationTestResult,
  McpOAuthConfigureRequest,
  McpOAuthConnectResult,
  McpOAuthRegistrationRequest,
  McpOAuthReviewReturn,
  McpOAuthReviewReturnRequest,
  McpOAuthScopeApproval,
  McpOAuthScopePreview,
  McpOAuthStatus,
  NativeMcpDiscoveryRequest,
  NativeMcpImportRequest,
  PullRequestDetail,
  QuestionRequest,
  RevisionRequest,
  ReviewJobAction,
  SettingsUpdate,
  IntegrationCatalog,
  Submission,
  SubmissionPreview,
} from "../../../shared/contracts";

export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }

  get conflict() {
    return this.status === 409;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const error = (data ?? {}) as Partial<ApiError>;
    throw new RequestError(response.status, error.error ?? response.statusText, error.code);
  }
  return data as T;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const prPath = (id: string) => `/api/prs/${encodeURIComponent(id)}`;
const oauthPath = (id: string, action: string) =>
  `/api/settings/integrations/${encodeURIComponent(id)}/oauth/${action}`;

export const api = {
  state: () => request<AppState>("/api/state"),
  updateSettings: (update: SettingsUpdate) =>
    request<AppState>("/api/settings", { method: "PATCH", body: JSON.stringify(update) }),
  updateAutoSubmission: (update: AutoSubmissionUpdate) =>
    request<AppState>("/api/settings/auto-submission", {
      method: "PATCH",
      body: JSON.stringify(update),
    }),
  integrations: () => request<IntegrationCatalog>("/api/settings/integrations"),
  updateIntegration: (id: string, update: { enabled?: boolean; allowedTools?: string[] }) =>
    request<IntegrationCatalog>(`/api/settings/integrations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(update),
    }),
  testIntegration: (id: string) =>
    request<IntegrationTestResult>(
      `/api/settings/integrations/${encodeURIComponent(id)}/test`,
      json({}),
    ),
  importReadProviders: (path: string) =>
    request<IntegrationCatalog>("/api/settings/integrations/import-read", json({ path })),
  discoverIntegrations: (body: NativeMcpDiscoveryRequest) =>
    request<IntegrationCatalog>("/api/settings/integrations/discover", json(body)),
  importNativeIntegration: (body: NativeMcpImportRequest) =>
    request<IntegrationCatalog>("/api/settings/integrations/import-native", json(body)),
  loadIntegrationTools: (id: string) =>
    request<IntegrationCatalog>(
      `/api/settings/integrations/${encodeURIComponent(id)}/load-tools`,
      json({}),
    ),
  addOAuthIntegration: (profileId: string) =>
    request<IntegrationCatalog>("/api/settings/integrations/add-oauth", json({ profileId })),
  importOAuthIntegration: (body: { id: string; profileId: string }) =>
    request<IntegrationCatalog>("/api/settings/integrations/import-oauth", json(body)),
  discoverOAuth: (id: string) => request<McpOAuthStatus>(oauthPath(id, "discover"), json({})),
  configureOAuth: (id: string, body: McpOAuthConfigureRequest) =>
    request<McpOAuthStatus>(oauthPath(id, "configure"), json(body)),
  registerOAuth: (id: string, body: McpOAuthRegistrationRequest) =>
    request<McpOAuthStatus>(oauthPath(id, "register"), json(body)),
  connectOAuth: (id: string) => request<McpOAuthConnectResult>(oauthPath(id, "connect"), json({})),
  cancelOAuth: (id: string) => request<McpOAuthStatus>(oauthPath(id, "cancel"), json({})),
  disconnectOAuth: (id: string) => request<McpOAuthStatus>(oauthPath(id, "disconnect"), json({})),
  previewOAuthScopes: (id: string) =>
    request<McpOAuthScopePreview>(oauthPath(id, "scope-preview"), json({})),
  acceptOAuthScopes: (id: string, body: McpOAuthScopeApproval) =>
    request<McpOAuthStatus>(oauthPath(id, "accept-scopes"), json(body)),
  oauthReviewReturn: (body: McpOAuthReviewReturnRequest) =>
    request<McpOAuthReviewReturn>("/api/mcp/oauth/review-return", json(body)),
  harness: () => request<HarnessStatus>("/api/settings/harness"),
  selectHarness: (selection: HarnessSelectionUpdate) =>
    request<HarnessStatus>("/api/settings/harness", {
      method: "PATCH",
      body: JSON.stringify(selection),
    }),
  discoverModels: (body: HarnessModelDiscoveryRequest) =>
    request<HarnessModelDiscovery>("/api/settings/models/discover", json(body)),
  discoverDockerExclusions: () =>
    request<{ exclusions: DockerExclusion[]; nativeSettingsUnchanged: true }>(
      "/api/settings/execution/exclusions",
      json({}),
    ),
  discoverDockerLibraryLeaf: (body: DockerLibraryLeafRequest) =>
    request<DockerLibraryLeaf>("/api/settings/execution/library-leaf", json(body)),
  inspectDocker: (body: DockerInspectRequest) =>
    request<DockerCapabilityDisclosure>("/api/settings/execution/inspect", json(body)),
  setupDocker: (body: DockerSetupRequest) =>
    request<HarnessStatus>("/api/settings/execution/setup", json(body)),
  execution: () => request<ExecutionStatus>("/api/settings/execution"),
  checkExecution: () => request<ExecutionStatus>("/api/settings/execution/check", json({})),
  sync: () => request<AppState>("/api/sync", json({})),
  importPr: (url: string) => request<PullRequestDetail>("/api/prs/import", json({ url })),
  detail: (id: string) => request<PullRequestDetail>(prPath(id)),
  review: (id: string) => request<PullRequestDetail>(`${prPath(id)}/review`, json({})),
  reviewJobAction: (
    id: string,
    jobId: string,
    action: "unqueue" | "cancel",
    body: ReviewJobAction,
  ) =>
    request<PullRequestDetail>(
      `${prPath(id)}/jobs/${encodeURIComponent(jobId)}/${action}`,
      json(body),
    ),
  check: (id: string) => request<PullRequestDetail>(`${prPath(id)}/check`, json({})),
  updateAutomation: (id: string, overrides: Partial<AutomationOverrides>) =>
    request<PullRequestDetail>(`${prPath(id)}/automation`, {
      method: "PATCH",
      body: JSON.stringify(overrides),
    }),
  saveDraft: (id: string, update: DraftUpdate) =>
    request<PullRequestDetail>(`${prPath(id)}/draft`, {
      method: "PUT",
      body: JSON.stringify(update),
    }),
  draftEditIntent: (id: string, intent: DraftEditIntent) =>
    request<PullRequestDetail>(`${prPath(id)}/draft/edit-intent`, json(intent)),
  checkAutoSubmission: (id: string) =>
    request<PullRequestDetail>(`${prPath(id)}/auto-submission/check`, json({})),
  acknowledgeHumanReview: (id: string, body: HumanReviewAcknowledgment) =>
    request<PullRequestDetail>(`${prPath(id)}/auto-submission/acknowledge`, json(body)),
  reenableAutoSubmission: (id: string, body: AutoSubmissionReenable) =>
    request<PullRequestDetail>(`${prPath(id)}/auto-submission/re-enable`, json(body)),
  createDraft: (id: string) => request<PullRequestDetail>(`${prPath(id)}/drafts`, json({})),
  ask: (id: string, body: QuestionRequest) =>
    request<PullRequestDetail>(`${prPath(id)}/questions`, json(body)),
  cancelQuestion: (id: string, questionId: string) =>
    request<PullRequestDetail>(
      `${prPath(id)}/questions/${encodeURIComponent(questionId)}/cancel`,
      json({}),
    ),
  retryQuestion: (id: string, questionId: string) =>
    request<PullRequestDetail>(
      `${prPath(id)}/questions/${encodeURIComponent(questionId)}/retry`,
      json({}),
    ),
  revise: (id: string, body: RevisionRequest) =>
    request<PullRequestDetail>(`${prPath(id)}/revise`, json(body)),
  applyProposal: (id: string, proposalId: string, expectedVersion: number) =>
    request<PullRequestDetail>(
      `${prPath(id)}/proposals/${encodeURIComponent(proposalId)}/apply`,
      json({ expectedVersion }),
    ),
  rejectProposal: (id: string, proposalId: string) =>
    request<PullRequestDetail>(
      `${prPath(id)}/proposals/${encodeURIComponent(proposalId)}/reject`,
      json({}),
    ),
  preview: (id: string, draftId: string, draftVersion: number) =>
    request<SubmissionPreview>(`${prPath(id)}/preview`, json({ draftId, draftVersion })),
  submit: (id: string, previewId: string) =>
    request<Submission>(`${prPath(id)}/submit`, json({ previewId })),
};

export type Api = typeof api;
