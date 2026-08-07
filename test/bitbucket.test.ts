import assert from "node:assert/strict";
import test from "node:test";
import { CoordinatorError } from "../src/core/errors.js";
import {
  listBitbucketCloudRepositories,
  type BitbucketFetch,
  type BitbucketFetchResponse,
} from "../src/hosting/bitbucket.js";

function response(status: number, body: unknown): BitbucketFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function repository(
  name: string,
  options: { description?: string | null; isPrivate?: boolean } = {},
): Record<string, unknown> {
  return {
    description: options.description ?? null,
    full_name: `acme/${name}`,
    is_private: options.isPrivate ?? true,
    links: {
      clone: [
        { href: `https://bitbucket.org/acme/${name}.git`, name: "https" },
        { href: `git@bitbucket.org:acme/${name}.git`, name: "ssh" },
      ],
    },
    name,
  };
}

test("Bitbucket Cloud discovery follows safe pagination and maps SSH repositories", async () => {
  const calls: Array<{
    authorization: string | undefined;
    method: string;
    url: string;
  }> = [];
  const fetch: BitbucketFetch = async (url, options) => {
    calls.push({
      authorization: options.headers.Authorization,
      method: options.method,
      url: url.href,
    });
    if (url.searchParams.get("page") === "2") {
      return response(200, {
        values: [repository("web", { description: "Frontend", isPrivate: false })],
      });
    }
    return response(200, {
      next: "?pagelen=100&sort=name&page=2",
      values: [repository("api", { description: "Backend" })],
    });
  };

  const repositories = await listBitbucketCloudRepositories("acme", {
    authentication: {
      apiToken: " api-token-value ",
      email: " developer@example.com ",
      kind: "basic",
    },
    baseUrl: "https://bitbucket.test/gateway",
    fetch,
  });

  assert.deepEqual(repositories, [
    {
      description: "Backend",
      fullName: "acme/api",
      isPrivate: true,
      name: "api",
      slug: "api",
      sshUrl: "git@bitbucket.org:acme/api.git",
    },
    {
      description: "Frontend",
      fullName: "acme/web",
      isPrivate: false,
      name: "web",
      slug: "web",
      sshUrl: "git@bitbucket.org:acme/web.git",
    },
  ]);
  assert.deepEqual(
    calls.map(({ method, url }) => ({ method, url })),
    [
      {
        method: "GET",
        url: "https://bitbucket.test/gateway/2.0/repositories/acme?pagelen=100&sort=name",
      },
      {
        method: "GET",
        url: "https://bitbucket.test/gateway/2.0/repositories/acme?pagelen=100&sort=name&page=2",
      },
    ],
  );
  assert.equal(
    calls[0]?.authorization,
    `Basic ${Buffer.from("developer@example.com:api-token-value").toString("base64")}`,
  );
  assert.equal(calls[1]?.authorization, calls[0]?.authorization);
});

test("Bitbucket Cloud discovery supports explicit bearer authentication", async () => {
  let authorization = "";
  const repositories = await listBitbucketCloudRepositories("acme", {
    authentication: { kind: "bearer", token: "workspace-access-token" },
    fetch: async (_url, options) => {
      authorization = options.headers.Authorization ?? "";
      return response(200, { values: [repository("api")] });
    },
  });

  assert.equal(authorization, "Bearer workspace-access-token");
  assert.equal(repositories[0]?.fullName, "acme/api");
});

test("Bitbucket Cloud discovery reports 401 and 403 without exposing credentials", async () => {
  const secret = "never-print-this-token";
  for (const [status, code] of [
    [401, "BITBUCKET_AUTHENTICATION_FAILED"],
    [403, "BITBUCKET_ACCESS_DENIED"],
  ] as const) {
    await assert.rejects(
      listBitbucketCloudRepositories("acme", {
        authentication: {
          apiToken: secret,
          email: "developer@example.com",
          kind: "basic",
        },
        fetch: async () => response(status, { error: { message: secret } }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof CoordinatorError);
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
  }
});

test("Bitbucket Cloud discovery rejects invalid JSON and repository shapes", async () => {
  const invalidJson: BitbucketFetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      throw new SyntaxError("secret response contents");
    },
  });
  await assert.rejects(
    listBitbucketCloudRepositories("acme", {
      authentication: { kind: "bearer", token: "secret-token" },
      fetch: invalidJson,
    }),
    (error: unknown) =>
      error instanceof CoordinatorError &&
      error.code === "BITBUCKET_RESPONSE_INVALID" &&
      !error.message.includes("secret"),
  );

  await assert.rejects(
    listBitbucketCloudRepositories("acme", {
      authentication: { kind: "bearer", token: "secret-token" },
      fetch: async () =>
        response(200, {
          values: [
            {
              ...repository("api"),
              links: { clone: [{ href: "https://example.test/api", name: "https" }] },
            },
          ],
        }),
    }),
    (error: unknown) =>
      error instanceof CoordinatorError &&
      error.code === "BITBUCKET_RESPONSE_INVALID" &&
      /SSH clone URL/.test(error.message),
  );

  await assert.rejects(
    listBitbucketCloudRepositories("acme", {
      authentication: { kind: "bearer", token: "secret-token" },
      fetch: async () =>
        response(200, {
          values: [
            {
              ...repository("api"),
              links: {
                clone: [
                  { href: "git@bitbucket.org:attacker/other.git", name: "ssh" },
                ],
              },
            },
          ],
        }),
    }),
    (error: unknown) =>
      error instanceof CoordinatorError &&
      error.code === "BITBUCKET_RESPONSE_INVALID" &&
      /does not match full_name/.test(error.message),
  );
});

test("Bitbucket Cloud discovery refuses cross-origin and cyclic pagination", async () => {
  await assert.rejects(
    listBitbucketCloudRepositories("acme", {
      authentication: { kind: "bearer", token: "secret-token" },
      fetch: async () =>
        response(200, {
          next: "https://attacker.test/steal",
          values: [],
        }),
    }),
    (error: unknown) =>
      error instanceof CoordinatorError &&
      error.code === "BITBUCKET_PAGINATION_UNSAFE",
  );

  let calls = 0;
  await assert.rejects(
    listBitbucketCloudRepositories("acme", {
      authentication: { kind: "bearer", token: "secret-token" },
      fetch: async (url) => {
        calls += 1;
        return response(200, { next: url.href, values: [] });
      },
    }),
    (error: unknown) =>
      error instanceof CoordinatorError &&
      error.code === "BITBUCKET_PAGINATION_UNSAFE",
  );
  assert.equal(calls, 1);
});
