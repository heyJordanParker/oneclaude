package usage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestARewriteEditsEveryLineAndKeepsTheLinesAppendedAroundIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "requests.jsonl")
	log := NewLog(path, time.Hour)
	log.Append(map[string]string{"n": "1"})
	log.Append(map[string]string{"n": "drop"})
	log.Rewrite(func(line []byte) []byte {
		if strings.Contains(string(line), "drop") {
			return nil
		}
		return []byte(strings.ReplaceAll(string(line), `"1"`, `"one"`))
	})
	log.Append(map[string]string{"n": "2"})
	log.Close()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(raw); got != "{\"n\":\"one\"}\n{\"n\":\"2\"}\n" {
		t.Fatalf("log = %q", got)
	}
}
