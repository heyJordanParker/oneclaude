package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// release serves CLIProxyAPI's latest release as GitHub does, version with
// this machine's archive, and answers the file the commands the install runs
// are written to.
func release(t *testing.T, version, digest string) (calls string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	arch := map[string]string{"amd64": "amd64", "arm64": "aarch64"}[runtime.GOARCH]
	name := fmt.Sprintf("CLIProxyAPI_%s_linux_%s.tar.gz", version, arch)
	var archive bytes.Buffer
	compressed := gzip.NewWriter(&archive)
	files := tar.NewWriter(compressed)
	for _, file := range []struct{ name, text string }{
		{"LICENSE", "MIT"},
		{"cli-proxy-api", "#!/bin/sh\necho CLIProxyAPI " + version + "\n"},
		{"config.example.yaml", exampleConfig},
	} {
		if err := files.WriteHeader(&tar.Header{Name: file.name, Mode: 0o755, Size: int64(len(file.text)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := files.Write([]byte(file.text)); err != nil {
			t.Fatal(err)
		}
	}
	if err := files.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	if digest == "" {
		sum := sha256.Sum256(archive.Bytes())
		digest = "sha256:" + hex.EncodeToString(sum[:])
	}
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest":
			fmt.Fprintf(w, `{"tag_name":"v%s","assets":[{"name":"%s_no-plugin","browser_download_url":"%s/no","digest":"sha256:00"},{"name":"%s","browser_download_url":"%s/archive","digest":"%s"}]}`, version, name, server.URL, name, server.URL, digest)
		case "/archive":
			_, _ = w.Write(archive.Bytes())
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	was := latestRelease
	latestRelease = server.URL + "/latest"
	t.Cleanup(func() { latestRelease = was })

	bin := t.TempDir()
	calls = filepath.Join(bin, "calls")
	for _, command := range []string{"systemctl", "loginctl"} {
		script := "#!/bin/sh\necho " + command + " \"$@\" >> " + calls + "\n"
		if err := os.WriteFile(filepath.Join(bin, command), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	on(t, "linux")
	return calls
}

func TestInstallingTheProxyOnLinuxRunsTheCheckedReleaseAsAServiceOnThisMachineOnly(t *testing.T) {
	calls := release(t, "8.0.46", "")
	found, err := installProxy("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	home := os.Getenv("HOME")
	if want := filepath.Join(home, ".cli-proxy-api", "config.yaml"); found != want {
		t.Fatalf("installProxy = %s, want %s", found, want)
	}
	proxy := filepath.Join(home, ".local", "share", "cliproxyapi", "current", "cli-proxy-api")
	if got, _ := os.ReadFile(proxy); !strings.Contains(string(got), "CLIProxyAPI 8.0.46") {
		t.Fatalf("%s = %q, want the release's proxy", proxy, got)
	}
	if info, err := os.Stat(proxy); err != nil || info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("the proxy is not executable: %v", err)
	}
	text, _ := os.ReadFile(found)
	for _, want := range []string{"  host: \"127.0.0.1\"\n", "  api-keys: []\n", "  dir: \"~/.cli-proxy-api/plugins\"\n"} {
		if !strings.Contains(string(text), want) {
			t.Fatalf("config lacks %q:\n%s", want, text)
		}
	}
	unit, _ := os.ReadFile(filepath.Join(home, ".config", "systemd", "user", "cliproxyapi.service"))
	if want := "ExecStart=" + proxy + " -config " + found + "\n"; !strings.Contains(string(unit), want) {
		t.Fatalf("the service lacks %q:\n%s", want, unit)
	}
	if !isReleaseConfig(found) {
		t.Fatal("the install does not count the config as the one its service runs")
	}
	got, _ := os.ReadFile(calls)
	if want := "systemctl --user daemon-reload\nsystemctl --user enable cliproxyapi\nloginctl enable-linger\n"; string(got) != want {
		t.Fatalf("ran:\n%s\nwant:\n%s", got, want)
	}
}

func TestInstallingTheProxyOnLinuxRefusesAnArchiveThatDoesNotMatchItsDigest(t *testing.T) {
	release(t, "8.0.46", "sha256:"+strings.Repeat("0", 64))
	if _, err := installProxy("127.0.0.1"); err == nil || !strings.Contains(err.Error(), "digest") {
		t.Fatalf("installProxy = %v, want it to refuse the archive", err)
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("HOME"), ".local", "share", "cliproxyapi", "current")); !os.IsNotExist(err) {
		t.Fatalf("a refused archive was installed: %v", err)
	}
}

func TestInstallBringsAnOlderServiceProxyToTheNewestAndRestartsIt(t *testing.T) {
	calls := release(t, "8.0.46", "")
	releases := filepath.Join(os.Getenv("HOME"), ".local", "share", "cliproxyapi")
	if err := os.MkdirAll(filepath.Join(releases, "8.0.0"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("8.0.0", filepath.Join(releases, "current")); err != nil {
		t.Fatal(err)
	}
	if err := keepReleaseCurrent(); err != nil {
		t.Fatal(err)
	}
	if got := releaseVersion(); got != "8.0.46" {
		t.Fatalf("the service runs %s, want 8.0.46", got)
	}
	if got, _ := os.ReadFile(calls); string(got) != "systemctl --user restart cliproxyapi\n" {
		t.Fatalf("ran:\n%s", got)
	}
}

func TestInstallStartsAServiceProxyThatIsCurrent(t *testing.T) {
	calls := release(t, "8.0.46", "")
	releases := filepath.Join(os.Getenv("HOME"), ".local", "share", "cliproxyapi")
	if err := os.MkdirAll(filepath.Join(releases, minimumProxy), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(minimumProxy, filepath.Join(releases, "current")); err != nil {
		t.Fatal(err)
	}
	if err := keepReleaseCurrent(); err != nil {
		t.Fatal(err)
	}
	if got := releaseVersion(); got != minimumProxy {
		t.Fatalf("the service runs %s, want %s, which is current", got, minimumProxy)
	}
	if got, _ := os.ReadFile(calls); string(got) != "systemctl --user start cliproxyapi\n" {
		t.Fatalf("ran:\n%s", got)
	}
}
