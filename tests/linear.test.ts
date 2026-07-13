import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import {
  BLOCKER_CREATE_MUTATION,
  COMMENT_CREATE_MUTATION,
  ISSUE_CREATE_MUTATION,
  ISSUE_QUERY,
  ISSUE_UPDATE_MUTATION,
  LinearClient,
} from "../src/lib/linear-client.js";
import {
  isTokenExpiredOrExpiringSoon,
  refreshLinearToken,
  saveLinearToken,
} from "../src/lib/linear-auth.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("LinearClient", () => {
  it("issue の詳細を Authorization header 付きで取得する", async () => {
    const home = await makeTemporaryHomeWithCredentials();
    const issue = { id: "issue-id", identifier: "DEV-13" };
    const fetchMock = mockFetch({ data: { issue } });
    const client = new LinearClient({ CHIMA_HOME: home }, fetchMock);

    await expect(client.getIssue("DEV-13")).resolves.toEqual(issue);
    expectRequest(fetchMock, ISSUE_QUERY, { id: "DEV-13" });
  });

  it("parentId を含む comment を作成する", async () => {
    const home = await makeTemporaryHomeWithCredentials();
    const result = { success: true, comment: { id: "comment-id" } };
    const fetchMock = mockFetch({ data: { commentCreate: result } });
    const client = new LinearClient({ CHIMA_HOME: home }, fetchMock);

    await expect(
      client.createComment("DEV-13", "確認しました", "parent-id"),
    ).resolves.toEqual(result);
    expectRequest(fetchMock, COMMENT_CREATE_MUTATION, {
      input: {
        issueId: "DEV-13",
        body: "確認しました",
        parentId: "parent-id",
      },
    });
  });

  it("state / assignee / description を更新する", async () => {
    const home = await makeTemporaryHomeWithCredentials();
    const result = { success: true, issue: { id: "issue-id" } };
    const fetchMock = mockFetch({ data: { issueUpdate: result } });
    const client = new LinearClient({ CHIMA_HOME: home }, fetchMock);
    const input = {
      stateId: "state-id",
      assigneeId: "user-id",
      description: "更新後の説明",
    };

    await expect(client.updateIssue("DEV-13", input)).resolves.toEqual(result);
    expectRequest(fetchMock, ISSUE_UPDATE_MUTATION, { id: "DEV-13", input });
  });

  it("issue を作成する", async () => {
    const home = await makeTemporaryHomeWithCredentials();
    const result = { success: true, issue: { id: "new-issue-id" } };
    const fetchMock = mockFetch({ data: { issueCreate: result } });
    const client = new LinearClient({ CHIMA_HOME: home }, fetchMock);
    const input = {
      teamId: "team-id",
      title: "新しいイシュー",
      description: "説明",
    };

    await expect(client.createIssue(input)).resolves.toEqual(result);
    expectRequest(fetchMock, ISSUE_CREATE_MUTATION, { input });
  });

  it("blocker 側から blocks 関係を作成する", async () => {
    const home = await makeTemporaryHomeWithCredentials();
    const result = { success: true, issueRelation: { id: "relation-id" } };
    const fetchMock = mockFetch({ data: { issueRelationCreate: result } });
    const client = new LinearClient({ CHIMA_HOME: home }, fetchMock);

    await expect(client.addBlocker("DEV-13", "DEV-12")).resolves.toEqual(
      result,
    );
    expectRequest(fetchMock, BLOCKER_CREATE_MUTATION, {
      input: {
        issueId: "DEV-12",
        relatedIssueId: "DEV-13",
        type: "blocks",
      },
    });
  });

  it("GraphQL errors 配列の message をまとめて投げる", async () => {
    const home = await makeTemporaryHomeWithCredentials();
    const fetchMock = mockFetch({
      data: { issue: null },
      errors: [{ message: "Issue not found" }, { message: "Access denied" }],
    });
    const client = new LinearClient({ CHIMA_HOME: home }, fetchMock);

    await expect(client.getIssue("DEV-404")).rejects.toThrow(
      "Linear GraphQL API error: Issue not found; Access denied",
    );
  });
});

describe("Linear credentials", () => {
  it("既存フィールドを保持して token を 0600 で保存する", async () => {
    const home = await makeTemporaryHome();
    const credentialsPath = join(home, "config", "credentials.json");
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(
      credentialsPath,
      JSON.stringify({
        client_id: "dummy-client-id",
        client_secret: "dummy-client-secret",
        custom_field: "keep-me",
      }),
      "utf8",
    );

    await saveLinearToken(
      {
        access_token: "dummy-access-token",
        refresh_token: "dummy-refresh-token",
        token_type: "Bearer",
        expires_in: 86_399,
        scope: "read write",
      },
      { CHIMA_HOME: home },
      () => new Date("2026-07-11T02:03:04.000Z"),
    );

    await expect(readFile(credentialsPath, "utf8")).resolves.toBe(
      `${JSON.stringify(
        {
          client_id: "dummy-client-id",
          client_secret: "dummy-client-secret",
          custom_field: "keep-me",
          access_token: "dummy-access-token",
          obtained_at: "2026-07-11T02:03:04.000Z",
          token_type: "Bearer",
          expires_in: 86_399,
          scope: "read write",
          refresh_token: "dummy-refresh-token",
        },
        null,
        2,
      )}\n`,
    );
    expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
  });

  it("obtained_at / expires_in がなければ期限切れ扱いにしない", () => {
    expect(isTokenExpiredOrExpiringSoon({})).toBe(false);
  });

  it("期限内であれば期限切れ扱いにしない", () => {
    const credentials = {
      obtained_at: "2026-07-11T00:00:00.000Z",
      expires_in: 86_400,
    };
    const now = () => new Date("2026-07-11T01:00:00.000Z");
    expect(isTokenExpiredOrExpiringSoon(credentials, now)).toBe(false);
  });

  it("期限切れであれば true を返す", () => {
    const credentials = {
      obtained_at: "2026-07-11T00:00:00.000Z",
      expires_in: 86_400,
    };
    const now = () => new Date("2026-07-12T00:00:01.000Z");
    expect(isTokenExpiredOrExpiringSoon(credentials, now)).toBe(true);
  });

  it("期限間近 (5分未満) であれば true を返す", () => {
    const credentials = {
      obtained_at: "2026-07-11T00:00:00.000Z",
      expires_in: 3600,
    };
    // 3600秒 (1時間) 中、残り4分59秒の時点
    const now = () => new Date("2026-07-11T00:55:01.000Z");
    expect(isTokenExpiredOrExpiringSoon(credentials, now)).toBe(true);
  });

  it("refresh_token で新しい access_token を取得し保存する", async () => {
    const home = await makeTemporaryHome();
    const credentialsPath = join(home, "config", "credentials.json");
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(
      credentialsPath,
      JSON.stringify({
        client_id: "dummy-client-id",
        client_secret: "dummy-client-secret",
        access_token: "old-access-token",
        refresh_token: "dummy-refresh-token",
        obtained_at: "2026-07-11T00:00:00.000Z",
        expires_in: 1,
      }),
      "utf8",
    );

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          token_type: "Bearer",
          expires_in: 86_399,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const credentials = await refreshLinearToken(
      { CHIMA_HOME: home },
      fetchMock,
      () => new Date("2026-07-12T00:00:00.000Z"),
    );

    expect(credentials.access_token).toBe("new-access-token");
    expect(credentials.refresh_token).toBe("new-refresh-token");
    // client_id / client_secret must survive the refresh, since they are
    // needed for any future refresh as well.
    expect(credentials.client_id).toBe("dummy-client-id");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchMock).mock.calls[0]!;
    expect(url).toBe("https://api.linear.app/oauth/token");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("dummy-refresh-token");
  });

  it("refresh_token がなければエラーになる", async () => {
    const home = await makeTemporaryHome();
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(
      join(home, "config", "credentials.json"),
      JSON.stringify({
        client_id: "dummy-client-id",
        client_secret: "dummy-client-secret",
        access_token: "old-access-token",
      }),
      "utf8",
    );

    await expect(
      refreshLinearToken({ CHIMA_HOME: home }, mockFetch({})),
    ).rejects.toThrow("credentials.json に refresh_token がありません");
  });

  it("LinearClient が期限切れの access_token を自動でリフレッシュしてからリクエストする", async () => {
    const home = await makeTemporaryHome();
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(
      join(home, "config", "credentials.json"),
      JSON.stringify({
        client_id: "dummy-client-id",
        client_secret: "dummy-client-secret",
        access_token: "old-access-token",
        refresh_token: "dummy-refresh-token",
        obtained_at: "2026-07-11T00:00:00.000Z",
        expires_in: 1,
      }),
      "utf8",
    );

    const issue = { id: "issue-id", identifier: "DEV-26" };
    let call = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      call += 1;
      if (call === 1) {
        expect(String(url)).toBe("https://api.linear.app/oauth/token");
        return new Response(
          JSON.stringify({
            access_token: "refreshed-access-token",
            expires_in: 86_399,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: { issue } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new LinearClient({ CHIMA_HOME: home }, fetchMock);
    await expect(client.getIssue("DEV-26")).resolves.toEqual(issue);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondInit] = vi.mocked(fetchMock).mock.calls[1]!;
    expect(secondInit).toMatchObject({
      headers: { Authorization: "Bearer refreshed-access-token" },
    });
  });
});

describe("linear CLI", () => {
  it("auth は client_id / client_secret がなければ exit 1 にする", async () => {
    const home = await makeTemporaryHome();
    let stderr = "";

    await expect(
      runCli(
        ["node", "chima", "linear", "auth"],
        { CHIMA_HOME: home },
        {
          stdin: Readable.from([]),
          writeStdout: vi.fn(),
          writeStderr: (value) => {
            stderr += value;
          },
        },
      ),
    ).resolves.toBe(1);
    expect(stderr).toContain(
      "credentials.json に client_id / client_secret が必要です",
    );
  });

  it("issue get の結果を 1 行の JSON で出力する", async () => {
    const home = await makeTemporaryHomeWithCredentials();
    const issue = { id: "issue-id", identifier: "DEV-13" };
    vi.stubGlobal("fetch", mockFetch({ data: { issue } }));
    let stdout = "";

    await expect(
      runCli(
        ["node", "chima", "linear", "issue", "get", "DEV-13"],
        { CHIMA_HOME: home },
        {
          stdin: Readable.from([]),
          writeStdout: (value) => {
            stdout += value;
          },
          writeStderr: vi.fn(),
        },
      ),
    ).resolves.toBe(0);
    expect(stdout).toBe(`${JSON.stringify(issue)}\n`);
  });
});

function mockFetch(payload: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

function expectRequest(
  fetchMock: typeof fetch,
  query: string,
  variables: Record<string, unknown>,
): void {
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = vi.mocked(fetchMock).mock.calls[0]!;
  expect(url).toBe("https://api.linear.app/graphql");
  expect(init).toMatchObject({
    method: "POST",
    headers: {
      Authorization: "Bearer dummy-access-token",
      "Content-Type": "application/json",
    },
  });
  expect(JSON.parse(String(init?.body))).toEqual({ query, variables });
}

async function makeTemporaryHomeWithCredentials(): Promise<string> {
  const home = await makeTemporaryHome();
  await mkdir(join(home, "config"), { recursive: true });
  await writeFile(
    join(home, "config", "credentials.json"),
    JSON.stringify({ access_token: "dummy-access-token" }),
    "utf8",
  );
  return home;
}

async function makeTemporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chima-linear-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
