package runtime

import (
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/heyJordanParker/oneclaude/cli/internal/usage"
)

// A sessionRecord is what a session's oneclaude mod tells the pool about it,
// from whichever machine it runs on: the folder it runs in, the type of each
// subagent it started, by agent id, and the filters its mods added, in order.
// Claude Code's requests name the session and the agent, but not the folder,
// nor a custom agent's type.
type sessionRecord struct {
	Session string            `json:"session"`
	Project string            `json:"project"`
	Agents  map[string]string `json:"agents,omitempty"`
	Filters []Filter          `json:"filters"`
}

const (
	recordsFolder = "sessions"
	// recordsKept is how long a session's record outlives its last change.
	recordsKept = 30 * 24 * time.Hour
)

var sessionName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// recordSet holds every session's record, each also in its own file in the
// data folder, so a reload of the plugin keeps them.
type recordSet struct {
	mu      sync.Mutex
	dir     string
	records map[string]sessionRecord
}

// load reads the records in dir, and deletes the ones of sessions that ended
// long ago.
func (s *recordSet) load(dir string, now time.Time) {
	records := map[string]sessionRecord{}
	folder := filepath.Join(dir, recordsFolder)
	entries, _ := os.ReadDir(folder)
	for _, entry := range entries {
		path := filepath.Join(folder, entry.Name())
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) > recordsKept {
			_ = os.Remove(path)
			continue
		}
		var r sessionRecord
		if usage.ReadJSON(path, &r) == nil && r.Session+".json" == entry.Name() {
			records[r.Session] = r
		}
	}
	s.mu.Lock()
	s.dir, s.records = dir, records
	s.mu.Unlock()
}

func (s *recordSet) of(sessionID string) sessionRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.records[sessionID]
}

// save keeps a session's record. The agents of its earlier record stay, as an
// agent's type never changes, so a mod that reloaded loses none.
func (s *recordSet) save(r sessionRecord) error {
	s.mu.Lock()
	if s.records == nil {
		s.records = map[string]sessionRecord{}
	}
	agents := maps.Clone(s.records[r.Session].Agents)
	if agents == nil {
		agents = map[string]string{}
	}
	maps.Copy(agents, r.Agents)
	r.Agents = agents
	s.records[r.Session] = r
	dir := s.dir
	s.mu.Unlock()
	if dir == "" {
		return nil
	}
	return usage.WriteJSON(filepath.Join(dir, recordsFolder, r.Session+".json"), r)
}

// sessionRoute keeps the record a session's mod sends. A filter must be an
// address on the pool's machine, so the route refuses any other, naming it.
// The proxy HTML-escapes the strings of a plugin's answer, so the errors hold
// no quote, ampersand or angle bracket.
func (p *Plugin) sessionRoute(body []byte) ManagementResponse {
	var r sessionRecord
	if json.Unmarshal(body, &r) != nil || !sessionName.MatchString(r.Session) {
		return jsonResponse(http.StatusBadRequest, map[string]string{"error": "a session record needs its session id"})
	}
	for _, f := range r.Filters {
		if f.Name == "" {
			return jsonResponse(http.StatusBadRequest, map[string]string{"error": "a filter needs the name of its mod"})
		}
		if !f.isLocal() {
			return jsonResponse(http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("the url of the %s filter must be an address on the machine the pool runs on, as http://127.0.0.1:4100/ or unix:/path/to/socket", f.Name)})
		}
	}
	if err := p.sessions.save(r); err != nil {
		return jsonResponse(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
	return jsonResponse(http.StatusOK, map[string]string{"status": "ok"})
}

// labelsOf are an agent's type and its session's project, the folder name it
// runs in, as Usage counts them. A main session's type is empty.
func (p *Plugin) labelsOf(sessionID, agentID, agentType string) (string, string) {
	r := p.sessions.of(sessionID)
	if agentID != "" && agentType == "" {
		agentType = r.Agents[agentID]
	}
	if r.Project == "" {
		return agentType, ""
	}
	return agentType, filepath.Base(r.Project)
}
