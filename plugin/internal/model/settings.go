package model

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Settings struct {
	Enabled      bool
	LimitsOn     bool
	SelfCorrect  bool
	Override     map[string]map[Family]int
	RetryAfter   time.Duration
	AffinityTTL  time.Duration
	PollInterval time.Duration
	DataDir      string
}

func Defaults() Settings {
	return Settings{
		Enabled:      true,
		LimitsOn:     true,
		SelfCorrect:  true,
		Override:     map[string]map[Family]int{},
		RetryAfter:   3 * time.Minute,
		AffinityTTL:  time.Hour,
		PollInterval: time.Hour,
		DataDir:      defaultDataDir(),
	}
}

func defaultDataDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".cli-proxy-api", "plugins", "oneclaude")
}

type rawSettings struct {
	Enabled bool `yaml:"enabled"`
	Limits  struct {
		Enabled     *bool                     `yaml:"enabled"`
		SelfCorrect *bool                     `yaml:"self-correct"`
		Override    map[string]map[string]int `yaml:"override"`
	} `yaml:"limits"`
	Subagents struct {
		RetryAfter string `yaml:"retry-after"`
	} `yaml:"subagents"`
	Affinity struct {
		TTL string `yaml:"ttl"`
	} `yaml:"affinity"`
	Quota struct {
		PollInterval string `yaml:"poll-interval"`
	} `yaml:"quota"`
	DataDir string `yaml:"data-dir"`
}

// ParseSettings reads the plugin's block. The Management Center writes each
// field as a top-level dotted key, which wins over the nested form.
func ParseSettings(raw []byte) (Settings, error) {
	s := Defaults()
	var tree map[string]any
	if err := yaml.Unmarshal(raw, &tree); err != nil {
		return s, fmt.Errorf("parse plugin config: %w", err)
	}
	expandDotted(tree)
	nested, err := yaml.Marshal(tree)
	if err != nil {
		return s, err
	}
	var r rawSettings
	if err := yaml.Unmarshal(nested, &r); err != nil {
		return s, fmt.Errorf("parse plugin config: %w", err)
	}
	s.Enabled = r.Enabled
	if r.Limits.Enabled != nil {
		s.LimitsOn = *r.Limits.Enabled
	}
	if r.Limits.SelfCorrect != nil {
		s.SelfCorrect = *r.Limits.SelfCorrect
	}
	for plan, families := range r.Limits.Override {
		s.Override[plan] = map[Family]int{}
		for f, n := range families {
			if n > 0 {
				s.Override[plan][Family(strings.ToLower(f))] = n
			}
		}
	}
	s.RetryAfter = duration(r.Subagents.RetryAfter, s.RetryAfter, time.Minute)
	s.AffinityTTL = duration(r.Affinity.TTL, s.AffinityTTL, time.Minute)
	s.PollInterval = duration(r.Quota.PollInterval, s.PollInterval, 10*time.Minute)
	if dir := strings.TrimSpace(r.DataDir); dir != "" {
		s.DataDir = expandHome(dir)
	}
	return s, nil
}

func duration(raw string, fallback, floor time.Duration) time.Duration {
	d, err := time.ParseDuration(strings.TrimSpace(raw))
	if err != nil || d < floor {
		return fallback
	}
	return d
}

func expandHome(path string) string {
	if !strings.HasPrefix(path, "~/") {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	return filepath.Join(home, path[2:])
}

func expandDotted(tree map[string]any) {
	for key, value := range tree {
		if !strings.Contains(key, ".") {
			continue
		}
		delete(tree, key)
		parts := strings.Split(key, ".")
		node := tree
		for _, part := range parts[:len(parts)-1] {
			next, ok := node[part].(map[string]any)
			if !ok {
				next = map[string]any{}
				node[part] = next
			}
			node = next
		}
		node[parts[len(parts)-1]] = value
	}
}
