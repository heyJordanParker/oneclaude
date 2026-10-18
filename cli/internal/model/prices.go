package model

import (
	"regexp"
	"strings"
)

// Tokens are one request's tokens by kind, as Anthropic counts them.
type Tokens struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
}

func (t *Tokens) Add(other Tokens) {
	t.Input += other.Input
	t.Output += other.Output
	t.CacheRead += other.CacheRead
	t.CacheWrite += other.CacheWrite
}

// Cost is what tokens cost on the API at list prices, in dollars, by kind.
type Cost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cache_read"`
	CacheWrite float64 `json:"cache_write"`
}

func (c *Cost) Add(other Cost) {
	c.Input += other.Input
	c.Output += other.Output
	c.CacheRead += other.CacheRead
	c.CacheWrite += other.CacheWrite
}

// Price is a model's list price in dollars per million tokens. Cache writes
// cost the 1-hour rate, the cache Claude Code writes. A model priced by
// prompt length pays Long on every request whose prompt is over LongAbove.
type Price struct {
	Input, Output, CacheRead, CacheWrite float64
	LongAbove                            int64
	Long                                 *Price
}

// prices are Anthropic's list prices, from
// platform.claude.com/docs/en/about-claude/pricing.
var prices = map[string]Price{
	"claude-fable-5-1":  {Input: 10, Output: 50, CacheRead: 0.25, CacheWrite: 20},
	"claude-mythos-5-1": {Input: 10, Output: 50, CacheRead: 0.25, CacheWrite: 20},
	"claude-fable-5":    {Input: 10, Output: 50, CacheRead: 1, CacheWrite: 20},
	"claude-mythos-5":   {Input: 10, Output: 50, CacheRead: 1, CacheWrite: 20},
	"claude-opus-5-5":   {Input: 4, Output: 20, CacheRead: 0.2, CacheWrite: 8},
	"claude-opus-5":     {Input: 5, Output: 25, CacheRead: 0.5, CacheWrite: 10},
	"claude-opus-4-8":   {Input: 5, Output: 25, CacheRead: 0.5, CacheWrite: 10},
	"claude-opus-4-7":   {Input: 5, Output: 25, CacheRead: 0.5, CacheWrite: 10},
	"claude-opus-4-6":   {Input: 5, Output: 25, CacheRead: 0.5, CacheWrite: 10},
	"claude-opus-4-5":   {Input: 5, Output: 25, CacheRead: 0.5, CacheWrite: 10},
	"claude-opus-4-1":   {Input: 15, Output: 75, CacheRead: 1.5, CacheWrite: 30},
	"claude-opus-4":     {Input: 15, Output: 75, CacheRead: 1.5, CacheWrite: 30},
	"claude-sonnet-5-5": {Input: 2, Output: 10, CacheRead: 0.1, CacheWrite: 4},
	"claude-sonnet-5":   {Input: 2, Output: 10, CacheRead: 0.2, CacheWrite: 4},
	"claude-sonnet-4-6": {Input: 3, Output: 15, CacheRead: 0.3, CacheWrite: 6},
	"claude-sonnet-4-5": {Input: 3, Output: 15, CacheRead: 0.3, CacheWrite: 6},
	"claude-sonnet-4":   {Input: 3, Output: 15, CacheRead: 0.3, CacheWrite: 6},
	"claude-haiku-5-5": {Input: 0.1, Output: 0.5, CacheRead: 0.01, CacheWrite: 0.2,
		LongAbove: 100_000, Long: &Price{Input: 0.5, Output: 2.5, CacheRead: 0.05, CacheWrite: 1}},
	"claude-haiku-4-5": {Input: 1, Output: 5, CacheRead: 0.1, CacheWrite: 2},
	"claude-3-5-haiku": {Input: 0.8, Output: 4, CacheRead: 0.08, CacheWrite: 1.6},
}

// newest is each family's newest model, which prices a request logged before
// the log recorded its model.
var newest = map[Family]string{
	Opus:   "claude-opus-5-5",
	Sonnet: "claude-sonnet-5-5",
	Haiku:  "claude-haiku-5-5",
	Fable:  "claude-fable-5-1",
}

var dated = regexp.MustCompile(`-\d{8}$`)

// Canonical is a model id as the price table names it: lowercase, without a
// date or a context-window suffix such as [1m].
func Canonical(modelID string) string {
	id := strings.ToLower(strings.TrimSpace(modelID))
	if cut, _, found := strings.Cut(id, "["); found {
		id = cut
	}
	return dated.ReplaceAllString(id, "")
}

// Label names a model as Anthropic does: claude-opus-5-5 is Opus 5.5, and
// claude-3-5-haiku is Haiku 3.5.
func Label(modelID string) string {
	var words, version []string
	for _, part := range strings.Split(strings.TrimPrefix(modelID, "claude-"), "-") {
		if part == "" {
			continue
		}
		if part[0] >= '0' && part[0] <= '9' {
			version = append(version, part)
		} else {
			words = append(words, strings.ToUpper(part[:1])+part[1:])
		}
	}
	return strings.TrimSpace(strings.Join(words, " ") + " " + strings.Join(version, "."))
}

// ModelOf is the model a request is counted under: its own, or its family's
// newest for a request logged without one.
func ModelOf(modelID string, family Family) string {
	if id := Canonical(modelID); id != "" {
		return id
	}
	return newest[family]
}

// CostOf prices one request's tokens. A model with no list price costs
// nothing.
func CostOf(modelID string, t Tokens) Cost {
	p, ok := prices[Canonical(modelID)]
	if !ok {
		return Cost{}
	}
	if p.Long != nil && t.Input+t.CacheRead+t.CacheWrite > p.LongAbove {
		p = *p.Long
	}
	const perMillion = 1e-6
	return Cost{
		Input:      float64(t.Input) * p.Input * perMillion,
		Output:     float64(t.Output) * p.Output * perMillion,
		CacheRead:  float64(t.CacheRead) * p.CacheRead * perMillion,
		CacheWrite: float64(t.CacheWrite) * p.CacheWrite * perMillion,
	}
}
