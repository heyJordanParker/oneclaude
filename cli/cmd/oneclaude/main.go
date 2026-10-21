// Command oneclaude puts the oneclaude routing plugin into the CLIProxyAPI
// that Claude Code talks to, and takes it out again. It carries the plugin
// library inside it, so a release is one file per machine, and cmod runs it
// from the mod's install and uninstall steps.
package main

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
	"gopkg.in/yaml.v3"
)

const (
	pluginID      = "oneclaude"
	seatPacerID   = "claude-seat-pacer"
	defaultPort   = "8317"
	managementKey = "oneclaude"
	// proxyConfigMark is the file in the data folder that names the proxy's
	// config, where the mod checks a management key against its hash.
	proxyConfigMark = "proxy-config"
	steps         = 5
)

// library is the routing plugin, which make copies here before it builds
// this program.
//
//go:embed oneclaude.dylib
var library []byte

// version is the routing plugin's version, which make sets from main.go.
var version = "dev"

// plugin is the routing plugin an install puts into the proxy.
type plugin struct {
	library []byte
	version string
}

const usage = `oneclaude routes every Claude account you have as one pool, through CLIProxyAPI.
cmod runs this program when it installs and removes the oneclaude mod.

Usage:
  oneclaude install [--config <file>] [--data <folder>]
  oneclaude remove  [--config <file>] [--data <folder>]
  oneclaude --version

  --config  the proxy's config file, found on its own when left out
  --data    the folder that keeps the plugin's files and what remove puts back,
            cmod's data folder for oneclaude when left out
`

func main() {
	command := ""
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	switch command {
	case "--version", "-v", "version":
		fmt.Println(version)
		return
	case "install", "remove":
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	flags := flag.NewFlagSet("oneclaude "+command, flag.ExitOnError)
	config := flags.String("config", "", "the proxy's config file, found on its own when left out")
	data := flags.String("data", expandHome("~/.local/share/cmod/data/oneclaude"), "the folder that keeps the plugin's files and what remove puts back")
	_ = flags.Parse(os.Args[2:])
	if err := run(plugin{library, version}, *config, *data, command == "remove"); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(built plugin, configPath, data string, remove bool) error {
	isGiven := configPath != ""
	if !remove {
		progress(0, "Finding CLIProxyAPI")
	}
	if !isGiven {
		found, err := findConfig()
		if err != nil && remove {
			return nil
		}
		if err != nil {
			progress(1, "Installing CLIProxyAPI")
			if found, err = installProxy(); err != nil {
				return err
			}
		}
		configPath = found
	}
	if !remove && data == "" {
		return errors.New("oneclaude install needs --data, the folder that keeps the plugin's files")
	}
	if !remove {
		progress(2, "Starting the proxy")
		if !isGiven && isHomebrewConfig(configPath) {
			if err := keepProxyCurrent(portOf(configPath)); err != nil {
				return err
			}
		}
		progress(3, "Adding oneclaude")
	}
	authDir, err := apply(built, configPath, data, remove)
	if err != nil || remove {
		return err
	}
	progress(4, "Bringing over your Claude login")
	if err := bringLogin(authDir, home()); err != nil {
		return err
	}
	progress(steps, "oneclaude routes your Claude accounts")
	return nil
}

// minimumProxy is the CLIProxyAPI this oneclaude is tested with. 8.0.12 added
// the routing reset that clears a block, 8.0.14 stopped Claude Code's 404 for
// an expired conversation from blocking a model for 12 hours, and 8.0.30 stopped
// a late reply from undoing a block's end.
const minimumProxy = "8.0.35"

// keepProxyCurrent brings the Homebrew proxy to minimumProxy, then starts it,
// or restarts it when it runs an older version than the one installed.
// Claude Code resends a reply the restart drops.
func keepProxyCurrent(port string) error {
	installed := brewVersion()
	if isOlder(installed, minimumProxy) {
		if out, err := exec.Command("brew", "upgrade", "cliproxyapi").CombinedOutput(); err != nil {
			return fmt.Errorf("brew upgrade cliproxyapi failed: %s", lastLine(out))
		}
		fmt.Printf("CLIProxyAPI %s is now %s\n", installed, brewVersion())
	}
	action := ""
	switch {
	case !isListening(port):
		action = "start"
	case startedBefore(port, brewInstalledAt()):
		action = "restart"
	default:
		return nil
	}
	if out, err := exec.Command("brew", "services", action, "cliproxyapi").CombinedOutput(); err != nil {
		return fmt.Errorf("brew services %s cliproxyapi failed: %s", action, lastLine(out))
	}
	return nil
}

// brewVersion is the newest CLIProxyAPI Homebrew holds, or "" for none.
func brewVersion() string {
	out, err := exec.Command("brew", "list", "--versions", "cliproxyapi").Output()
	if err != nil {
		return ""
	}
	newest := ""
	for _, v := range strings.Fields(string(out))[1:] {
		if newest == "" || isOlder(newest, v) {
			newest = v
		}
	}
	return newest
}

// brewInstalledAt is when Homebrew put the linked CLIProxyAPI in place.
func brewInstalledAt() time.Time {
	prefix, err := exec.Command("brew", "--prefix", "cliproxyapi").Output()
	if err != nil {
		return time.Time{}
	}
	info, err := os.Stat(strings.TrimSpace(string(prefix)))
	if err != nil {
		return time.Time{}
	}
	return info.ModTime()
}

// startedBefore reports whether the process listening on port started before
// at, so it still runs the program it started with.
func startedBefore(port string, at time.Time) bool {
	pids, err := exec.Command("lsof", "-nP", "-iTCP:"+port, "-sTCP:LISTEN", "-t").Output()
	if err != nil || at.IsZero() {
		return false
	}
	for _, pid := range strings.Fields(string(pids)) {
		out, err := exec.Command("ps", "-o", "lstart=", "-p", pid).Output()
		if err != nil {
			continue
		}
		started, err := time.ParseInLocation("Mon Jan _2 15:04:05 2006", strings.TrimSpace(string(out)), time.Local)
		if err == nil && started.Before(at) {
			return true
		}
	}
	return false
}

// isOlder compares dotted versions number by number, without Homebrew's
// revision, the _1 of 8.0.35_1. An unknown version is older than any.
func isOlder(version, than string) bool {
	if version == "" {
		return true
	}
	version, _, _ = strings.Cut(version, "_")
	than, _, _ = strings.Cut(than, "_")
	a, b := strings.Split(version, "."), strings.Split(than, ".")
	for i := range max(len(a), len(b)) {
		x, y := 0, 0
		if i < len(a) {
			x, _ = strconv.Atoi(a[i])
		}
		if i < len(b) {
			y, _ = strconv.Atoi(b[i])
		}
		if x != y {
			return x < y
		}
	}
	return false
}

// progress moves the bar cmod draws while the install step runs.
func progress(done int, label string) {
	fmt.Printf("progress %d %d %s\n", done, steps, label)
}

func home() string {
	dir, _ := os.UserHomeDir()
	return dir
}

func isHomebrewConfig(path string) bool {
	return filepath.Base(path) == "cliproxyapi.conf" && filepath.Base(filepath.Dir(path)) == "etc"
}

func portOf(configPath string) string {
	var config struct {
		Server struct {
			Port int `yaml:"port"`
		} `yaml:"server"`
	}
	if raw, err := os.ReadFile(configPath); err == nil && yaml.Unmarshal(raw, &config) == nil && config.Server.Port != 0 {
		return fmt.Sprint(config.Server.Port)
	}
	return defaultPort
}

func isListening(port string) bool {
	conn, err := net.DialTimeout("tcp", "127.0.0.1:"+port, time.Second)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// keychainLogin is the item Claude Code keeps its own login in on macOS.
const keychainLogin = "Claude Code-credentials"

// bringLogin copies the account Claude Code is logged in to into the proxy
// as a credential file, the same file the proxy writes after its own login,
// unless the proxy already holds that account. A Claude Code with no login,
// such as one that uses an API key, brings nothing.
func bringLogin(authDir, home string) error {
	var state struct {
		Account struct {
			Email        string `json:"emailAddress"`
			AccountUUID  string `json:"accountUuid"`
			Organization string `json:"organizationUuid"`
			OrgName      string `json:"organizationName"`
		} `json:"oauthAccount"`
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	if err != nil || json.Unmarshal(raw, &state) != nil || state.Account.Email == "" {
		fmt.Println("Claude Code is not logged in to a Claude account, so oneclaude brings no login")
		return nil
	}
	email := state.Account.Email
	if holds, err := holdsAccount(authDir, email); err != nil || holds {
		if holds {
			fmt.Printf("the proxy already holds %s\n", email)
		}
		return err
	}
	secret, err := exec.Command("security", "find-generic-password", "-s", keychainLogin, "-w").Output()
	if err != nil {
		fmt.Printf("the keychain holds no %s item, so oneclaude brings no login\n", keychainLogin)
		return nil
	}
	var login struct {
		OAuth struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
			ExpiresAt    int64  `json:"expiresAt"`
		} `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(secret, &login); err != nil || login.OAuth.RefreshToken == "" {
		return fmt.Errorf("the keychain's %s item holds no Claude login oneclaude can read", keychainLogin)
	}
	credential, err := json.Marshal(map[string]string{
		"type":              "claude",
		"email":             email,
		"access_token":      login.OAuth.AccessToken,
		"refresh_token":     login.OAuth.RefreshToken,
		"expired":           time.UnixMilli(login.OAuth.ExpiresAt).Format(time.RFC3339),
		"last_refresh":      time.Now().Format(time.RFC3339),
		"account_uuid":      state.Account.AccountUUID,
		"organization_uuid": state.Account.Organization,
		"organization_name": state.Account.OrgName,
	})
	if err != nil {
		return err
	}
	target := filepath.Join(authDir, credentialName(email, state.Account.Organization, state.Account.AccountUUID))
	if err := writeAtomically(target, credential, 0o600); err != nil {
		return err
	}
	fmt.Printf("the proxy now holds %s, the account Claude Code is logged in to\n", email)
	return nil
}

func holdsAccount(authDir, email string) (bool, error) {
	files, err := filepath.Glob(filepath.Join(authDir, "*.json"))
	if err != nil {
		return false, err
	}
	for _, path := range files {
		var credential struct {
			Type  string `json:"type"`
			Email string `json:"email"`
		}
		if raw, err := os.ReadFile(path); err == nil && json.Unmarshal(raw, &credential) == nil && credential.Type == "claude" && strings.EqualFold(credential.Email, email) {
			return true, nil
		}
	}
	return false, nil
}

// credentialName names the file as CLIProxyAPI's CredentialFileName does,
// so a later login to the same account in the proxy replaces it.
func credentialName(email, organization, account string) string {
	identity := organization
	if identity == "" {
		identity = account
	}
	if identity == "" {
		return "claude-" + email + ".json"
	}
	digest := sha256.Sum256([]byte(identity))
	return "claude-" + hex.EncodeToString(digest[:])[:8] + "-" + email + ".json"
}

func writeAtomically(path string, content []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	partial := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".partial")
	if err := os.WriteFile(partial, content, mode); err != nil {
		return err
	}
	return os.Rename(partial, path)
}

// installProxy installs CLIProxyAPI with Homebrew and makes its example
// config safe to run: it listens on this machine only and takes requests with
// no client key, as Claude Code sends none of its own.
func installProxy() (string, error) {
	if _, err := exec.LookPath("brew"); err != nil {
		return "", errors.New("oneclaude routes through CLIProxyAPI, which installs with Homebrew, and Homebrew is not installed: install it from https://brew.sh, then install oneclaude again")
	}
	if out, err := exec.Command("brew", "install", "cliproxyapi").CombinedOutput(); err != nil {
		return "", fmt.Errorf("brew install cliproxyapi failed: %s", lastLine(out))
	}
	prefix, err := exec.Command("brew", "--prefix").Output()
	if err != nil {
		return "", err
	}
	config := filepath.Join(strings.TrimSpace(string(prefix)), "etc", "cliproxyapi.conf")
	return config, secure(config)
}

func secure(configPath string) error {
	before, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(before, &doc); err != nil {
		return fmt.Errorf("%s is not valid YAML: %w", configPath, err)
	}
	if len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return fmt.Errorf("%s holds no settings", configPath)
	}
	root := doc.Content[0]
	set(child(root, "server"), "host", "127.0.0.1", "!!str")
	if keys := lookup(child(root, "access"), "api-keys"); keys != nil && keys.Kind == yaml.SequenceNode {
		kept := keys.Content[:0]
		for _, key := range keys.Content {
			if !strings.HasPrefix(key.Value, "your-api-key") {
				kept = append(kept, key)
			}
		}
		keys.Content = kept
		if len(kept) == 0 {
			keys.Style = yaml.FlowStyle
		}
	}
	return write(configPath, before, &doc, "server", "access")
}

func lastLine(out []byte) string {
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	return lines[len(lines)-1]
}

// apply adds oneclaude to the proxy config, or takes it out, and answers the
// folder the proxy keeps its credential files in.
func apply(built plugin, configPath, data string, remove bool) (string, error) {
	before, err := os.ReadFile(configPath)
	if err != nil {
		return "", err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(before, &doc); err != nil {
		return "", fmt.Errorf("%s is not valid YAML: %w", configPath, err)
	}
	if len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return "", fmt.Errorf("%s holds no settings", configPath)
	}
	root := doc.Content[0]
	plugins := child(root, "plugins")
	configs := child(plugins, "configs")
	dir := expandHome(scalar(plugins, "dir", "~/.cli-proxy-api/plugins"))
	authDir := expandHome("~/.cli-proxy-api")
	if oauth := lookup(root, "oauth"); oauth != nil {
		authDir = expandHome(scalar(oauth, "auth-dir", authDir))
	}
	pacerMark := filepath.Join(data, "seat-pacer-was-on")
	keyMark := filepath.Join(data, "management-key-was")

	if remove {
		set(child(configs, pluginID), "enabled", "false", "!!bool")
		if pacer := lookup(configs, seatPacerID); pacer != nil && data != "" && exists(pacerMark) {
			set(pacer, "enabled", "true", "!!bool")
		}
		if management := lookup(root, "management"); management != nil {
			if was, err := os.ReadFile(keyMark); err == nil && isManagementKey(scalar(management, "secret-key", "")) {
				set(management, "secret-key", string(was), "!!str")
			}
		}
		if err := write(configPath, before, &doc, "plugins", "management"); err != nil {
			return "", err
		}
		libraries, _ := filepath.Glob(filepath.Join(dir, "*", "*", pluginID+"-v*"))
		for _, path := range libraries {
			_ = os.Remove(path)
		}
		fmt.Printf("oneclaude is out of %s\n", configPath)
		return authDir, nil
	}

	kept := expandHome("~/.cli-proxy-api/plugins/" + pluginID)
	if own := lookup(configs, pluginID); own != nil {
		kept = expandHome(scalar(own, "data-dir", kept))
	}
	if filepath.Clean(kept) != filepath.Clean(data) {
		if err := moveData(kept, data); err != nil {
			return "", err
		}
	}
	target := filepath.Join(dir, runtime.GOOS, runtime.GOARCH, pluginID+"-v"+built.version+".dylib")
	if err := place(built.library, target); err != nil {
		return "", err
	}
	if err := os.MkdirAll(data, 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(data, proxyConfigMark), []byte(configPath), 0o600); err != nil {
		return "", err
	}
	management := child(root, "management")
	secret := scalar(management, "secret-key", "")
	if remote := lookup(root, "remote-management"); remote != nil && remote.Kind == yaml.MappingNode {
		secret = scalar(remote, "secret-key", secret)
	}
	if secret == "" {
		hash, err := bcrypt.GenerateFromPassword([]byte(managementKey), bcrypt.DefaultCost)
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(keyMark, nil, 0o600); err != nil {
			return "", err
		}
		set(management, "secret-key", string(hash), "!!str")
	}
	set(plugins, "enabled", "true", "!!bool")
	own := child(configs, pluginID)
	set(own, "enabled", "true", "!!bool")
	set(own, "data-dir", data, "!!str")
	set(child(own, "store"), "version", built.version, "!!str")
	if pacer := lookup(configs, seatPacerID); pacer != nil && scalar(pacer, "enabled", "false") == "true" {
		set(pacer, "enabled", "false", "!!bool")
		if data != "" {
			if err := os.MkdirAll(data, 0o755); err != nil {
				return "", err
			}
			if err := os.WriteFile(pacerMark, nil, 0o644); err != nil {
				return "", err
			}
		}
	}
	if err := write(configPath, before, &doc, "plugins", "management"); err != nil {
		return "", err
	}
	fmt.Printf("oneclaude %s routes through %s\n", built.version, configPath)
	return authDir, nil
}

// moveData moves the files the plugin kept in from, its folder before this
// version, into data, before the proxy loads this version. A file data
// already holds stays, and an old log's lines go after the lines there, so
// the log's first line, where the transcript import stopped, stays first.
func moveData(from, data string) error {
	entries, err := os.ReadDir(from)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := os.MkdirAll(data, 0o700); err != nil {
		return err
	}
	for _, e := range entries {
		old, target := filepath.Join(from, e.Name()), filepath.Join(data, e.Name())
		if !exists(target) {
			if err := os.Rename(old, target); err != nil {
				return err
			}
			continue
		}
		if e.Name() == "requests.jsonl" {
			if err := appendFile(old, target); err != nil {
				return err
			}
		}
		if err := os.Remove(old); err != nil {
			return err
		}
	}
	_ = os.Remove(from)
	return nil
}

func appendFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// isManagementKey says whether the config's secret-key, a bcrypt hash as the
// proxy keeps it, is oneclaude's own management key.
func isManagementKey(hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(managementKey)) == nil
}

// findConfig finds the config of the proxy Claude Code talks to: the
// -config the process on its port was started with, else the places
// CLIProxyAPI's installs keep it.
func findConfig() (string, error) {
	home, _ := os.UserHomeDir()
	candidates := []string{
		runningConfig(proxyPort(home)),
		"/opt/homebrew/etc/cliproxyapi.conf",
		"/usr/local/etc/cliproxyapi.conf",
		"/home/linuxbrew/.linuxbrew/etc/cliproxyapi.conf",
		filepath.Join(home, ".cli-proxy-api", "config.yaml"),
	}
	for _, path := range candidates {
		if path != "" && exists(path) {
			return path, nil
		}
	}
	return "", errors.New("no CLIProxyAPI config found: Claude Code's ANTHROPIC_BASE_URL names no running proxy started with -config, and none of the usual config files exists")
}

func proxyPort(home string) string {
	base := os.Getenv("ANTHROPIC_BASE_URL")
	if base == "" {
		var settings struct {
			Env map[string]string `json:"env"`
		}
		if raw, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json")); err == nil && json.Unmarshal(raw, &settings) == nil {
			base = settings.Env["ANTHROPIC_BASE_URL"]
		}
	}
	if parsed, err := url.Parse(base); err == nil && parsed.Port() != "" {
		return parsed.Port()
	}
	return defaultPort
}

func runningConfig(port string) string {
	pids, err := exec.Command("lsof", "-nP", "-iTCP:"+port, "-sTCP:LISTEN", "-t").Output()
	if err != nil {
		return ""
	}
	for _, pid := range strings.Fields(string(pids)) {
		args, err := exec.Command("ps", "-o", "args=", "-p", pid).Output()
		if err != nil {
			continue
		}
		fields := strings.Fields(string(args))
		for i, field := range fields {
			switch {
			case (field == "-config" || field == "--config") && i+1 < len(fields):
				return fields[i+1]
			case strings.HasPrefix(field, "-config="), strings.HasPrefix(field, "--config="):
				return field[strings.Index(field, "=")+1:]
			}
		}
	}
	return ""
}

// place writes the library beside its final name and renames it in, so the
// proxy never sees half a file. A version already in place stays untouched,
// because the proxy may have it loaded.
func place(library []byte, target string) error {
	if exists(target) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return writeAtomically(target, library, 0o755)
}

// write puts each named top-level block, as edited, in place of the original
// one and keeps every other byte of the file. It writes in place, so a
// symbolic link stays one.
func write(path string, before []byte, doc *yaml.Node, blocks ...string) error {
	if len(blocks) == 0 {
		blocks = []string{"plugins"}
	}
	text := string(before)
	root := doc.Content[0]
	for _, name := range blocks {
		for i := 0; i+1 < len(root.Content); i += 2 {
			if root.Content[i].Value != name {
				continue
			}
			headless := *root.Content[i]
			headless.HeadComment = ""
			var buf bytes.Buffer
			encoder := yaml.NewEncoder(&buf)
			encoder.SetIndent(indentOf(before))
			if err := encoder.Encode(&yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: []*yaml.Node{&headless, root.Content[i+1]}}); err != nil {
				return err
			}
			if err := encoder.Close(); err != nil {
				return err
			}
			text = splice(text, name, buf.String())
		}
	}
	if text == string(before) {
		return nil
	}
	return os.WriteFile(path, []byte(text), 0o600)
}

// splice replaces the top-level key's block of text with block, or adds block
// at the end when text has none. The blank lines and comments before the next
// top-level key stay with that key.
func splice(text, key, block string) string {
	lines := strings.SplitAfter(text, "\n")
	start, end := -1, len(lines)
	for i, line := range lines {
		bare := strings.TrimRight(line, "\r\n")
		if start < 0 {
			if bare == key+":" || strings.HasPrefix(bare, key+": ") || strings.HasPrefix(bare, key+":#") {
				start = i
			}
			continue
		}
		if bare != "" && bare[0] != ' ' && bare[0] != '#' {
			end = i
			break
		}
	}
	if start < 0 {
		if text != "" && !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		return text + block
	}
	for end > start+1 {
		bare := strings.TrimRight(lines[end-1], "\r\n")
		if bare != "" && bare[0] != '#' {
			break
		}
		end--
	}
	return strings.Join(lines[:start], "") + block + strings.Join(lines[end:], "")
}

// indentOf returns the indent the file's first nested line uses, so the saved
// file keeps it.
func indentOf(text []byte) int {
	for _, line := range strings.Split(string(text), "\n") {
		trimmed := strings.TrimLeft(line, " ")
		if indent := len(line) - len(trimmed); indent >= 2 && trimmed != "" && trimmed[0] != '#' {
			return indent
		}
	}
	return 4
}

func lookup(mapping *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			return mapping.Content[i+1]
		}
	}
	return nil
}

func child(mapping *yaml.Node, key string) *yaml.Node {
	if found := lookup(mapping, key); found != nil {
		if found.Kind != yaml.MappingNode {
			*found = yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		}
		return found
	}
	value := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	mapping.Content = append(mapping.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, value)
	return value
}

func scalar(mapping *yaml.Node, key, fallback string) string {
	if found := lookup(mapping, key); found != nil && found.Kind == yaml.ScalarNode && found.Value != "" {
		return found.Value
	}
	return fallback
}

func set(mapping *yaml.Node, key, value, tag string) {
	if found := lookup(mapping, key); found != nil {
		if found.Kind == yaml.ScalarNode && found.Value == value {
			return
		}
		style := found.Style
		*found = yaml.Node{Kind: yaml.ScalarNode, Tag: tag, Value: value, Style: style}
		return
	}
	mapping.Content = append(mapping.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, &yaml.Node{Kind: yaml.ScalarNode, Tag: tag, Value: value})
}

func expandHome(path string) string {
	if strings.HasPrefix(path, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, path[2:])
	}
	return path
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
