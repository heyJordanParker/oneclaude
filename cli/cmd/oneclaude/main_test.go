package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
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

var built = plugin{library: []byte("built plugin"), version: "0.2.0"}

func setUp(t *testing.T) (config, plugins, data string) {
	t.Helper()
	root := t.TempDir()
	t.Setenv("HOME", filepath.Join(root, "home"))
	t.Setenv("ANTHROPIC_BASE_URL", "")
	plugins = filepath.Join(root, "plugins")
	config = filepath.Join(root, "config.yaml")
	if err := os.WriteFile(config, []byte(strings.Replace(proxyConfig, "PLUGINS", plugins, 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	return config, plugins, filepath.Join(root, "data")
}

func TestInstallPlacesTheLibraryAndSwitchesTheProxyToIt(t *testing.T) {
	config, plugins, data := setUp(t)
	on(t, "darwin")
	before, _ := os.ReadFile(config)
	if err := run(built, config, data, false); err != nil {
		t.Fatal(err)
	}
	placed := filepath.Join(plugins, "darwin", runtime.GOARCH, "oneclaude-v0.2.0.dylib")
	if got, _ := os.ReadFile(placed); string(got) != "built plugin" {
		t.Fatalf("placed library = %q", got)
	}
	after, _ := os.ReadFile(config)
	text := string(after)
	for _, want := range []string{
		"        oneclaude:\n            enabled: true\n            data-dir: " + data + "\n            store:\n                version: 0.2.0\n",
		"        claude-seat-pacer:\n            enabled: false\n",
		"    strategy: fill-first # keeps one account warm\n",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("config lacks %q:\n%s", want, text)
		}
	}
	head := string(before)[:strings.Index(string(before), "plugins:")]
	middle := string(before)[strings.Index(string(before), "server:"):strings.Index(string(before), "management:")]
	if !strings.HasPrefix(text, head) || !strings.Contains(text, middle) {
		t.Fatalf("a byte outside the plugins and management blocks changed:\n%s", text)
	}
	if key := secretKeyOf(t, config); key != "$2y$10$not.a.real.hash" {
		t.Fatalf("the proxy's own management key changed to %q", key)
	}
	if exists(filepath.Join(data, "management-key")) {
		t.Fatal("install stored the key oneclaude, which the proxy's own key refuses")
	}
	if strings.Contains(text, "allow-remote") {
		t.Fatalf("install opened the management API to other machines for a proxy only this one uses:\n%s", text)
	}
}

func TestInstallStoresTheKeyItGivesAProxyWithNone(t *testing.T) {
	config, _, data := setUp(t)
	raw, _ := os.ReadFile(config)
	if err := os.WriteFile(config, []byte(strings.Replace(string(raw), "management:\n    secret-key: \"$2y$10$not.a.real.hash\"\n", "", 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(data, "filters"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "proxy-config"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(built, config, data, false); err != nil {
		t.Fatal(err)
	}
	if key, _ := os.ReadFile(filepath.Join(data, "management-key")); string(key) != "oneclaude" {
		t.Fatalf("management-key = %q, want oneclaude, the key install set", key)
	}
	if exists(filepath.Join(data, "proxy-config")) || exists(filepath.Join(data, "filters")) {
		t.Fatal("install kept proxy-config or filters/, which no version reads now")
	}
}

func TestInstallLeavesAStoredKey(t *testing.T) {
	config, _, data := setUp(t)
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "management-key"), []byte("their own key"), 0o600); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(config)
	if err := os.WriteFile(config, []byte(strings.Replace(string(raw), "$2y$10$not.a.real.hash", "oneclaude", 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(built, config, data, false); err != nil {
		t.Fatal(err)
	}
	if key, _ := os.ReadFile(filepath.Join(data, "management-key")); string(key) != "their own key" {
		t.Fatalf("management-key = %q, want the key the person entered", key)
	}
}

func TestInstallOpensTheManagementAPIOfAPoolOtherMachinesUse(t *testing.T) {
	config, _, data := setUp(t)
	t.Setenv("ANTHROPIC_BASE_URL", "http://devbox:8317")
	if err := run(built, config, data, false); err != nil {
		t.Fatal(err)
	}
	text, _ := os.ReadFile(config)
	if !strings.Contains(string(text), "management:\n    secret-key: \"$2y$10$not.a.real.hash\"\n    allow-remote: true\n") {
		t.Fatalf("config does not let the other machines read blocks:\n%s", text)
	}
}

func TestInstallWithThePoolOnAnotherMachineSetsUpNothingHere(t *testing.T) {
	_, _, data := setUp(t)
	t.Setenv("ANTHROPIC_BASE_URL", "http://devbox.invalid:9")
	t.Setenv("PATH", t.TempDir())
	if err := run(built, "", data, false); err != nil {
		t.Fatalf("install = %v, want it to finish with nothing to set up", err)
	}
	if entries, _ := os.ReadDir(os.Getenv("HOME")); len(entries) != 0 {
		t.Fatalf("install set something up in the home folder: %v", entries)
	}
	if exists(filepath.Join(data, "management-key")) {
		t.Fatal("install stored a key the pool never took")
	}
	if err := run(plugin{}, "", data, true); err != nil {
		t.Fatalf("remove = %v, want nothing to take out", err)
	}
}

func TestThePoolIsHereWhenItsHostNamesThisMachineWhetherOrNotItRuns(t *testing.T) {
	if got := remotePool("http://127.0.0.1:8317"); got != "" {
		t.Fatalf("remotePool(loopback) = %q, want the pool here", got)
	}
	if got := remotePool("http://devbox.invalid:8317/"); got != "http://devbox.invalid:8317" {
		t.Fatalf("remotePool(another machine) = %q", got)
	}
	if got := listenHost(""); got != "127.0.0.1" {
		t.Fatalf("listenHost(unset) = %q, want this machine only", got)
	}
	if got := hereAt("192.0.2.1"); got != "" {
		t.Fatalf("hereAt(an address of no machine here) = %q", got)
	}
	addresses, _ := net.InterfaceAddrs()
	for _, address := range addresses {
		network, ok := address.(*net.IPNet)
		if !ok || network.IP.IsLoopback() || network.IP.To4() == nil {
			continue
		}
		own := network.IP.String()
		if got := remotePool("http://" + own + ":9"); got != "" {
			t.Fatalf("remotePool(this machine's %s, with nothing listening) = %q, want the pool here", own, got)
		}
		if got := listenHost("http://" + own + ":8317"); got != own {
			t.Fatalf("listenHost(this machine's %s) = %q, want the proxy to listen there for the other machines", own, got)
		}
		return
	}
	t.Skip("this machine has no address but loopback")
}

func TestKeepKeyStoresTheKeyOnlyOnceThePoolTakesIt(t *testing.T) {
	pool := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v0/management/plugins/oneclaude/status" || r.Header.Get("Authorization") != "Bearer oneclaude" {
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	t.Cleanup(pool.Close)
	if !takesKey(pool.URL, "oneclaude") || takesKey(pool.URL, "wrong") || takesKey("http://devbox.invalid:9", "oneclaude") {
		t.Fatal("takesKey does not answer what the pool says")
	}
	data := t.TempDir()
	if err := keepKey(data, func(string) bool { return false }); err != nil || exists(filepath.Join(data, "management-key")) {
		t.Fatalf("keepKey stored a refused key: %v", err)
	}
	if err := keepKey(data, func(key string) bool { return takesKey(pool.URL, key) }); err != nil {
		t.Fatal(err)
	}
	if key, _ := os.ReadFile(filepath.Join(data, "management-key")); string(key) != "oneclaude" {
		t.Fatalf("management-key = %q, want oneclaude", key)
	}
}

func TestInstallGivesAProxyWithNoManagementKeyOneclaudesAndRemoveTakesItOut(t *testing.T) {
	config, _, data := setUp(t)
	raw, _ := os.ReadFile(config)
	if err := os.WriteFile(config, []byte(strings.Replace(string(raw), "management:\n    secret-key: \"$2y$10$not.a.real.hash\"\n", "", 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(built, config, data, false); err != nil {
		t.Fatal(err)
	}
	if !isManagementKey(secretKeyOf(t, config)) {
		t.Fatalf("the management key is not oneclaude: %q", secretKeyOf(t, config))
	}
	if err := run(plugin{}, config, data, true); err != nil {
		t.Fatal(err)
	}
	if key := secretKeyOf(t, config); key != "" {
		t.Fatalf("remove left the key oneclaude set: %q", key)
	}
}

func secretKeyOf(t *testing.T, config string) string {
	t.Helper()
	var parsed struct {
		Management struct {
			SecretKey string `yaml:"secret-key"`
		} `yaml:"management"`
	}
	raw, _ := os.ReadFile(config)
	if err := yaml.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	return parsed.Management.SecretKey
}

func TestInstallAgainChangesNothing(t *testing.T) {
	config, _, data := setUp(t)
	if err := run(built, config, data, false); err != nil {
		t.Fatal(err)
	}
	once, _ := os.ReadFile(config)
	if err := run(built, config, data, false); err != nil {
		t.Fatal(err)
	}
	twice, _ := os.ReadFile(config)
	if string(once) != string(twice) {
		t.Fatalf("a second install changed the config:\n%s", twice)
	}
}

func TestRemoveTurnsOneclaudeOffAndSeatPacerBackOn(t *testing.T) {
	config, plugins, data := setUp(t)
	if err := run(built, config, data, false); err != nil {
		t.Fatal(err)
	}
	if err := run(plugin{}, config, data, true); err != nil {
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
	if key := secretKeyOf(t, config); key != "$2y$10$not.a.real.hash" {
		t.Fatalf("the person's management key changed: %q", key)
	}
}

const claudeState = `{"oauthAccount":{"emailAddress":"ada@example.com","accountUuid":"account-a","organizationUuid":"organization-a","organizationName":"Ada's Organization"}}`

const keychainItem = `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-access","refreshToken":"sk-ant-ort01-refresh","expiresAt":1792000000000,"scopes":["user:inference"],"subscriptionType":"max"}}`

// on runs the rest of the test as if on system, the GOOS it names.
func on(t *testing.T, system string) {
	t.Helper()
	was := goos
	goos = system
	t.Cleanup(func() { goos = was })
}

// loggedIn gives the test's home a Claude Code logged in to ada@example.com,
// with a security program that answers the keychain item as macOS does.
func loggedIn(t *testing.T) {
	t.Helper()
	on(t, "darwin")
	home := os.Getenv("HOME")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(claudeState), 0o600); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	security := "#!/bin/sh\n[ \"$1 $2 $3\" = 'find-generic-password -s Claude Code-credentials' ] || exit 44\necho '" + keychainItem + "'\n"
	if err := os.WriteFile(filepath.Join(bin, "security"), []byte(security), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
}

func TestInstallBringsClaudeCodesLoginIntoTheProxy(t *testing.T) {
	config, _, data := setUp(t)
	loggedIn(t)
	if err := run(built, config, data, false); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(os.Getenv("HOME"), ".cli-proxy-api", "claude-"+hashOf("organization-a")+"-ada@example.com.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no credential file: %v", err)
	}
	var credential map[string]string
	if err := json.Unmarshal(raw, &credential); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{
		"type":              "claude",
		"email":             "ada@example.com",
		"access_token":      "sk-ant-oat01-access",
		"refresh_token":     "sk-ant-ort01-refresh",
		"expired":           time.UnixMilli(1792000000000).Format(time.RFC3339),
		"account_uuid":      "account-a",
		"organization_uuid": "organization-a",
		"organization_name": "Ada's Organization",
	} {
		if credential[key] != want {
			t.Fatalf("credential %s = %q, want %q", key, credential[key], want)
		}
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("credential mode = %v", info.Mode().Perm())
	}
}

func TestInstallOnLinuxBringsTheLoginClaudeCodeKeepsInItsCredentialsFile(t *testing.T) {
	config, _, data := setUp(t)
	on(t, "linux")
	home := os.Getenv("HOME")
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(claudeState), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude", ".credentials.json"), []byte(keychainItem), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(built, config, data, false); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(home, ".cli-proxy-api", "claude-"+hashOf("organization-a")+"-ada@example.com.json"))
	if err != nil {
		t.Fatalf("no credential file: %v", err)
	}
	var credential map[string]string
	if err := json.Unmarshal(raw, &credential); err != nil {
		t.Fatal(err)
	}
	if credential["refresh_token"] != "sk-ant-ort01-refresh" || credential["email"] != "ada@example.com" {
		t.Fatalf("credential = %v", credential)
	}
}

func TestInstallWithClaudeCodeSignedOutBringsNothingAndFinishes(t *testing.T) {
	config, _, data := setUp(t)
	on(t, "linux")
	home := os.Getenv("HOME")
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(claudeState), 0o600); err != nil {
		t.Fatal(err)
	}
	signedOut := `{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,"scopes":[]}}`
	if err := os.WriteFile(filepath.Join(home, ".claude", ".credentials.json"), []byte(signedOut), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(built, config, data, false); err != nil {
		t.Fatalf("install with Claude Code signed out = %v, want it to finish", err)
	}
	if files, _ := filepath.Glob(filepath.Join(home, ".cli-proxy-api", "*.json")); len(files) != 0 {
		t.Fatalf("credential files = %v, want none", files)
	}
}

func TestInstallOnLinuxPlacesTheLibraryAsASharedObject(t *testing.T) {
	config, plugins, data := setUp(t)
	on(t, "linux")
	if err := run(built, config, data, false); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(plugins, "linux", runtime.GOARCH, "oneclaude-v0.2.0.so")); string(got) != "built plugin" {
		t.Fatalf("placed library = %q, want the plugin as the .so the proxy loads on Linux", got)
	}
}

func TestInstallLeavesAnAccountTheProxyAlreadyHolds(t *testing.T) {
	config, _, data := setUp(t)
	loggedIn(t)
	authDir := filepath.Join(os.Getenv("HOME"), ".cli-proxy-api")
	own := filepath.Join(authDir, "claude-ADA@example.com.json")
	if err := os.MkdirAll(authDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(own, []byte(`{"type":"claude","email":"ADA@example.com","refresh_token":"the proxy's own"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(built, config, data, false); err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(authDir, "*.json"))
	if len(files) != 1 || files[0] != own {
		t.Fatalf("credential files = %v, want only %s", files, own)
	}
}

func TestInstallWithoutAClaudeLoginBringsNothing(t *testing.T) {
	config, _, data := setUp(t)
	if err := run(built, config, data, false); err != nil {
		t.Fatal(err)
	}
	if files, _ := filepath.Glob(filepath.Join(os.Getenv("HOME"), ".cli-proxy-api", "*.json")); len(files) != 0 {
		t.Fatalf("credential files = %v, want none", files)
	}
}

func hashOf(identity string) string {
	digest := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(digest[:])[:8]
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

plugins:
  enabled: false
  dir: "plugins"
`

func TestInstallingTheProxyKeepsItOnThisMachineWithNoPlaceholderKeys(t *testing.T) {
	on(t, "darwin")
	prefix := t.TempDir()
	bin := t.TempDir()
	config := filepath.Join(prefix, "etc", "cliproxyapi.conf")
	brew := "#!/bin/sh\ncase \"$1\" in\n  --prefix) echo " + prefix + " ;;\n  install) mkdir -p " + filepath.Dir(config) + " && cat > " + config + " <<'EOF'\n" + exampleConfig + "EOF\n ;;\nesac\n"
	if err := os.WriteFile(filepath.Join(bin, "brew"), []byte(brew), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	found, err := installProxy(listenHost(""))
	if err != nil {
		t.Fatal(err)
	}
	if found != config {
		t.Fatalf("installProxy = %s, want %s", found, config)
	}
	text, _ := os.ReadFile(config)
	for _, want := range []string{"  host: \"127.0.0.1\"\n", "  api-keys: []\n", "\nrouting:\n  strategy: round-robin\n", "config-version: 8\n\n# Listener", "  dir: \"~/.cli-proxy-api/plugins\"\n"} {
		if !strings.Contains(string(text), want) {
			t.Fatalf("config lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(string(text), "your-api-key") {
		t.Fatalf("placeholder keys left:\n%s", text)
	}
}

func TestInstallBringsAnOlderProxyToTheTestedVersionAndStartsIt(t *testing.T) {
	bin := t.TempDir()
	calls := filepath.Join(bin, "calls")
	version := filepath.Join(bin, "version")
	if err := os.WriteFile(version, []byte("8.0.0"), 0o600); err != nil {
		t.Fatal(err)
	}
	brew := "#!/bin/sh\necho \"$@\" >> " + calls + "\ncase \"$1\" in\n  list) echo cliproxyapi $(cat " + version + ") ;;\n  upgrade) echo " + minimumProxy + " > " + version + " ;;\n  --prefix) echo " + bin + " ;;\nesac\n"
	if err := os.WriteFile(filepath.Join(bin, "brew"), []byte(brew), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	if err := keepProxyCurrent("1"); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(calls)
	if want := "list --versions cliproxyapi\nupgrade cliproxyapi\nlist --versions cliproxyapi\nservices start cliproxyapi\n"; string(got) != want {
		t.Fatalf("brew ran:\n%s\nwant:\n%s", got, want)
	}
	if !isOlder("8.0.9", "8.0.35") || isOlder("8.1.0", "8.0.35") || isOlder("8.0.35", "8.0.35") || isOlder("8.0.35_1", "8.0.35") {
		t.Fatal("versions compare as text, not as numbers, or a Homebrew revision counts as older")
	}
}

func TestInstallWithoutADataFolderStops(t *testing.T) {
	config, _, _ := setUp(t)
	if err := run(built, config, "", false); err == nil || !strings.Contains(err.Error(), "--data") {
		t.Fatalf("install without --data = %v, want it to stop and name --data", err)
	}
}

func TestInstallMovesThePluginsFilesOutOfTheProxysCredentialFolder(t *testing.T) {
	config, _, data := setUp(t)
	kept := filepath.Join(os.Getenv("HOME"), ".cli-proxy-api", "plugins", "oneclaude")
	if err := os.MkdirAll(kept, 0o700); err != nil {
		t.Fatal(err)
	}
	old := `{"at":"2026-10-14T12:00:00Z","account":"0000beef"}` + "\n"
	for name, text := range map[string]string{"install.key": "the salt of the account hashes", "usage.json": `{"imported":true}`, "requests.jsonl": old} {
		if err := os.WriteFile(filepath.Join(kept, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := run(built, config, data, false); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"install.key": "the salt of the account hashes", "usage.json": `{"imported":true}`, "requests.jsonl": old} {
		if got, err := os.ReadFile(filepath.Join(data, name)); err != nil || string(got) != want {
			t.Fatalf("%s = %q %v, want %q", name, got, err, want)
		}
	}
	if _, err := os.Stat(kept); !os.IsNotExist(err) {
		t.Fatalf("the old folder is still there: %v", err)
	}

	late := `{"at":"2026-10-15T12:00:00Z","account":"0000beef"}` + "\n"
	if err := os.MkdirAll(kept, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, text := range map[string]string{"usage.json": `{"imported":false}`, "requests.jsonl": late} {
		if err := os.WriteFile(filepath.Join(kept, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := moveData(kept, data); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(data, "usage.json")); string(got) != `{"imported":true}` {
		t.Fatalf("usage.json = %s, want the one the data folder holds", got)
	}
	if got, _ := os.ReadFile(filepath.Join(data, "requests.jsonl")); string(got) != old+late {
		t.Fatalf("requests.jsonl = %q, want the late lines after the log, so its first line stays first", got)
	}
}

func TestInstallingTheProxyWithoutHomebrewSaysWhatToDo(t *testing.T) {
	on(t, "darwin")
	t.Setenv("PATH", t.TempDir())
	if _, err := installProxy("127.0.0.1"); err == nil || !strings.Contains(err.Error(), "https://brew.sh") {
		t.Fatalf("installProxy without brew = %v", err)
	}
}

func TestInstallKeepsTheFilesTwoSpaceIndent(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", filepath.Join(root, "home"))
	config := filepath.Join(root, "config.yaml")
	original := "server:\n  port: 8318\n\n# loaded from .target\nplugins:\n  enabled: true\n  dir: \"" + filepath.Join(root, "plugins") + "\"\n  configs:\n    oneclaude:\n      enabled: true\n"
	if err := os.WriteFile(config, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(root, "data")
	if err := run(built, config, data, false); err != nil {
		t.Fatal(err)
	}
	text, _ := os.ReadFile(config)
	if !strings.Contains(string(text), "    oneclaude:\n      enabled: true\n      data-dir: "+data+"\n      store:\n        version: 0.2.0\n") {
		t.Fatalf("config lost its indent:\n%s", text)
	}
	if !strings.HasPrefix(string(text), "server:\n  port: 8318\n\n# loaded from .target\nplugins:\n") {
		t.Fatalf("the lines above plugins changed:\n%s", text)
	}
}

func TestInstallFollowsASymbolicLink(t *testing.T) {
	config, _, data := setUp(t)
	link := filepath.Join(filepath.Dir(config), "linked.yaml")
	if err := os.Symlink(config, link); err != nil {
		t.Fatal(err)
	}
	if err := run(built, link, data, false); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Lstat(link); info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the config link was replaced by a file")
	}
}
