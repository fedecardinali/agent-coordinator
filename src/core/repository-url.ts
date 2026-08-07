import { CoordinatorError } from "./errors.js";

export type RepositoryProvider = "github" | "bitbucket";

export interface RepositoryIdentity {
  host: "github.com" | "bitbucket.org";
  namespace: string;
  provider: RepositoryProvider;
  repository: string;
}

const providers = {
  github: { host: "github.com" },
  bitbucket: { host: "bitbucket.org" },
} as const satisfies Record<RepositoryProvider, { host: RepositoryIdentity["host"] }>;

function repositoryPath(value: string): { namespace: string; repository: string } | null {
  const normalized = value.replace(/\/+$/, "").replace(/\.git$/i, "");
  const segments = normalized.split("/");
  if (
    segments.length !== 2 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[\s\\?#@:%]/.test(segment),
    )
  ) {
    return null;
  }
  return {
    namespace: segments[0]!.toLowerCase(),
    repository: segments[1]!.toLowerCase(),
  };
}

function identity(
  provider: RepositoryProvider,
  value: string,
): RepositoryIdentity | null {
  const parsedPath = repositoryPath(value);
  if (!parsedPath) return null;
  return {
    provider,
    host: providers[provider].host,
    ...parsedPath,
  };
}

function providerForHost(host: string): RepositoryProvider | null {
  const normalized = host.toLowerCase();
  if (normalized === providers.github.host) return "github";
  if (normalized === providers.bitbucket.host) return "bitbucket";
  return null;
}

function parsePrefixedIdentity(value: string): RepositoryIdentity | null {
  const match = /^(github|bitbucket):(.*)$/i.exec(value);
  if (!match) return null;
  return identity(match[1]!.toLowerCase() as RepositoryProvider, match[2]!);
}

function parseScpIdentity(value: string): RepositoryIdentity | null {
  const match = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(value);
  if (!match) return null;
  const provider = providerForHost(match[1]!);
  return provider ? identity(provider, match[2]!) : null;
}

function parseUrlIdentity(value: string): RepositoryIdentity | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:", "ssh:"].includes(parsed.protocol)) return null;
  if (parsed.search || parsed.hash) return null;
  const provider = providerForHost(parsed.hostname);
  if (!provider) return null;
  if (
    provider === "bitbucket" &&
    (parsed.protocol === "http:" ||
      (parsed.protocol === "https:" && parsed.port && parsed.port !== "443") ||
      (parsed.protocol === "ssh:" && parsed.port && parsed.port !== "22"))
  ) {
    return null;
  }
  return identity(provider, parsed.pathname.replace(/^\/+/, ""));
}

function embeddedUrlCredentials(value: string): boolean {
  const scp = /^([^@/:]+)@(github\.com|bitbucket\.org):/i.exec(value);
  if (scp && scp[1]!.toLowerCase() !== "git") return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return Boolean(
    parsed.password ||
      parsed.search ||
      parsed.hash ||
      (["http:", "https:"].includes(parsed.protocol) && parsed.username) ||
      (parsed.protocol === "ssh:" &&
        providerForHost(parsed.hostname) &&
        parsed.username &&
        parsed.username.toLowerCase() !== "git"),
  );
}

/**
 * Resolves the repository identity for supported public Git hosts. Credentials,
 * protocols, and clone URL spelling are deliberately excluded from the result.
 */
export function parseRepositoryIdentity(input: string): RepositoryIdentity | null {
  const value = input.trim();
  const prefixed = parsePrefixedIdentity(value);
  if (prefixed) return prefixed;

  const scp = parseScpIdentity(value);
  if (scp) return scp;

  const url = parseUrlIdentity(value);
  if (url) return url;

  return /^[^/:]+\/[^/]+$/.test(value) ? identity("github", value) : null;
}

/** Returns a credential-free canonical SSH URL for a supported repository. */
export function canonicalRepositorySshUrl(input: string): string | null {
  const parsed = parseRepositoryIdentity(input);
  return parsed
    ? `git@${parsed.host}:${parsed.namespace}/${parsed.repository}.git`
    : null;
}

/**
 * Expands explicit provider shorthand while preserving fully specified clone
 * URLs. HTTP credentials stay in Git's credential store, never in the manifest.
 */
export function repositoryCloneUrl(input: string): string {
  const value = input.trim();
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(value);
  } catch {
    // Shorthand, SCP-style SSH URLs, and local paths are handled below.
  }
  if (embeddedUrlCredentials(value)) {
    throw new CoordinatorError(
      "Repository clone URLs must not embed credentials, query parameters, or fragments; configure Git credentials separately.",
      "REPOSITORY_URL_CREDENTIALS_FORBIDDEN",
    );
  }
  if (/^(?:github|bitbucket):/i.test(value)) {
    const canonical = canonicalRepositorySshUrl(value);
    if (!canonical) {
      throw new CoordinatorError(
        "Invalid provider shorthand; use github:owner/repository or bitbucket:workspace/repository.",
        "REPOSITORY_SHORTHAND_INVALID",
      );
    }
    return canonical;
  }
  if (/^[^/:]+\/[^/]+$/.test(value)) {
    return canonicalRepositorySshUrl(value) ?? value;
  }
  const isBitbucketUrl = parsedUrl?.hostname.toLowerCase() === "bitbucket.org";
  const isBitbucketScp = /^(?:[^@/:]+@)?bitbucket\.org:/i.test(value);
  if ((isBitbucketUrl || isBitbucketScp) && !parseRepositoryIdentity(value)) {
    throw new CoordinatorError(
      "Invalid Bitbucket Cloud clone URL; use HTTPS or SSH on the standard port with workspace/repository.",
      "BITBUCKET_URL_INVALID",
    );
  }
  return value;
}

/** Compares supported repositories by host and path, rejecting embedded credentials. */
export function repositoryUrlsMatch(expected: string, actual: string): boolean {
  if (embeddedUrlCredentials(expected) || embeddedUrlCredentials(actual)) {
    return false;
  }
  const expectedIdentity = parseRepositoryIdentity(expected);
  const actualIdentity = parseRepositoryIdentity(actual);
  if (expectedIdentity || actualIdentity) {
    return (
      expectedIdentity !== null &&
      actualIdentity !== null &&
      expectedIdentity.host === actualIdentity.host &&
      expectedIdentity.namespace === actualIdentity.namespace &&
      expectedIdentity.repository === actualIdentity.repository
    );
  }
  return expected.replace(/\/+$/, "") === actual.replace(/\/+$/, "");
}

/** Removes URL userinfo for safe diagnostics without changing clone behavior. */
export function redactRepositoryUrl(input: string): string {
  const canonical = canonicalRepositorySshUrl(input);
  if (canonical) return canonical;

  try {
    const parsed = new URL(input);
    if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
      return input;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return input;
  }
}
