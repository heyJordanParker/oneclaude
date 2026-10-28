package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// On Linux, oneclaude installs CLIProxyAPI from its official release instead
// of Homebrew, and runs it as a systemd user service.

// latestRelease answers CLIProxyAPI's newest release. Tests point it at their
// own server.
var latestRelease = "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest"

// service is the systemd user service that runs the proxy.
const service = "cliproxyapi"

// releases is the folder each CLIProxyAPI version unpacks into, beside the
// current link to the version the service runs.
func releases() string { return expandHome("~/.local/share/cliproxyapi") }

func releaseConfig() string { return expandHome("~/.cli-proxy-api/config.yaml") }

func unitFile() string { return expandHome("~/.config/systemd/user/" + service + ".service") }

// isReleaseConfig says whether configPath is the config of the proxy this
// install runs as a service, so the install keeps that proxy current.
func isReleaseConfig(configPath string) bool {
	return configPath == releaseConfig() && exists(unitFile())
}

// installRelease installs the newest CLIProxyAPI, its example config made
// safe to listen on host, and the user service that runs it, also while
// nobody is logged in, and again whenever it stops.
func installRelease(host string) (string, error) {
	if _, err := download(); err != nil {
		return "", err
	}
	current := filepath.Join(releases(), "current")
	example, err := os.ReadFile(filepath.Join(current, "config.example.yaml"))
	if err != nil {
		return "", err
	}
	config := releaseConfig()
	if err := writeAtomically(config, example, 0o600); err != nil {
		return "", err
	}
	if err := secure(config, host); err != nil {
		return "", err
	}
	unit := fmt.Sprintf(`[Unit]
Description=CLIProxyAPI, which oneclaude routes Claude Code through
After=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStart=%s -config %s
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`, filepath.Join(current, "cli-proxy-api"), config)
	if err := writeAtomically(unitFile(), []byte(unit), 0o644); err != nil {
		return "", err
	}
	for _, command := range [][]string{
		{"systemctl", "--user", "daemon-reload"},
		{"systemctl", "--user", "enable", service},
		{"loginctl", "enable-linger"},
	} {
		if out, err := exec.Command(command[0], command[1:]...).CombinedOutput(); err != nil {
			return "", fmt.Errorf("%s failed: %s", strings.Join(command, " "), lastLine(out))
		}
	}
	return config, nil
}

// keepReleaseCurrent brings the service's proxy to minimumProxy and starts
// it, or restarts it on the version it now runs.
func keepReleaseCurrent() error {
	installed := releaseVersion()
	action := "start"
	if isOlder(installed, minimumProxy) {
		newest, err := download()
		if err != nil {
			return err
		}
		fmt.Printf("CLIProxyAPI %s is now %s\n", installed, newest)
		action = "restart"
	}
	if out, err := exec.Command("systemctl", "--user", action, service).CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl --user %s %s failed: %s", action, service, lastLine(out))
	}
	return nil
}

// releaseVersion is the version the current link points at, or "" for none.
func releaseVersion() string {
	target, err := os.Readlink(filepath.Join(releases(), "current"))
	if err != nil {
		return ""
	}
	return filepath.Base(target)
}

// download unpacks the newest CLIProxyAPI release for this machine into its
// version's folder, after checking it against the digest GitHub keeps, points
// the current link at it, and answers its version.
func download() (string, error) {
	var release struct {
		Tag    string `json:"tag_name"`
		Assets []struct {
			Name   string `json:"name"`
			URL    string `json:"browser_download_url"`
			Digest string `json:"digest"`
		} `json:"assets"`
	}
	raw, err := fetch(latestRelease)
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal(raw, &release); err != nil {
		return "", fmt.Errorf("CLIProxyAPI's latest release is not JSON: %w", err)
	}
	version := strings.TrimPrefix(release.Tag, "v")
	arch := map[string]string{"amd64": "amd64", "arm64": "aarch64"}[runtime.GOARCH]
	name := fmt.Sprintf("CLIProxyAPI_%s_linux_%s.tar.gz", version, arch)
	for _, asset := range release.Assets {
		if asset.Name != name {
			continue
		}
		archive, err := fetch(asset.URL)
		if err != nil {
			return "", err
		}
		sum := sha256.Sum256(archive)
		if want := strings.TrimPrefix(asset.Digest, "sha256:"); want == "" || hex.EncodeToString(sum[:]) != want {
			return "", fmt.Errorf("%s does not match the digest GitHub keeps for it", name)
		}
		folder := filepath.Join(releases(), version)
		if err := unpack(archive, folder, "cli-proxy-api", "config.example.yaml"); err != nil {
			return "", fmt.Errorf("%s: %w", name, err)
		}
		link := filepath.Join(releases(), ".current.partial")
		_ = os.Remove(link)
		if err := os.Symlink(version, link); err != nil {
			return "", err
		}
		return version, os.Rename(link, filepath.Join(releases(), "current"))
	}
	return "", fmt.Errorf("CLIProxyAPI %s has no %s", version, name)
}

func fetch(url string) ([]byte, error) {
	response, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %s", url, response.Status)
	}
	return io.ReadAll(response.Body)
}

// unpack writes the named files of a .tar.gz archive into folder.
func unpack(archive []byte, folder string, names ...string) error {
	compressed, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return err
	}
	files := tar.NewReader(compressed)
	left := map[string]bool{}
	for _, name := range names {
		left[name] = true
	}
	for len(left) > 0 {
		header, err := files.Next()
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("holds no %v", left)
		}
		if err != nil {
			return err
		}
		name := filepath.Base(header.Name)
		if !left[name] || header.Typeflag != tar.TypeReg {
			continue
		}
		content, err := io.ReadAll(files)
		if err != nil {
			return err
		}
		if err := writeAtomically(filepath.Join(folder, name), content, os.FileMode(header.Mode).Perm()|0o600); err != nil {
			return err
		}
		delete(left, name)
	}
	return nil
}
