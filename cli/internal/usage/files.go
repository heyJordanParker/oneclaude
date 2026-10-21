package usage

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
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

// ReadBack hands fn each line of a log, newest first, until fn returns false.
func ReadBack(path string, fn func(line []byte) bool) error {
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
			if len(lines[i]) > 0 && !fn(lines[i]) {
				return nil
			}
		}
		end = start
	}
	return nil
}

// Log appends one JSON line per request. Lines queue in memory and a single
// writer drains them, so a slow disk never holds a request. The writer also
// runs every rewrite of the file, so no rewrite loses a line appended
// meanwhile.
type Log struct {
	path    string
	keep    time.Duration
	lines   chan []byte
	edits   chan func()
	done    chan struct{}
	mu      sync.Mutex
	closed  bool
	written int
}

func NewLog(path string, keep time.Duration) *Log {
	l := &Log{path: path, keep: keep, lines: make(chan []byte, 4096), edits: make(chan func()), done: make(chan struct{})}
	go l.run()
	return l
}

// Rewrite passes every line of the log through edit and waits until the
// writer has replaced the file. An edit that returns nil drops its line.
func (l *Log) Rewrite(edit func(line []byte) []byte) {
	l.edit(func() bool { return l.rewrite("", edit) })
}

// Prepend puts the lines of the file at head before the log's oldest line,
// waits until the writer has replaced the file, and says whether it did.
func (l *Log) Prepend(head string) bool {
	return l.edit(func() bool { return l.rewrite(head, func(line []byte) []byte { return line }) })
}

// edit runs change on the writer and answers its result, or false once the
// log is closed.
func (l *Log) edit(change func() bool) bool {
	done := make(chan bool, 1)
	select {
	case l.edits <- func() { done <- change() }:
		return <-done
	case <-l.done:
		return false
	}
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
	for {
		select {
		case line, ok := <-l.lines:
			if !ok {
				return
			}
			l.write(line)
		case edit := <-l.edits:
			l.drain()
			edit()
		}
	}
}

// drain writes every line queued so far, so a rewrite sees each line
// appended before it.
func (l *Log) drain() {
	for {
		select {
		case line, ok := <-l.lines:
			if !ok {
				return
			}
			l.write(line)
		default:
			return
		}
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
	cutoff := time.Now().Add(-l.keep)
	l.rewrite("", func(raw []byte) []byte {
		var line struct {
			At time.Time `json:"at"`
		}
		if json.Unmarshal(raw, &line) == nil && line.At.Before(cutoff) {
			return nil
		}
		return raw
	})
}

// rewrite replaces the file with the file at head, if any, then each of its
// lines through edit, streaming both, so a long log never sits in memory. A
// missing log reads as empty. It says whether it replaced the file.
func (l *Log) rewrite(head string, edit func(line []byte) []byte) bool {
	if l.path == "" {
		return false
	}
	in, err := os.Open(l.path)
	if err != nil && (!os.IsNotExist(err) || head == "") {
		return false
	}
	if in != nil {
		defer in.Close()
	}
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
		return false
	}
	tmp := l.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return false
	}
	fail := func() bool {
		_ = f.Close()
		_ = os.Remove(tmp)
		return false
	}
	out := bufio.NewWriterSize(f, 1<<20)
	if head != "" {
		h, err := os.Open(head)
		if err != nil {
			return fail()
		}
		_, err = io.Copy(out, h)
		_ = h.Close()
		if err != nil {
			return fail()
		}
	}
	if in != nil {
		scanner := bufio.NewScanner(in)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			if line := edit(append([]byte(nil), scanner.Bytes()...)); line != nil {
				_, _ = out.Write(append(line, '\n'))
			}
		}
		if scanner.Err() != nil {
			return fail()
		}
	}
	if out.Flush() != nil || f.Close() != nil {
		_ = os.Remove(tmp)
		return false
	}
	return os.Rename(tmp, l.path) == nil
}
