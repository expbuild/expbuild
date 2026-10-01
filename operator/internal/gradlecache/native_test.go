package gradlecache

import (
	"context"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Set GRADLE_BIN to a fixed, verified Gradle distribution. Every build gets a
// fresh project and Gradle user home, so a FROM-CACHE result is genuinely remote.
func TestNativeGradleRemoteCache(t *testing.T) {
	gradle := os.Getenv("GRADLE_BIN")
	if gradle == "" {
		t.Skip("GRADLE_BIN is required for native Gradle validation")
	}
	server := httptest.NewServer(fixture(t, filepath.Join(t.TempDir(), "cache"), 1<<20, 8<<20))
	defer server.Close()
	settings := "rootProject.name = 'expbuild-gradle-fixture'\n"
	// Match the console's Kotlin init-script contract. Only this local HTTP
	// fixture opts into an insecure protocol; production guidance requires TLS.
	init := `import org.gradle.caching.http.HttpBuildCache
gradle.settingsEvaluated {
    buildCache {
        local { isEnabled = false }
        remote<HttpBuildCache> {
            url = uri(System.getenv("EXPBUILD_CACHE_URL"))
            isAllowInsecureProtocol = true
            credentials {
                username = System.getenv("EXPBUILD_CACHE_USER")
                password = System.getenv("EXPBUILD_CACHE_PASSWORD")
            }
            isPush = System.getenv("CI") == "true"
        }
    }
}
`
	build := `import org.gradle.api.tasks.*
@CacheableTask
abstract class RenderFile extends DefaultTask {
    @InputFile @PathSensitive(PathSensitivity.RELATIVE)
    abstract RegularFileProperty getInputFile()
    @OutputFile abstract RegularFileProperty getOutputFile()
    @TaskAction void render() {
        outputFile.get().asFile.parentFile.mkdirs()
        outputFile.get().asFile.text = inputFile.get().asFile.text.toUpperCase()
    }
}
tasks.register('render', RenderFile) {
    inputFile.set(layout.projectDirectory.file('input.txt'))
    outputFile.set(layout.buildDirectory.file('rendered.txt'))
}
`
	for i, test := range []struct{ remoteHit, disabled bool }{{}, {remoteHit: true}, {disabled: true}} {
		project := t.TempDir()
		for name, body := range map[string]string{"settings.gradle": settings, "build.gradle": build, "init.gradle.kts": init, "input.txt": "expbuild remote cache\n"} {
			if err := os.WriteFile(filepath.Join(project, name), []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		args := []string{"--no-daemon", "--console=plain", "--build-cache", "-I", filepath.Join(project, "init.gradle.kts"), "render"}
		if test.disabled {
			args[2] = "--no-build-cache"
		}
		cmd := exec.CommandContext(ctx, gradle, args...)
		cmd.Dir = project
		cmd.Env = append(os.Environ(), "GRADLE_USER_HOME="+filepath.Join(t.TempDir(), "gradle-home"),
			"EXPBUILD_CACHE_URL="+server.URL+"/cache/", "EXPBUILD_CACHE_USER=builder", "EXPBUILD_CACHE_PASSWORD=secret", "CI=true")
		output, err := cmd.CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("build %d failed: %v\n%s", i, err, output)
		}
		cached := strings.Contains(string(output), "FROM-CACHE")
		if cached != test.remoteHit {
			t.Fatalf("build %d cache result=%v, expected=%v\n%s", i, cached, test.remoteHit, output)
		}
		result, err := os.ReadFile(filepath.Join(project, "build", "rendered.txt"))
		if err != nil || string(result) != "EXPBUILD REMOTE CACHE\n" {
			t.Fatalf("build %d output=%q err=%v", i, result, err)
		}
	}
}
