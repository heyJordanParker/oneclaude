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
	if got := splice(text, "plugins", "plugins:\n  enabled: false\n"); got != want {
		t.Fatalf("splice =\n%s", got)
	}
	if got := splice("a: 1", "plugins", "plugins:\n  enabled: true\n"); got != "a: 1\nplugins:\n  enabled: true\n" {
		t.Fatalf("splice without a plugins block =\n%s", got)
	}
}

const exampleConfig = `config-version: 8

# Listener, TLS, network discovery, and server operation.
server:
  # Server host/interface to bind to.
  host: ""

  # Server port
  port: 8317

# Client authentication for the proxy API.
access:
  # API keys for authentication
  api-keys:
    - "your-api-key-1"
    - "your-api-key-2"

routing:
  strategy: round-robin
`

func TestInstallingTheProxyKeepsItOnThisMachineWithNoPlaceholderKeys(t *testing.T) {
	prefix := t.TempDir()
	bin := t.TempDir()
	config := filepath.Join(prefix, "etc", "cliproxyapi.conf")
	brew := "#!/bin/sh\ncase \"$1\" in\n  --prefix) echo " + prefix + " ;;\n  install) mkdir -p " + filepath.Dir(config) + " && cat > " + config + " <<'EOF'\n" + exampleConfig + "EOF\n ;;\nesac\n"
	if err := os.WriteFile(filepath.Join(bin, "brew"), []byte(brew), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	found, err := installProxy()
	if err != nil {
		t.Fatal(err)
	}
	if found != config {
		t.Fatalf("installProxy = %s, want %s", found, config)
	}
	text, _ := os.ReadFile(config)
	for _, want := range []string{"  host: \"127.0.0.1\"\n", "  api-keys: []\n", "\nrouting:\n  strategy: round-robin\n", "config-version: 8\n\n# Listener"} {
		if !strings.Contains(string(text), want) {
			t.Fatalf("config lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(string(text), "your-api-key") {
		t.Fatalf("placeholder keys left:\n%s", text)
	}
}

func TestInstallingTheProxyWithoutHomebrewSaysWhatToDo(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if _, err := installProxy(); err == nil || !strings.Contains(err.Error(), "https://brew.sh") {
		t.Fatalf("installProxy without brew = %v", err)
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
