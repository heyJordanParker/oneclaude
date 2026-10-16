package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const proxyConfig = `config-version: 8
routing:
    strategy: fill-first # keeps one account warm
plugins:
    enabled: true
    dir: "PLUGINS"
    configs:
        claude-seat-pacer:
            enabled: true
            store:
                id: claude-seat-pacer
                description: Paces Claude seats so each one uses up its weekly quota before the reset. New conversations go to the seat furthest behind its plan and stay there, so prompt caches keep hitting.
                tags:
                    - Scheduler
                    - Claude
server:
    port: 8317
management:
    secret-key: "$2y$10$not.a.real.hash"
`

func setUp(t *testing.T) (config, plugins, library, data string) {
	t.Helper()
	root := t.TempDir()
	plugins = filepath.Join(root, "plugins")
	config = filepath.Join(root, "config.yaml")
	if err := os.WriteFile(config, []byte(strings.Replace(proxyConfig, "PLUGINS", plugins, 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	library = filepath.Join(root, "oneclaude-v0.2.0.dylib")
	if err := os.WriteFile(library, []byte("built plugin"), 0o755); err != nil {
		t.Fatal(err)
	}
	return config, plugins, library, filepath.Join(root, "data")
}

func TestInstallPlacesTheLibraryAndSwitchesTheProxyToIt(t *testing.T) {
	config, plugins, library, data := setUp(t)
	before, _ := os.ReadFile(config)
	if err := run(library, config, data, false); err != nil {
		t.Fatal(err)
	}
	placed := filepath.Join(plugins, runtime.GOOS, runtime.GOARCH, "oneclaude-v0.2.0.dylib")
	if got, _ := os.ReadFile(placed); string(got) != "built plugin" {
		t.Fatalf("placed library = %q", got)
	}
	after, _ := os.ReadFile(config)
	text := string(after)
	for _, want := range []string{
		"        oneclaude:\n            enabled: true\n            store:\n                version: 0.2.0\n",
		"        claude-seat-pacer:\n            enabled: false\n",
		"    strategy: fill-first # keeps one account warm\n",
		"    secret-key: \"$2y$10$not.a.real.hash\"\n",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("config lacks %q:\n%s", want, text)
		}
	}
	head := string(before)[:strings.Index(string(before), "plugins:")]
	tail := string(before)[strings.Index(string(before), "server:"):]
	if !strings.HasPrefix(text, head) || !strings.HasSuffix(text, tail) {
		t.Fatalf("a byte outside the plugins block changed:\n%s", text)
	}
}

func TestInstallAgainChangesNothing(t *testing.T) {
	config, _, library, data := setUp(t)
	if err := run(library, config, data, false); err != nil {
		t.Fatal(err)
	}
	once, _ := os.ReadFile(config)
	if err := run(library, config, data, false); err != nil {
		t.Fatal(err)
	}
	twice, _ := os.ReadFile(config)
	if string(once) != string(twice) {
		t.Fatalf("a second install changed the config:\n%s", twice)
	}
}

func TestRemoveTurnsOneclaudeOffAndSeatPacerBackOn(t *testing.T) {
	config, plugins, library, data := setUp(t)
	if err := run(library, config, data, false); err != nil {
		t.Fatal(err)
	}
	if err := run("", config, data, true); err != nil {
		t.Fatal(err)
	}
	text, _ := os.ReadFile(config)
	if !strings.Contains(string(text), "        oneclaude:\n            enabled: false\n") {
		t.Fatalf("oneclaude still on:\n%s", text)
	}
	if !strings.Contains(string(text), "        claude-seat-pacer:\n            enabled: true\n") {
		t.Fatalf("seat pacer not back on:\n%s", text)
	}
	if left, _ := filepath.Glob(filepath.Join(plugins, "*", "*", "oneclaude-v*")); len(left) != 0 {
		t.Fatalf("libraries left: %v", left)
	}
}

func TestSpliceKeepsTheBlankLinesAndCommentsAroundThePluginsBlock(t *testing.T) {
	text := "a: 1\n\n# the plugins\nplugins:\n  enabled: true\n\n# the server\nb: 2\n"
	want := "a: 1\n\n# the plugins\nplugins:\n  enabled: false\n\n# the server\nb: 2\n"
	if got := splice(text, "plugins:\n  enabled: false\n"); got != want {
		t.Fatalf("splice =\n%s", got)
	}
	if got := splice("a: 1", "plugins:\n  enabled: true\n"); got != "a: 1\nplugins:\n  enabled: true\n" {
		t.Fatalf("splice without a plugins block =\n%s", got)
	}
}

func TestInstallKeepsTheFilesTwoSpaceIndent(t *testing.T) {
	root := t.TempDir()
	config := filepath.Join(root, "config.yaml")
	original := "server:\n  port: 8318\n\n# loaded from .target\nplugins:\n  enabled: true\n  dir: \"" + filepath.Join(root, "plugins") + "\"\n  configs:\n    oneclaude:\n      enabled: true\n"
	if err := os.WriteFile(config, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	library := filepath.Join(root, "oneclaude-v0.2.0.dylib")
	if err := os.WriteFile(library, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := run(library, config, "", false); err != nil {
		t.Fatal(err)
	}
	text, _ := os.ReadFile(config)
	if !strings.Contains(string(text), "    oneclaude:\n      enabled: true\n      store:\n        version: 0.2.0\n") {
		t.Fatalf("config lost its indent:\n%s", text)
	}
	if !strings.HasPrefix(string(text), "server:\n  port: 8318\n\n# loaded from .target\nplugins:\n") {
		t.Fatalf("the lines above plugins changed:\n%s", text)
	}
}

func TestInstallFollowsASymbolicLink(t *testing.T) {
	config, _, library, data := setUp(t)
	link := filepath.Join(filepath.Dir(config), "linked.yaml")
	if err := os.Symlink(config, link); err != nil {
		t.Fatal(err)
	}
	if err := run(library, link, data, false); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Lstat(link); info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the config link was replaced by a file")
	}
}
