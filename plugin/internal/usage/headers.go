package usage

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/heyJordanParker/oneclaude/plugin/internal/model"
)

const (
	headerWeeklyUtilization = "Anthropic-Ratelimit-Unified-7d-Utilization"
	headerWeeklyReset       = "Anthropic-Ratelimit-Unified-7d-Reset"
	headerWeeklyStatus      = "Anthropic-Ratelimit-Unified-7d-Status"
	headerStatus            = "Anthropic-Ratelimit-Unified-Status"
	headerClaim             = "Anthropic-Ratelimit-Unified-Representative-Claim"
	unifiedPrefix           = "anthropic-ratelimit-unified-"
)

func lookup(h http.Header, name string) string {
	if v := strings.TrimSpace(h.Get(name)); v != "" {
		return v
	}
	for key, values := range h {
		if strings.EqualFold(key, name) && len(values) > 0 {
			return strings.TrimSpace(values[0])
		}
	}
	return ""
}

// HasUnified reports whether a reply carries Anthropic's usage headers. A 429
// without them is a throttle; one with them is a usage window refusing.
func HasUnified(h http.Header) bool {
	for key := range h {
		if strings.HasPrefix(strings.ToLower(key), unifiedPrefix) {
			return true
		}
	}
	return false
}

// WeeklyFromHeaders reads the all-models weekly window off a reply.
func WeeklyFromHeaders(h http.Header, now time.Time) (model.Weekly, bool) {
	raw := lookup(h, headerWeeklyUtilization)
	if raw == "" {
		return model.Weekly{}, false
	}
	used, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(used) || math.IsInf(used, 0) {
		return model.Weekly{}, false
	}
	w := model.Weekly{Used: math.Max(used, 0), ObservedAt: now}
	w.ResetsAt = parseReset(lookup(h, headerWeeklyReset), now)
	w.Rejected = strings.EqualFold(lookup(h, headerWeeklyStatus), "rejected")
	if !w.Rejected && strings.EqualFold(lookup(h, headerStatus), "rejected") && strings.EqualFold(lookup(h, headerClaim), "seven_day") {
		w.Rejected = true
	}
	return w, true
}

// QuotaRefused reports a 429 that a usage window produced.
func QuotaRefused(h http.Header) bool {
	return strings.EqualFold(lookup(h, headerStatus), "rejected")
}

func parseReset(raw string, now time.Time) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}
	}
	if secs, err := strconv.ParseFloat(raw, 64); err == nil && secs > 0 {
		if secs > 1e12 {
			secs /= 1000
		}
		return time.Unix(int64(secs), 0).UTC()
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UTC()
	}
	return time.Time{}
}

// WeeklyFromEndpoint reads /api/oauth/usage, which reports percentages.
func WeeklyFromEndpoint(body []byte, now time.Time) (model.Weekly, bool) {
	var p struct {
		SevenDay *struct {
			Utilization *float64 `json:"utilization"`
			ResetsAt    string   `json:"resets_at"`
		} `json:"seven_day"`
		Limits []struct {
			Kind     string   `json:"kind"`
			Percent  *float64 `json:"percent"`
			ResetsAt string   `json:"resets_at"`
		} `json:"limits"`
	}
	if json.Unmarshal(body, &p) != nil {
		return model.Weekly{}, false
	}
	if p.SevenDay != nil && p.SevenDay.Utilization != nil {
		return model.Weekly{Used: math.Max(*p.SevenDay.Utilization/100, 0), ResetsAt: parseReset(p.SevenDay.ResetsAt, now), ObservedAt: now}, true
	}
	for _, l := range p.Limits {
		if strings.EqualFold(l.Kind, "weekly_all") && l.Percent != nil {
			return model.Weekly{Used: math.Max(*l.Percent/100, 0), ResetsAt: parseReset(l.ResetsAt, now), ObservedAt: now}, true
		}
	}
	return model.Weekly{}, false
}

// WeeklyFromCodex reads ChatGPT's wham/usage, whose rate_limit holds a
// primary and a secondary window. The weekly one is whichever lasts a week.
func WeeklyFromCodex(body []byte, now time.Time) (model.Weekly, bool) {
	type window struct {
		UsedPercent  *float64 `json:"used_percent"`
		ResetAt      int64    `json:"reset_at"`
		WindowLength int64    `json:"limit_window_seconds"`
	}
	var p struct {
		RateLimit struct {
			Allowed      *bool   `json:"allowed"`
			LimitReached bool    `json:"limit_reached"`
			Primary      *window `json:"primary_window"`
			Secondary    *window `json:"secondary_window"`
		} `json:"rate_limit"`
	}
	if json.Unmarshal(body, &p) != nil {
		return model.Weekly{}, false
	}
	limit := p.RateLimit
	for _, w := range []*window{limit.Primary, limit.Secondary} {
		if w == nil || w.UsedPercent == nil || time.Duration(w.WindowLength)*time.Second != model.Week {
			continue
		}
		weekly := model.Weekly{Used: math.Max(*w.UsedPercent/100, 0), ObservedAt: now}
		if w.ResetAt > 0 {
			weekly.ResetsAt = time.Unix(w.ResetAt, 0).UTC()
		}
		weekly.Rejected = limit.LimitReached || (limit.Allowed != nil && !*limit.Allowed)
		return weekly, true
	}
	return model.Weekly{}, false
}

// PlanFromProfile reads organization.rate_limit_tier from /api/oauth/profile.
func PlanFromProfile(body []byte) string {
	var p struct {
		Organization struct {
			RateLimitTier string `json:"rate_limit_tier"`
		} `json:"organization"`
	}
	if json.Unmarshal(body, &p) != nil {
		return ""
	}
	return strings.TrimSpace(p.Organization.RateLimitTier)
}
