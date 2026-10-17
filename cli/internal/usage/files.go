package usage

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// WriteJSON replaces a file atomically, so a crash never leaves half a file.
func WriteJSON(path string, v any) error {
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func ReadJSON(path string, v any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, v)
}

func ReadSince(path string, since time.Time, fn func(line []byte)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	const chunk = 1 << 20
	var partial []byte
	for end := info.Size(); end > 0; {
		start := max(0, end-chunk)
		buf := make([]byte, end-start, end-start+int64(len(partial)))
		if _, err := f.ReadAt(buf, start); err != nil {
			return err
		}
		lines := bytes.Split(append(buf, partial...), []byte{'\n'})
		if start > 0 {
			partial, lines = lines[0], lines[1:]
		}
		for i := len(lines) - 1; i >= 0; i-- {
			var line struct {
				At time.Time `json:"at"`
			}
			if json.Unmarshal(lines[i], &line) != nil {
				continue
			}
			if line.At.Before(since) {
				return nil
			}
			fn(lines[i])
		}
		end = start
	}
	return nil
}

// Log appends one JSON line per request. Lines queue in memory and a single
// writer drains them, so a slow disk never holds a request.
type Log struct {
	path    string
	keep    time.Duration
	lines   chan []byte
	done    chan struct{}
	mu      sync.Mutex
	closed  bool
	written int
}

func NewLog(path string, keep time.Duration) *Log {
	l := &Log{path: path, keep: keep, lines: make(chan []byte, 4096), done: make(chan struct{})}
	go l.run()
	return l
}

func (l *Log) Append(v any) {
	raw, err := json.Marshal(v)
	if err != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return
	}
	select {
	case l.lines <- raw:
	default:
	}
}

func (l *Log) Close() {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	l.closed = true
	close(l.lines)
	l.mu.Unlock()
	select {
	case <-l.done:
	case <-time.After(2 * time.Second):
	}
}

func (l *Log) run() {
	defer close(l.done)
	defer func() { _ = recover() }()
	for line := range l.lines {
		l.write(line)
	}
}

func (l *Log) write(line []byte) {
	if l.path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
		return
	}
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_, _ = f.Write(append(line, '\n'))
	_ = f.Close()
	l.written++
	if l.written%5000 == 0 {
		l.prune()
	}
}

func (l *Log) prune() {
	f, err := os.Open(l.path)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-l.keep)
	var kept [][]byte
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		var line struct {
			At time.Time `json:"at"`
		}
		if json.Unmarshal(scanner.Bytes(), &line) == nil && line.At.Before(cutoff) {
			continue
		}
		kept = append(kept, append([]byte(nil), scanner.Bytes()...))
	}
	_ = f.Close()
	tmp := l.path + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return
	}
	for _, line := range kept {
		_, _ = out.Write(append(line, '\n'))
	}
	_ = out.Close()
	_ = os.Rename(tmp, l.path)
}
