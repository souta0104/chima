import { readJsonFile } from "./state.js";
import {
  type FetchImplementation,
  getCredentialsPath,
  isTokenExpiredOrExpiringSoon,
  type LinearCredentials,
  refreshLinearToken,
} from "./linear-auth.js";

const GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

// Linear API が応答しない場合に tick 全体を無期限に止めないための上限。
const REQUEST_TIMEOUT_MS = 30_000;

export const ISSUE_QUERY = `
  query Issue($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      state { id name type }
      assignee { id name }
      children(first: 50) {
        nodes {
          id
          identifier
          title
          description
          state { id name type }
          assignee { id name }
        }
      }
      relations(first: 50) {
        nodes {
          id
          type
          issue { id identifier title }
          relatedIssue { id identifier title }
        }
      }
      inverseRelations(first: 50) {
        nodes {
          id
          type
          issue { id identifier title }
          relatedIssue { id identifier title }
        }
      }
      comments(first: 50) {
        nodes {
          id
          body
          parentId
          url
          createdAt
          updatedAt
          user { id name }
          botActor { id name type }
        }
      }
    }
  }
`;

export const COMMENT_CREATE_MUTATION = `
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id body parentId url createdAt }
    }
  }
`;

export const ISSUE_UPDATE_MUTATION = `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        id
        identifier
        title
        description
        state { id name type }
        assignee { id name }
      }
    }
  }
`;

export const ISSUE_CREATE_MUTATION = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier title description url }
    }
  }
`;

export const BLOCKER_CREATE_MUTATION = `
  mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) {
      success
      issueRelation {
        id
        type
        issue { id identifier }
        relatedIssue { id identifier }
      }
    }
  }
`;

interface GraphqlError {
  message?: unknown;
  path?: unknown;
  extensions?: unknown;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: GraphqlError[];
}

export interface IssueUpdateInput {
  stateId?: string;
  assigneeId?: string;
  description?: string;
}

export interface IssueCreateInput {
  title: string;
  teamId: string;
  description?: string;
}

export class LinearClient {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  async request<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const accessToken = await this.getAccessToken();

    const response = await this.fetchImplementation(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    let payload: GraphqlResponse<T>;
    try {
      payload = (await response.json()) as GraphqlResponse<T>;
    } catch {
      throw new Error(
        `Linear GraphQL API が JSON ではない応答を返しました (HTTP ${response.status})`,
      );
    }

    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const messages = payload.errors.map((error) =>
        typeof error.message === "string" ? error.message : "不明な GraphQL エラー",
      );
      throw new Error(`Linear GraphQL API error: ${messages.join("; ")}`);
    }

    if (!response.ok) {
      throw new Error(`Linear GraphQL API request failed: HTTP ${response.status}`);
    }

    if (payload.data === undefined) {
      throw new Error("Linear GraphQL API response に data がありません");
    }

    return payload.data;
  }

  private async getAccessToken(): Promise<string> {
    const credentialsPath = getCredentialsPath(this.env);
    let credentials = await readJsonFile<LinearCredentials>(credentialsPath);

    if (credentials === null) {
      throw new Error(
        "credentials.json に access_token がありません。chima linear auth を実行してください",
      );
    }

    if (isTokenExpiredOrExpiringSoon(credentials)) {
      credentials = await refreshLinearToken(this.env, this.fetchImplementation);
    }

    const accessToken = credentials.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new Error(
        "credentials.json に access_token がありません。chima linear auth を実行してください",
      );
    }

    return accessToken;
  }

  async getIssue(id: string): Promise<unknown> {
    const data = await this.request<{ issue: unknown }>(ISSUE_QUERY, { id });
    return data.issue;
  }

  async createComment(
    issueId: string,
    body: string,
    parentId?: string,
  ): Promise<unknown> {
    const input: Record<string, string> = { issueId, body };
    if (parentId !== undefined) {
      input.parentId = parentId;
    }

    const data = await this.request<{ commentCreate: unknown }>(
      COMMENT_CREATE_MUTATION,
      { input },
    );
    return data.commentCreate;
  }

  async updateIssue(id: string, input: IssueUpdateInput): Promise<unknown> {
    const data = await this.request<{ issueUpdate: unknown }>(
      ISSUE_UPDATE_MUTATION,
      { id, input },
    );
    return data.issueUpdate;
  }

  async createIssue(input: IssueCreateInput): Promise<unknown> {
    const data = await this.request<{ issueCreate: unknown }>(
      ISSUE_CREATE_MUTATION,
      { input },
    );
    return data.issueCreate;
  }

  async addBlocker(issueId: string, blockerIssueId: string): Promise<unknown> {
    const data = await this.request<{ issueRelationCreate: unknown }>(
      BLOCKER_CREATE_MUTATION,
      {
        input: {
          issueId: blockerIssueId,
          relatedIssueId: issueId,
          type: "blocks",
        },
      },
    );
    return data.issueRelationCreate;
  }
}
