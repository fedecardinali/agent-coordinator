import { Buffer } from "node:buffer";
import { CoordinatorError } from "../core/errors.js";
import { parseRepositoryIdentity } from "../core/repository-url.js";

const DEFAULT_BASE_URL = "https://api.bitbucket.org";
const MAXIMUM_PAGES = 1_000;

export interface BitbucketCloudRepository {
  description: string | null;
  fullName: string;
  isPrivate: boolean;
  name: string;
  slug: string;
  sshUrl: string;
}

export type BitbucketCloudAuthentication =
  | {
      apiToken: string;
      email: string;
      kind: "basic";
    }
  | {
      kind: "bearer";
      token: string;
    };

export interface BitbucketFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface BitbucketFetchOptions {
  headers: Record<string, string>;
  method: "GET";
  signal?: AbortSignal | undefined;
}

export type BitbucketFetch = (
  url: URL,
  options: BitbucketFetchOptions,
) => Promise<BitbucketFetchResponse>;

export interface ListBitbucketCloudRepositoriesOptions {
  authentication: BitbucketCloudAuthentication;
  baseUrl?: string | URL | undefined;
  fetch?: BitbucketFetch | undefined;
  signal?: AbortSignal | undefined;
}

interface BitbucketPage {
  next: string | null;
  repositories: BitbucketCloudRepository[];
}

function nonEmptySingleLine(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new CoordinatorError(
      `${label} must be a non-empty single line.`,
      "BITBUCKET_CONFIGURATION_INVALID",
    );
  }
  return normalized;
}

function authorizationHeader(
  authentication: BitbucketCloudAuthentication,
): string {
  if (authentication.kind === "basic") {
    const email = nonEmptySingleLine(
      authentication.email,
      "Bitbucket Cloud email",
    );
    const token = nonEmptySingleLine(
      authentication.apiToken,
      "Bitbucket Cloud API token",
    );
    return `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;
  }
  return `Bearer ${nonEmptySingleLine(authentication.token, "Bitbucket Cloud bearer token")}`;
}

function normalizedBaseUrl(input: string | URL | undefined): URL {
  let result: URL;
  try {
    result = new URL(input?.toString() ?? DEFAULT_BASE_URL);
  } catch {
    throw new CoordinatorError(
      "Bitbucket Cloud API base URL is invalid.",
      "BITBUCKET_CONFIGURATION_INVALID",
    );
  }
  if (
    result.protocol !== "https:" ||
    result.username ||
    result.password ||
    result.search ||
    result.hash
  ) {
    throw new CoordinatorError(
      "Bitbucket Cloud API base URL must be an HTTPS URL without credentials, query parameters, or a fragment.",
      "BITBUCKET_CONFIGURATION_INVALID",
    );
  }
  result.pathname = `${result.pathname.replace(/\/+$/, "")}/`;
  return result;
}

function initialPageUrl(baseUrl: URL, workspace: string): URL {
  const url = new URL(
    `2.0/repositories/${encodeURIComponent(workspace)}`,
    baseUrl,
  );
  url.searchParams.set("pagelen", "100");
  url.searchParams.set("sort", "name");
  return url;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalidResponse(detail: string): CoordinatorError {
  return new CoordinatorError(
    `Bitbucket Cloud returned an invalid repository response: ${detail}.`,
    "BITBUCKET_RESPONSE_INVALID",
  );
}

function repositoryFromApi(
  value: unknown,
  index: number,
): BitbucketCloudRepository {
  const label = `repository entry ${index + 1}`;
  const repository = objectValue(value);
  if (!repository) throw invalidResponse(`${label} is not an object`);
  const { description, full_name: fullName, is_private: isPrivate, name } =
    repository;
  if (typeof name !== "string" || !name) {
    throw invalidResponse(`${label} has no name`);
  }
  if (typeof fullName !== "string" || !fullName) {
    throw invalidResponse(`${label} has no full_name`);
  }
  if (description !== null && typeof description !== "string") {
    throw invalidResponse(`${label} has an invalid description`);
  }
  if (typeof isPrivate !== "boolean") {
    throw invalidResponse(`${label} has no is_private flag`);
  }

  const links = objectValue(repository.links);
  const clones = links?.clone;
  if (!Array.isArray(clones)) {
    throw invalidResponse(`${label} has no clone links`);
  }
  const sshClone = clones
    .map((clone) => objectValue(clone))
    .find((clone) => clone?.name === "ssh");
  if (!sshClone || typeof sshClone.href !== "string" || !sshClone.href) {
    throw invalidResponse(`${label} has no SSH clone URL`);
  }
  if (/[\r\n]/.test(sshClone.href)) {
    throw invalidResponse(`${label} has an invalid SSH clone URL`);
  }
  const expectedIdentity = parseRepositoryIdentity(`bitbucket:${fullName}`);
  const cloneIdentity = parseRepositoryIdentity(sshClone.href);
  if (
    !expectedIdentity ||
    cloneIdentity?.provider !== "bitbucket" ||
    cloneIdentity.namespace !== expectedIdentity.namespace ||
    cloneIdentity.repository !== expectedIdentity.repository
  ) {
    throw invalidResponse(`${label} has an SSH clone URL that does not match full_name`);
  }

  return {
    description,
    fullName,
    isPrivate,
    name,
    slug: expectedIdentity.repository,
    sshUrl: sshClone.href,
  };
}

function pageFromApi(value: unknown): BitbucketPage {
  const page = objectValue(value);
  if (!page || !Array.isArray(page.values)) {
    throw invalidResponse("the page has no values array");
  }
  if (
    page.next !== undefined &&
    page.next !== null &&
    typeof page.next !== "string"
  ) {
    throw invalidResponse("the page has an invalid next link");
  }
  return {
    next: typeof page.next === "string" ? page.next : null,
    repositories: page.values.map(repositoryFromApi),
  };
}

function safeNextPageUrl(
  value: string,
  currentUrl: URL,
  collectionUrl: URL,
): URL {
  let next: URL;
  try {
    next = new URL(value, currentUrl);
  } catch {
    throw invalidResponse("the page has an invalid next link");
  }
  if (
    next.protocol !== "https:" ||
    next.origin !== collectionUrl.origin ||
    next.pathname !== collectionUrl.pathname ||
    next.username ||
    next.password ||
    next.hash
  ) {
    throw new CoordinatorError(
      "Bitbucket Cloud returned an unsafe pagination link.",
      "BITBUCKET_PAGINATION_UNSAFE",
    );
  }
  return next;
}

function httpError(status: number, workspace: string): CoordinatorError {
  if (status === 401) {
    return new CoordinatorError(
      `Bitbucket Cloud authentication failed while listing workspace '${workspace}'.`,
      "BITBUCKET_AUTHENTICATION_FAILED",
    );
  }
  if (status === 403) {
    return new CoordinatorError(
      `Bitbucket Cloud denied access to workspace '${workspace}'.`,
      "BITBUCKET_ACCESS_DENIED",
    );
  }
  return new CoordinatorError(
    `Bitbucket Cloud could not list workspace '${workspace}' (HTTP ${status}).`,
    "BITBUCKET_REQUEST_FAILED",
  );
}

export async function listBitbucketCloudRepositories(
  workspaceInput: string,
  options: ListBitbucketCloudRepositoriesOptions,
): Promise<BitbucketCloudRepository[]> {
  const workspace = workspaceInput.trim();
  if (!workspace || /[\r\n]/.test(workspace)) {
    throw new CoordinatorError(
      "Bitbucket Cloud workspace must be a non-empty single line.",
      "BITBUCKET_CONFIGURATION_INVALID",
    );
  }
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const collectionUrl = initialPageUrl(baseUrl, workspace);
  const authorization = authorizationHeader(options.authentication);
  const fetchPage: BitbucketFetch =
    options.fetch ??
    ((url, fetchOptions) =>
      globalThis.fetch(url, {
        headers: fetchOptions.headers,
        method: fetchOptions.method,
        ...(fetchOptions.signal ? { signal: fetchOptions.signal } : {}),
      }));
  const headers = {
    Accept: "application/json",
    Authorization: authorization,
  };
  const fetchOptions: BitbucketFetchOptions = {
    headers,
    method: "GET",
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const repositories: BitbucketCloudRepository[] = [];
  const visited = new Set<string>();
  let currentUrl: URL | null = collectionUrl;

  while (currentUrl) {
    if (visited.size >= MAXIMUM_PAGES || visited.has(currentUrl.href)) {
      throw new CoordinatorError(
        "Bitbucket Cloud returned cyclic or excessive pagination.",
        "BITBUCKET_PAGINATION_UNSAFE",
      );
    }
    visited.add(currentUrl.href);

    let response: BitbucketFetchResponse;
    try {
      response = await fetchPage(currentUrl, fetchOptions);
    } catch {
      throw new CoordinatorError(
        `Could not reach Bitbucket Cloud while listing workspace '${workspace}'.`,
        "BITBUCKET_REQUEST_FAILED",
      );
    }
    if (!response.ok) throw httpError(response.status, workspace);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw invalidResponse("the response is not valid JSON");
    }
    const page = pageFromApi(body);
    repositories.push(...page.repositories);
    currentUrl = page.next
      ? safeNextPageUrl(page.next, currentUrl, collectionUrl)
      : null;
  }

  return repositories;
}
