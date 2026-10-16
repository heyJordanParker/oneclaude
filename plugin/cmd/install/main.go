// Command oneclaude-install puts the oneclaude routing plugin into the
// CLIProxyAPI that Claude Code talks to, and takes it out again. cmod runs it
// from the mod's install and uninstall steps.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	pluginID    = "oneclaude"
	seatPacerID = "claude-seat-pacer"
	defaultPort = "8317"
)

func main() {
	library := flag.String("library", "", "the built plugin library to install")
	config := flag.String("config", "", "the proxy's config file, found on its own when left out")
	data := flag.String("data", "", "the mod's data folder")
	remove := flag.Bool("remove", false, "take the plugin out of the proxy")
	flag.Parse()
	if err := run(*library, *config, *data, *remove); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(library, configPath, data string, remove bool) error {
	if configPath == "" {
		found, err := findConfig()
		if err != nil {
			return err
		}
		configPath = found
	}
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
	plugins := child(doc.Content[0], "plugins")
	configs := child(plugins, "configs")
	dir := expandHome(scalar(plugins, "dir", "~/.cli-proxy-api/plugins"))
	pacerMark := filepath.Join(data, "seat-pacer-was-on")

	if remove {
		set(child(configs, pluginID), "enabled", "false", "!!bool")
		if pacer := lookup(configs, seatPacerID); pacer != nil && data != "" && exists(pacerMark) {
			set(pacer, "enabled", "true", "!!bool")
		}
		if err := write(configPath, before, &doc); err != nil {
			return err
		}
		libraries, _ := filepath.Glob(filepath.Join(dir, "*", "*", pluginID+"-v*"))
		for _, path := range libraries {
			_ = os.Remove(path)
		}
		fmt.Printf("oneclaude is out of %s\n", configPath)
		return nil
	}

	version, ext, err := versionOf(library)
	if err != nil {
		return err
	}
	target := filepath.Join(dir, runtime.GOOS, runtime.GOARCH, pluginID+"-v"+version+ext)
	if err := place(library, target); err != nil {
		return err
	}
	set(plugins, "enabled", "true", "!!bool")
	own := child(configs, pluginID)
	set(own, "enabled", "true", "!!bool")
	set(child(own, "store"), "version", version, "!!str")
	if pacer := lookup(configs, seatPacerID); pacer != nil && scalar(pacer, "enabled", "false") == "true" {
		set(pacer, "enabled", "false", "!!bool")
		if data != "" {
			if err := os.MkdirAll(data, 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(pacerMark, nil, 0o644); err != nil {
				return err
			}
		}
	}
	if err := write(configPath, before, &doc); err != nil {
		return err
	}
	fmt.Printf("oneclaude %s routes through %s\n", version, configPath)
	return nil
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

func versionOf(library string) (version, ext string, err error) {
	name := filepath.Base(library)
	ext = filepath.Ext(name)
	prefix := pluginID + "-v"
	if library == "" || !strings.HasPrefix(name, prefix) || ext == "" {
		return "", "", fmt.Errorf("--library must name a built %s-v<version> library, got %q", pluginID, library)
	}
	if !exists(library) {
		return "", "", fmt.Errorf("%s does not exist: build the plugin first", library)
	}
	return strings.TrimSuffix(strings.TrimPrefix(name, prefix), ext), ext, nil
}

// place copies the library beside its final name and renames it in, so the
// proxy never sees half a file. A version already in place stays untouched,
// because the proxy may have it loaded.
func place(library, target string) error {
	if exists(target) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	source, err := os.Open(library)
	if err != nil {
		return err
	}
	defer source.Close()
	partial := filepath.Join(filepath.Dir(target), "."+filepath.Base(target)+".partial")
	out, err := os.OpenFile(partial, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, source); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(partial, target)
}

// write puts the edited plugins block in place of the original one and keeps
// every other byte of the file. It writes in place, so a symbolic link stays one.
func write(path string, before []byte, doc *yaml.Node) error {
	root := doc.Content[0]
	var key, value *yaml.Node
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value == "plugins" {
			key, value = root.Content[i], root.Content[i+1]
		}
	}
	headless := *key
	headless.HeadComment = ""
	var buf bytes.Buffer
	encoder := yaml.NewEncoder(&buf)
	encoder.SetIndent(indentOf(before))
	if err := encoder.Encode(&yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: []*yaml.Node{&headless, value}}); err != nil {
		return err
	}
	if err := encoder.Close(); err != nil {
		return err
	}
	after := []byte(splice(string(before), buf.String()))
	if bytes.Equal(before, after) {
		return nil
	}
	return os.WriteFile(path, after, 0o600)
}

// splice replaces the top-level plugins block of text with block, or adds
// block at the end when text has none. The blank lines and comments before
// the next top-level key stay with that key.
func splice(text, block string) string {
	lines := strings.SplitAfter(text, "\n")
	start, end := -1, len(lines)
	for i, line := range lines {
		bare := strings.TrimRight(line, "\r\n")
		if start < 0 {
			if bare == "plugins:" || strings.HasPrefix(bare, "plugins: ") || strings.HasPrefix(bare, "plugins:#") {
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
