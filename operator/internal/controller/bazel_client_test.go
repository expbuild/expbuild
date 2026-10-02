package controller

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The undeclared guard/marker are intentional test instrumentation: a second
// execution must fail. Fresh output bases exclude Bazel's local action cache.
func verifyBazelClient(t *testing.T, binary, cache, username string) {
	t.Helper()
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(name, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	guard, marker := filepath.Join(root, "allow-execution"), filepath.Join(root, "executions")
	write(guard, "allowed")
	write(filepath.Join(workspace, "WORKSPACE"), "workspace(name = \"cache_contract\")\n")
	write(filepath.Join(workspace, "BUILD"), "load(\":contract.bzl\", \"cache_artifact\")\nplatform(name = \"fixture\")\ncache_artifact(name = \"artifact\")\n")
	// Shell only uses builtins; no C++, Java or shell toolchain downloads required.
	shell := fmt.Sprintf("[ -f '%s' ] || exit 42; printf 'remote cache contract\\n' > \"$1\"; printf 'executed\\n' >> '%s'", guard, marker)
	write(filepath.Join(workspace, "contract.bzl"), fmt.Sprintf(`def _impl(ctx):
    out = ctx.actions.declare_file("artifact.txt")
    ctx.actions.run(executable = "/bin/sh", arguments = ["-c", %s, "fixture", out.path], outputs = [out], execution_requirements = {"no-sandbox": "1"}, mnemonic = "CacheContract")
    return [DefaultInfo(files = depset([out]))]
cache_artifact = rule(implementation = _impl)
`, strconv.Quote(shell)))
	credential := base64.StdEncoding.EncodeToString([]byte(username + ":engine-test-only"))
	rc := filepath.Join(root, "client.bazelrc")
	write(rc, "build --remote_cache="+cache+"\nbuild --remote_header="+strconv.Quote("Authorization=Basic "+credential)+"\n")
	for _, stage := range []string{"first", "second", "uncached"} {
		if stage == "second" {
			if err := os.Remove(guard); err != nil {
				t.Fatal(err)
			}
		}
		outputBase := filepath.Join(root, stage)
		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		command := exec.CommandContext(ctx, binary, "--batch", "--nosystem_rc", "--nohome_rc", "--noworkspace_rc", "--bazelrc="+rc, "--output_user_root="+filepath.Join(root, "client"), "--output_base="+outputBase, "--host_jvm_args=-Xmx256m", "build", "//:artifact", "--enable_bzlmod=false", "--enable_workspace=true", "--incompatible_autoload_externally=", "--host_platform=//:fixture", "--platforms=//:fixture", "--extra_execution_platforms=//:fixture", "--remote_download_outputs=all", "--remote_timeout=30", "--remote_retries=0", "--jobs=2", "--color=no", "--curses=no", "--noshow_progress", "--noshow_loading_progress", "--noannounce_rc")
		if stage == "uncached" {
			command.Args = append(command.Args, "--remote_cache=")
		}
		command.Dir = workspace
		output, err := command.CombinedOutput()
		cancel()
		if stage == "uncached" {
			if err == nil || !strings.Contains(string(output), "(Exit 42)") {
				t.Fatalf("disabled cache did not trigger execution guard: %v\n%s", err, strings.ReplaceAll(string(output), credential, "<redacted>"))
			}
			executions, readErr := os.ReadFile(marker)
			if readErr != nil || string(executions) != "executed\n" {
				t.Fatal("failed local action changed the execution marker")
			}
			continue
		}
		if err != nil {
			t.Fatalf("Bazel %s build failed: %v\n%s", stage, err, strings.ReplaceAll(string(output), credential, "<redacted>"))
		}
		artifact := filepath.Join(workspace, "bazel-bin", "artifact.txt")
		actual, err := filepath.EvalSymlinks(artifact)
		// macOS temp paths may use /var while Bazel resolves /private/var.
		// Canonicalize both sides without weakening the fresh-output boundary.
		canonicalBase, baseErr := filepath.EvalSymlinks(outputBase)
		if err != nil || baseErr != nil || !strings.HasPrefix(actual, canonicalBase+string(os.PathSeparator)) {
			t.Fatalf("output is not from fresh build directory: artifact=%q base=%q artifactErr=%v baseErr=%v", actual, canonicalBase, err, baseErr)
		}
		contents, err := os.ReadFile(actual)
		if err != nil || string(contents) != "remote cache contract\n" {
			t.Fatalf("Bazel artifact mismatch: %v", err)
		}
		executions, err := os.ReadFile(marker)
		if err != nil || string(executions) != "executed\n" {
			t.Fatalf("action must execute exactly once: %v", err)
		}
	}
	t.Log("real Bazel restored ActionCache/CAS output into a fresh local cache without re-executing the action")
}
