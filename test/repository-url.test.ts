import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalRepositorySshUrl,
  parseRepositoryIdentity,
  redactRepositoryUrl,
  repositoryCloneUrl,
  repositoryUrlsMatch,
} from "../src/core/repository-url.js";

test("repository shorthand remains GitHub-compatible and accepts explicit providers", () => {
  assert.equal(repositoryCloneUrl("Acme/API"), "git@github.com:acme/api.git");
  assert.equal(repositoryCloneUrl("github:Acme/API.git"), "git@github.com:acme/api.git");
  assert.equal(
    repositoryCloneUrl("bitbucket:Acme/API.git"),
    "git@bitbucket.org:acme/api.git",
  );
});

test("GitHub clone URL spellings resolve to one credential-free identity", () => {
  const expected = {
    provider: "github",
    host: "github.com",
    namespace: "acme",
    repository: "api",
  };
  for (const value of [
    "git@github.com:Acme/API.git",
    "ssh://git@github.com/Acme/API.git",
    "https://github.com/Acme/API.git",
  ]) {
    assert.deepEqual(parseRepositoryIdentity(value), expected);
    assert.equal(canonicalRepositorySshUrl(value), "git@github.com:acme/api.git");
    assert.equal(repositoryCloneUrl(value), value);
  }
});

test("Bitbucket Cloud clone URL spellings resolve to one credential-free identity", () => {
  const expected = {
    provider: "bitbucket",
    host: "bitbucket.org",
    namespace: "acme",
    repository: "api",
  };
  for (const value of [
    "git@bitbucket.org:Acme/API.git",
    "ssh://git@bitbucket.org/Acme/API.git",
    "https://bitbucket.org/Acme/API.git",
  ]) {
    assert.deepEqual(parseRepositoryIdentity(value), expected);
    assert.equal(canonicalRepositorySshUrl(value), "git@bitbucket.org:acme/api.git");
    assert.equal(repositoryCloneUrl(value), value);
  }
});

test("repository comparison ignores safe protocol, case, and suffix differences", () => {
  assert.equal(
    repositoryUrlsMatch(
      "bitbucket:Acme/API",
      "https://bitbucket.org/acme/api.git",
    ),
    true,
  );
  assert.equal(
    repositoryUrlsMatch("github:acme/api", "git@bitbucket.org:acme/api.git"),
    false,
  );
  assert.equal(
    repositoryUrlsMatch("bitbucket:acme/api", "git@bitbucket.org:acme/web.git"),
    false,
  );
  assert.equal(
    repositoryUrlsMatch(
      "bitbucket:acme/api",
      "https://account:do-not-expose@bitbucket.org/acme/api.git",
    ),
    false,
  );
});

test("local paths and unsupported hosts are preserved without reinterpretation", () => {
  for (const value of [
    "/tmp/acme/api.git",
    "./acme/api",
    "../acme/api",
    "C:\\work\\acme\\api.git",
    "file:///tmp/acme/api.git",
    "acme/team/api",
    "git@gitlab.com:acme/api.git",
    "https://git.example.com/acme/api.git",
    "ssh://git@bitbucket.internal/acme/api.git",
  ]) {
    assert.equal(parseRepositoryIdentity(value), null);
    assert.equal(canonicalRepositorySshUrl(value), null);
    assert.equal(repositoryCloneUrl(value), value);
  }
});

test("invalid supported-host paths are not partially normalized", () => {
  for (const value of [
    "https://github.com/acme/team/api.git",
    "https://github.com/acme%2Fteam/api.git",
  ]) {
    assert.equal(parseRepositoryIdentity(value), null);
    assert.equal(repositoryCloneUrl(value), value);
  }
});

test("invalid reserved Bitbucket forms fail before Git interprets them", () => {
  for (const value of [
    "bitbucket:acme",
    "bitbucket:acme/team/api",
    "bitbucket:acme/api?token=secret",
    "git@bitbucket.org:acme/team/api.git",
    "http://bitbucket.org/acme/api.git",
    "https://bitbucket.org:8443/acme/api.git",
    "ssh://git@bitbucket.org:7999/acme/api.git",
  ]) {
    assert.equal(parseRepositoryIdentity(value), null);
    assert.throws(() => repositoryCloneUrl(value), /Invalid|credentials/);
  }
});

test("safe diagnostics redact userinfo for supported and unsupported hosts", () => {
  const secret = "do-not-expose";
  const supported = redactRepositoryUrl(
    `https://account:${secret}@bitbucket.org/acme/api.git`,
  );
  const unsupported = redactRepositoryUrl(
    `https://account:${secret}@git.example.com/acme/api.git?token=${secret}#private`,
  );

  assert.equal(supported, "git@bitbucket.org:acme/api.git");
  assert.equal(unsupported, "https://git.example.com/acme/api.git");
  assert.equal(supported.includes(secret), false);
  assert.equal(unsupported.includes(secret), false);
});

test("clone URL expansion refuses embedded credentials", () => {
  for (const value of [
    "https://account:secret@bitbucket.org/acme/api.git",
    "https://github.com/acme/api.git?token=secret",
    "https://git.example.com/acme/api.git#credential",
    "ssh://git:secret@bitbucket.org/acme/api.git",
    "ssh://oauth-token@bitbucket.org/acme/api.git",
    "oauth-token@github.com:acme/api.git",
  ]) {
    assert.throws(
      () => repositoryCloneUrl(value),
      /must not embed credentials/,
    );
  }
});
