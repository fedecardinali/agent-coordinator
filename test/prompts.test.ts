import assert from "node:assert/strict";
import test from "node:test";
import {
  repositorySelectionOption,
  uniqueRepositoryValue,
  type DiscoveredRepository,
} from "../src/ui/prompts.js";

function repository(
  provider: DiscoveredRepository["provider"],
): DiscoveredRepository {
  return {
    description: null,
    directoryName: "api",
    fullName: "acme/api",
    isPrivate: true,
    name: "api",
    provider,
    sshUrl: `git@${provider === "github" ? "github.com" : "bitbucket.org"}:acme/api.git`,
  };
}

test("repository selection distinguishes the same full name on both hosts", () => {
  const github = repositorySelectionOption(repository("github"));
  const bitbucket = repositorySelectionOption(repository("bitbucket"));

  assert.deepEqual(github, {
    value: "github:acme/api",
    label: "GitHub · acme/api",
    hint: "private",
  });
  assert.deepEqual(bitbucket, {
    value: "bitbucket:acme/api",
    label: "Bitbucket Cloud · acme/api",
    hint: "private",
  });
  assert.notEqual(github.value, bitbucket.value);
  assert.notEqual(github.label, bitbucket.label);
});

test("repository path collisions use provider prefixes and deterministic suffixes", () => {
  const used = new Set<string>();
  const githubPath = uniqueRepositoryValue("api", "github", used);
  used.add(githubPath);
  const firstBitbucketPath = uniqueRepositoryValue("api", "bitbucket", used);
  used.add(firstBitbucketPath);
  const secondBitbucketPath = uniqueRepositoryValue("api", "bitbucket", used);
  used.add(secondBitbucketPath);
  const thirdBitbucketPath = uniqueRepositoryValue("api", "bitbucket", used);

  assert.deepEqual(
    [githubPath, firstBitbucketPath, secondBitbucketPath, thirdBitbucketPath],
    ["api", "bitbucket-api", "bitbucket-api-2", "bitbucket-api-3"],
  );
});

test("repository role collisions use the colliding provider deterministically", () => {
  const used = new Set(["backend", "bitbucket-backend", "bitbucket-backend-2"]);

  assert.equal(
    uniqueRepositoryValue("backend", "bitbucket", used),
    "bitbucket-backend-3",
  );
  assert.equal(
    uniqueRepositoryValue("backend", "github", used),
    "github-backend",
  );
});
