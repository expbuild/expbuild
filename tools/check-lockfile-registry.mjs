import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Workspace links are repository-relative paths, not downloaded packages.
function isWorkspaceLink(entry) {
  return (
    entry.link === true &&
    typeof entry.resolved === "string" &&
    /^(?:[\w@.-]+\/)*[\w@.-]+$/.test(entry.resolved) &&
    entry.resolved.split("/").every((part) => part !== "." && part !== "..")
  );
}

function isPublicRegistry(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.origin === "https://registry.npmjs.org" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

// Walk both modern packages entries and legacy nested dependencies.
export function registryErrors(lockfile, location = "$", errors = []) {
  if (lockfile === null || typeof lockfile !== "object") return errors;
  if (
    Object.hasOwn(lockfile, "resolved") &&
    !isWorkspaceLink(lockfile) &&
    !isPublicRegistry(lockfile.resolved)
  ) {
    errors.push(
      `${location}.resolved must use https://registry.npmjs.org (or a local workspace link)`,
    );
  }
  for (const [key, value] of Object.entries(lockfile)) {
    registryErrors(value, `${location}[${JSON.stringify(key)}]`, errors);
  }
  return errors;
}

export function checkRepository(root) {
  const files = [
    ...new Set(
      execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: root, encoding: "utf8" },
      ).split("\0"),
    ),
  ].filter((file) =>
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/.test(file),
  );
  if (files.length === 0) throw new Error("No npm lockfiles found");
  const errors = [];
  for (const file of files) {
    try {
      const lockfile = JSON.parse(readFileSync(path.join(root, file), "utf8"));
      errors.push(
        ...registryErrors(lockfile).map((error) => `${file}: ${error}`),
      );
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
    }
  }
  return { files, errors };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { files, errors } = checkRepository(process.cwd());
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(
        `Checked ${files.length} npm lockfile(s): public HTTPS registry URLs and workspace links only`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
