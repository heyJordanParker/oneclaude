// Package claudecode reads the Claude login Claude Code keeps. Claude Code is
// the only program that refreshes or writes that login: Anthropic's refresh
// tokens work once, so a second program refreshing it would leave Claude
// Code with a refused token, and Claude Code then signs itself out.
package claudecode

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"time"
)

// keychainItem is the keychain item Claude Code keeps its login in on macOS.
const keychainItem = "Claude Code-credentials"

// goos is the system Claude Code runs on, and security the program that reads
// the macOS keychain. Tests set both.
var (
	goos     = runtime.GOOS
	security = "/usr/bin/security"
)

// Login is the login Claude Code keeps: its account, from .claude.json, and
// its tokens.
type Login struct {
	Email            string
	Account          string
	Organization     string
	OrganizationName string
	AccessToken      string
	RefreshToken     string
	ExpiresAt        time.Time
}

// StoredLogin is the login Claude Code keeps for the person whose home folder
// is home, read where Claude Code reads it: its account from .claude.json, and
// its tokens from the keychain on macOS, or .credentials.json when the
// keychain holds none and on every other system. CLAUDE_CONFIG_DIR moves both
// files, and the keychain item, as it does for Claude Code. The account comes
// first, so a home with no Claude account never reads the keychain. Its
// error is a sentence that says why there is no login.
func StoredLogin(home string) (Login, error) {
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	state, folder := filepath.Join(home, ".claude.json"), filepath.Join(home, ".claude")
	if dir != "" {
		state, folder = filepath.Join(dir, ".claude.json"), dir
	}
	var config struct {
		Account struct {
			Email            string `json:"emailAddress"`
			Account          string `json:"accountUuid"`
			Organization     string `json:"organizationUuid"`
			OrganizationName string `json:"organizationName"`
		} `json:"oauthAccount"`
	}
	raw, err := os.ReadFile(state)
	if err != nil || json.Unmarshal(raw, &config) != nil || config.Account.Email == "" {
		return Login{}, errors.New("Claude Code is not logged in to a Claude account")
	}
	secret, kept, err := tokens(dir, folder)
	if err != nil {
		return Login{}, fmt.Errorf("Claude Code keeps no login in %s", kept)
	}
	var stored struct {
		OAuth struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
			ExpiresAt    int64  `json:"expiresAt"`
		} `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(secret, &stored); err != nil {
		return Login{}, fmt.Errorf("%s holds no Claude login oneclaude can read", kept)
	}
	if stored.OAuth.RefreshToken == "" {
		return Login{}, fmt.Errorf("Claude Code is signed out in %s", kept)
	}
	return Login{
		Email:            config.Account.Email,
		Account:          config.Account.Account,
		Organization:     config.Account.Organization,
		OrganizationName: config.Account.OrganizationName,
		AccessToken:      stored.OAuth.AccessToken,
		RefreshToken:     stored.OAuth.RefreshToken,
		ExpiresAt:        time.UnixMilli(stored.OAuth.ExpiresAt),
	}, nil
}

// tokens reads the tokens Claude Code keeps, and says where they are.
func tokens(dir, folder string) (secret []byte, kept string, err error) {
	file := filepath.Join(folder, ".credentials.json")
	if goos != "darwin" {
		secret, err = os.ReadFile(file)
		return secret, file, err
	}
	item := keychainItem
	if dir != "" {
		digest := sha256.Sum256([]byte(dir))
		item += "-" + hex.EncodeToString(digest[:])[:8]
	}
	secret, err = exec.Command(security, "find-generic-password", "-a", keychainAccount(), "-w", "-s", item).Output()
	if err == nil {
		return secret, "the keychain's " + item + " item", nil
	}
	if fallback, fileErr := os.ReadFile(file); fileErr == nil {
		return fallback, file, nil
	}
	return nil, "the keychain's " + item + " item", err
}

var accountName = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

// keychainAccount is the account Claude Code files its keychain item under:
// the user's name, or claude-code-user for a name the keychain can't take.
func keychainAccount() string {
	name := os.Getenv("USER")
	if name == "" {
		if current, err := user.Current(); err == nil {
			name = current.Username
		}
	}
	if !accountName.MatchString(name) {
		return "claude-code-user"
	}
	return name
}
