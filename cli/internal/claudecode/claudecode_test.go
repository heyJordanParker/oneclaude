package claudecode

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	account = `{"oauthAccount":{"emailAddress":"ada@example.com","accountUuid":"account-a","organizationUuid":"organization-a","organizationName":"Ada's Organization"}}`
	tokens1 = `{"claudeAiOauth":{"accessToken":"access-1","refreshToken":"refresh-1","expiresAt":1792000000000}}`
)

// as runs the rest of the test as Claude Code on system, for the user
// oneclaude-test, with a security program that answers only item and logs
// every call in the file it returns.
func as(t *testing.T, system, item, secret string) (calls string) {
	t.Helper()
	t.Setenv("USER", "oneclaude-test")
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	wasOS, wasSecurity := goos, security
	t.Cleanup(func() { goos, security = wasOS, wasSecurity })
	goos = system
	bin := t.TempDir()
	calls = filepath.Join(bin, "calls")
	security = filepath.Join(bin, "security")
	script := "#!/bin/sh\necho \"$*\" >> '" + calls + "'\n[ \"$*\" = 'find-generic-password -a oneclaude-test -w -s " + item + "' ] || exit 44\necho '" + secret + "'\n"
	if err := os.WriteFile(security, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return calls
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestStoredLoginReadsTheKeychainItemOnMacOS(t *testing.T) {
	as(t, "darwin", "Claude Code-credentials", tokens1)
	home := t.TempDir()
	write(t, filepath.Join(home, ".claude.json"), account)
	login, err := StoredLogin(home)
	if err != nil {
		t.Fatal(err)
	}
	want := Login{Email: "ada@example.com", Account: "account-a", Organization: "organization-a", OrganizationName: "Ada's Organization", AccessToken: "access-1", RefreshToken: "refresh-1", ExpiresAt: time.UnixMilli(1792000000000)}
	if login != want {
		t.Fatalf("login = %+v, want %+v", login, want)
	}
}

func TestStoredLoginReadsTheCredentialsFileOnLinux(t *testing.T) {
	calls := as(t, "linux", "", "")
	home := t.TempDir()
	write(t, filepath.Join(home, ".claude.json"), account)
	write(t, filepath.Join(home, ".claude", ".credentials.json"), tokens1)
	if login, err := StoredLogin(home); err != nil || login.AccessToken != "access-1" {
		t.Fatalf("login = %+v, %v", login, err)
	}
	if _, err := os.Stat(calls); err == nil {
		t.Fatal("read the keychain on Linux")
	}
}

func TestStoredLoginReadsTheCredentialsFileWhenTheKeychainHoldsNone(t *testing.T) {
	as(t, "darwin", "another item", tokens1)
	home := t.TempDir()
	write(t, filepath.Join(home, ".claude.json"), account)
	write(t, filepath.Join(home, ".claude", ".credentials.json"), strings.ReplaceAll(tokens1, "-1", "-file"))
	if login, err := StoredLogin(home); err != nil || login.AccessToken != "access-file" {
		t.Fatalf("login = %+v, %v, want the credentials file's", login, err)
	}
}

func TestClaudeConfigDirMovesTheFilesAndTheKeychainItem(t *testing.T) {
	dir := t.TempDir()
	digest := sha256.Sum256([]byte(dir))
	as(t, "darwin", "Claude Code-credentials-"+hex.EncodeToString(digest[:])[:8], tokens1)
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	write(t, filepath.Join(dir, ".claude.json"), account)
	if login, err := StoredLogin(t.TempDir()); err != nil || login.RefreshToken != "refresh-1" {
		t.Fatalf("login = %+v, %v, want the login in CLAUDE_CONFIG_DIR's keychain item", login, err)
	}
}

func TestStoredLoginSaysWhyThereIsNone(t *testing.T) {
	calls := as(t, "darwin", "Claude Code-credentials", `{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0}}`)
	home := t.TempDir()
	if _, err := StoredLogin(home); err == nil || err.Error() != "Claude Code is not logged in to a Claude account" {
		t.Fatalf("no account: %v", err)
	}
	if _, err := os.Stat(calls); err == nil {
		t.Fatal("read the keychain for a home with no Claude account")
	}
	write(t, filepath.Join(home, ".claude.json"), account)
	if _, err := StoredLogin(home); err == nil || err.Error() != "Claude Code is signed out in the keychain's Claude Code-credentials item" {
		t.Fatalf("signed out: %v", err)
	}
	as(t, "linux", "", "")
	if _, err := StoredLogin(home); err == nil || err.Error() != "Claude Code keeps no login in "+filepath.Join(home, ".claude", ".credentials.json") {
		t.Fatalf("no login: %v", err)
	}
}
